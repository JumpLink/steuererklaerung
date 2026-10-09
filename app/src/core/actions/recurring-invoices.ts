/**
 * Recurring outgoing invoices — orchestration actions shared by the CLI, MCP and web UI.
 * Ties the schedule config (recurring-invoices.json) to the per-entity invoicing back-end and
 * the reminder dashboard. Nothing here auto-sends: `createRecurringInvoiceDraft` only creates a
 * DRAFT and advances the schedule; the human reviews and sends.
 */

import { shiftDate } from '@steuererklaerung/shared';
import type { InvoiceItemSpec } from '../clients/qonto/client-invoices.ts';
import {
    getRecurringInvoice,
    loadRecurringInvoices,
    type LastInvoice,
    type RecurringInvoice,
    saveRecurringInvoices,
} from '../config/index.ts';
import { findEntity, loadEntityInvoicing, loadManifest, loadProjects, resolveEntityElster } from '../config/index.ts';
import {
    advanceSchedule,
    computeRecurringInvoiceDashboard,
    type DashboardOptions,
    computeItemTotals,
    isActionable,
    type RecurringDueEntry,
} from '../invoices/recurring.ts';
import { type Addressing, buildHeaderWithWarnings, resolveAddressing } from '../invoices/header-template.ts';
import {
    type CreateInvoiceInput,
    type ListOutgoingInvoicesOptions,
    makeOutgoingInvoiceProvider,
    type OutgoingInvoiceDraft,
    type OutgoingInvoiceSummary,
} from '../invoices/provider.ts';
import { isRewrite, type ReconcileChange, reconcileLastInvoices } from '../invoices/reconcile.ts';
import { buildIcs, type IcsOptions } from '../invoices/reminders.ts';
import { draftInvoiceMail, mailSetupFor } from './send-invoice-email.ts';
import { requireInvoicingBackend } from '../invoices/backend-gate.ts';
import { ensureQontoClientForContact, getContactQontoClientId, resolveOrCreateContactForCustomer } from './contacts.ts';
import { resolveScheduleProject } from './projects.ts';

/** Default Rechnungsfuß: the Ist-Versteuerung notice (§ 20 UStG) for an entity taxed that way. */
export const DEFAULT_INVOICE_FOOTER = 'Es gilt die Besteuerung nach vereinnahmten Entgelten (§ 20 UStG).';

/** Today's date as YYYY-MM-DD (UTC) — single place so callers can override for tests. */
export function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

export interface DashboardActionOptions {
    /** Reference date (default: today). */
    today?: string;
    /** Restrict to a single entity. */
    entityId?: string;
    /** Override the per-schedule reminder window (days). */
    leadDays?: number;
    /** Only return actionable (overdue + due-soon) entries. */
    actionableOnly?: boolean;
    path?: string;
}

/** Load schedules and compute the reminder dashboard (sorted by urgency). */
export function recurringDashboard(opts: DashboardActionOptions = {}): RecurringDueEntry[] {
    const today = opts.today ?? todayIso();
    let invoices = loadRecurringInvoices(opts.path);
    if (opts.entityId) invoices = invoices.filter((i) => i.entityId === opts.entityId);
    const dash: DashboardOptions = { today, leadDaysOverride: opts.leadDays };
    const entries = computeRecurringInvoiceDashboard(invoices, dash);
    return opts.actionableOnly ? entries.filter(isActionable) : entries;
}

/** Map a schedule's camelCase items to the Qonto-style friendly InvoiceItemSpec. */
function toItemSpecs(inv: RecurringInvoice): InvoiceItemSpec[] {
    return inv.items.map((it) => ({
        title: it.title,
        ...(it.description ? { description: it.description } : {}),
        quantity: it.quantity,
        ...(it.unit ? { unit: it.unit } : {}),
        unit_price: it.unitPrice,
        vat_rate: it.vatRate,
    }));
}

export interface BuildInputOptions {
    today?: string;
    path?: string;
}

/**
 * Build the provider-agnostic create input for one schedule. Pure apart from reading the entity
 * invoicing config + env IBAN; exported so the CLI can `--dry-run` print it without any network.
 */
export function buildCreateInput(
    inv: RecurringInvoice,
    opts: BuildInputOptions = {},
): {
    input: CreateInvoiceInput;
    providerType: 'qonto' | 'self';
    headerWarnings: string[];
    /** Greeting and form of address the cover letter used, and where the greeting came from. */
    addressing: Addressing;
} {
    const view = requireInvoicingBackend(inv.entityId, opts.path);
    const issueDate = opts.today ?? todayIso();
    const termDays = inv.paymentTermsDays ?? view.paymentTermsDays ?? 15;
    const iban = view.iban ?? process.env.QONTO_IBAN ?? process.env.BILLING_IBAN ?? '';
    // Prefer an already-resolved client id: explicit legacy field, else the contact's Qonto link.
    const clientId =
        inv.customer.qontoClientId ??
        (inv.customer.contactId ? getContactQontoClientId(inv.customer.contactId) : undefined);
    // Throws on a broken link (unknown project, other customer) instead of rendering a stranger's greeting.
    const project = inv.projectId ? resolveScheduleProject(inv, loadProjects(inv.entityId, opts.path)) : undefined;
    const rendered = buildHeaderWithWarnings(
        inv,
        {
            defaultHeader: view.defaultHeader,
            defaultClosing: view.defaultClosing,
            defaultHeaderSie: view.defaultHeaderSie,
            defaultClosingSie: view.defaultClosingSie,
            issuerName: issuerNameFor(inv.entityId, opts.path),
        },
        project,
    );
    const header = rendered?.text;
    return {
        providerType: view.type,
        headerWarnings: rendered?.warnings ?? [],
        addressing: resolveAddressing(inv, project),
        input: {
            clientId,
            issueDate,
            dueDate: shiftDate(issueDate, termDays),
            currency: inv.currency,
            iban,
            performanceStart: inv.nextPeriod.start,
            performanceEnd: inv.nextPeriod.end,
            ...(header ? { header } : {}),
            footer: DEFAULT_INVOICE_FOOTER,
            items: toItemSpecs(inv),
        },
    };
}

export interface CreateRecurringResult {
    id: string;
    dryRun: boolean;
    input: CreateInvoiceInput;
    providerType: 'qonto' | 'self';
    /** Hints about the rendered cover letter, e.g. `greeting fehlt`. */
    headerWarnings: string[];
    /** Greeting and form of address of the cover letter, with where the greeting came from. */
    addressing: Addressing;
    /** The created draft (absent on a dry run). */
    draft?: OutgoingInvoiceDraft;
    /** The schedule after advancement (absent on a dry run). */
    advanced?: RecurringInvoice;
}

export interface CreateRecurringOptions {
    today?: string;
    dryRun?: boolean;
    path?: string;
    /** Advance the schedule (record lastInvoice + roll the period forward). Default true. */
    advance?: boolean;
}

/**
 * Create a DRAFT invoice for one recurring schedule via its entity's back-end, then advance the
 * schedule. On `dryRun` it returns the prepared input without any API call or file write.
 */
export async function createRecurringInvoiceDraft(
    id: string,
    opts: CreateRecurringOptions = {},
): Promise<CreateRecurringResult> {
    const inv = getRecurringInvoice(id, opts.path);
    const { input, providerType, headerWarnings, addressing } = buildCreateInput(inv, {
        today: opts.today,
        path: opts.path,
    });

    if (opts.dryRun) {
        return { id, dryRun: true, input, providerType, headerWarnings, addressing };
    }

    // Qonto back-end without a resolved client id → resolve/create the contact and ensure a Qonto
    // client for it (create-on-demand), then bill that client. Closes the "qontoClientId fehlt" gap.
    let resolvedContactId = inv.customer.contactId;
    if (providerType === 'qonto' && !input.clientId) {
        const contact = resolveOrCreateContactForCustomer(inv.entityId, inv.customer);
        resolvedContactId = contact.id;
        const ensured = await ensureQontoClientForContact(contact.id);
        input.clientId = ensured.clientId;
    } else if (providerType === 'self' && !input.contactId) {
        // Self back-end bills from the contact master (no Qonto client needed).
        const contact = resolveOrCreateContactForCustomer(inv.entityId, inv.customer);
        resolvedContactId = contact.id;
        input.contactId = contact.id;
    }

    const provider = makeOutgoingInvoiceProvider({ type: providerType }, { entityId: inv.entityId, path: opts.path });
    const draft = await provider.createDraft(input);

    let advanced: RecurringInvoice | undefined;
    if (opts.advance !== false) {
        const issued: LastInvoice = {
            ...(draft.number ? { number: draft.number } : {}),
            issueDate: input.issueDate,
            period: inv.nextPeriod,
            providerId: draft.id,
            ...(draft.url ? { url: draft.url } : {}),
        };
        advanced = advanceSchedule(inv, issued);
        // Persist the resolved contact + Qonto client backlink so the next run is direct.
        if (providerType === 'qonto') {
            advanced = {
                ...advanced,
                customer: {
                    ...advanced.customer,
                    ...(resolvedContactId ? { contactId: resolvedContactId } : {}),
                    ...(input.clientId ? { qontoClientId: input.clientId } : {}),
                },
            };
        }
        const all = loadRecurringInvoices(opts.path).map((i) => (i.id === id ? advanced! : i));
        saveRecurringInvoices(all, opts.path);
    }

    return { id, dryRun: false, input, providerType, headerWarnings, addressing, draft, advanced };
}

export interface ListOutgoingInvoicesActionOptions extends ListOutgoingInvoicesOptions {
    /** Which entity's invoicing back-end to list (drives qonto vs. self). */
    entityId: string;
    path?: string;
}

/**
 * List the already-issued outgoing invoices for an entity via its configured back-end (Qonto
 * today, self later). The provider already resolves each customer name from the invoice's embedded
 * client object; the recurring-schedule qontoClientId→name map here is only a fallback for the rare
 * row whose name the back-end didn't carry.
 */
export async function listOutgoingInvoices(opts: ListOutgoingInvoicesActionOptions): Promise<OutgoingInvoiceSummary[]> {
    const view = requireInvoicingBackend(opts.entityId, opts.path);
    const provider = makeOutgoingInvoiceProvider({ type: view.type }, { entityId: opts.entityId, path: opts.path });
    const summaries = await provider.listInvoices(opts.status ? { status: opts.status } : {});

    const nameByClientId = new Map<string, string>();
    for (const inv of loadRecurringInvoices(opts.path)) {
        const cid = inv.customer.qontoClientId;
        if (cid && inv.customer.name) nameByClientId.set(cid, inv.customer.name);
    }
    return summaries.map((s) => ({
        ...s,
        customerName: s.customerName ?? (s.clientId ? (nameByClientId.get(s.clientId) ?? null) : null),
    }));
}

export interface ReconcileRecurringOptions {
    /** Entity whose schedules to reconcile. */
    entityId: string;
    /** Report what would change, write nothing. */
    dryRun?: boolean;
    /** The back-end's invoice list, when the caller already fetched it (saves a second request). */
    invoices?: OutgoingInvoiceSummary[];
    path?: string;
}

export interface ReconcileRecurringResult {
    entityId: string;
    dryRun: boolean;
    changes: ReconcileChange[];
    /** Whether any schedule was rewritten (and, unless dry run, saved). */
    rewritten: boolean;
}

/**
 * Bring each schedule's `lastInvoice` in line with its invoice in the back-end: the final number
 * after finalizing, the replacement after a cancellation. Only `lastInvoice` is touched, never the
 * period or the due date, and nothing is created or sent.
 */
export async function reconcileRecurringInvoices(opts: ReconcileRecurringOptions): Promise<ReconcileRecurringResult> {
    const dryRun = opts.dryRun === true;
    // Nothing recorded to follow → no request to the back-end.
    if (!loadRecurringInvoices(opts.path).some((i) => i.entityId === opts.entityId && i.lastInvoice?.providerId)) {
        return { entityId: opts.entityId, dryRun, changes: [], rewritten: false };
    }
    const invoices = opts.invoices ?? (await listOutgoingInvoices({ entityId: opts.entityId, path: opts.path }));
    // Read AFTER the request: the schedules may have been edited while it was in flight, and the
    // write below replaces the whole list.
    const all = loadRecurringInvoices(opts.path);
    const mine = all.filter((i) => i.entityId === opts.entityId);
    const { schedules, changes } = reconcileLastInvoices(mine, invoices);
    const rewritten = changes.some(isRewrite);
    if (rewritten && !dryRun) {
        const byId = new Map(schedules.map((i) => [i.id, i]));
        saveRecurringInvoices(
            all.map((i) => (i.entityId === opts.entityId ? (byId.get(i.id) ?? i) : i)),
            opts.path,
        );
    }
    return { entityId: opts.entityId, dryRun, changes, rewritten };
}

/**
 * Render a subscribable iCalendar feed of reminders for all ACTIVE schedules (overdue, due-soon
 * and upcoming), each alarmed `reminderLeadDays` ahead. Subscribe to the written file in GNOME
 * Calendar / a phone for active push notifications.
 */
export function recurringIcs(opts: DashboardActionOptions & IcsOptions = {}): string {
    const today = opts.today ?? todayIso();
    let invoices = loadRecurringInvoices(opts.path);
    if (opts.entityId) invoices = invoices.filter((i) => i.entityId === opts.entityId);
    const leadById = new Map(invoices.map((i) => [i.id, i.reminderLeadDays]));
    const entries = computeRecurringInvoiceDashboard(invoices, { today, leadDaysOverride: opts.leadDays })
        .filter((e) => e.status !== 'paused' && e.status !== 'cancelled')
        .map((e) => ({ ...e, leadDays: leadById.get(e.id) }));
    return buildIcs(entries, { stamp: opts.stamp ?? today, calendarName: opts.calendarName });
}

/** The mail draft for one schedule's invoice, plus which invoice that is. */
export interface RecurringEmailDraft {
    to: string | null;
    subject: string;
    body: string;
    /** The invoice the text is about: the one issued last, not the one that is due next. */
    invoice: { number: string; issueDate: string; period: { start: string; end: string } | null };
    /** Placeholders nothing fills; the person must fix the template before sending. */
    unknownPlaceholders: string[];
    /** Required values (invoice number, amount, …) that are empty; they stay empty in the text. */
    missingValues: string[];
    /** The template the text came from (`standard` = built-in). */
    templateId: string;
}

/**
 * The mail that carries a schedule's most recently ISSUED invoice (review + send manually).
 *
 * Not `nextPeriod`: creating an invoice advances the schedule, so `nextPeriod` is the period of the
 * invoice that does not exist yet, and a mail needs an invoice (number, amount, due date, pay link).
 * The text comes from the same {@link draftInvoiceMail} path as the desktop dialog, so salutation
 * (project contact person → contract), sign-off and wording are identical. The amount is the
 * schedule's current items; the due date is the issue date plus the payment term.
 */
export function recurringEmail(id: string, path?: string, templateId?: string): RecurringEmailDraft {
    const inv = getRecurringInvoice(id, path);
    const last = inv.lastInvoice;
    if (!last) {
        throw new Error(
            `Zu "${id}" gibt es noch keine ausgestellte Rechnung. Erst erstellen: steuer invoices recurring create ${id}`,
        );
    }
    // A broken project link throws here instead of drafting a stranger's greeting.
    if (inv.projectId) resolveScheduleProject(inv, loadProjects(inv.entityId, path));
    const entityName = findEntity(loadManifest(path), inv.entityId)?.name ?? inv.entityId;
    const setup = mailSetupFor(inv.entityId, inv, null, issuerNameFor(inv.entityId, path) ?? entityName, path);
    const termDays = inv.paymentTermsDays ?? loadEntityInvoicing(inv.entityId, path).paymentTermsDays ?? 15;
    const totals = computeItemTotals(inv.items);
    const chosen = templateId ?? setup.templateId;
    const draft = draftInvoiceMail(
        setup,
        {
            number: last.number ?? '',
            total: totals.gross,
            net: totals.net,
            issueDate: last.issueDate,
            period: last.period ?? null,
            dueDate: shiftDate(last.issueDate, termDays),
            url: last.url,
        },
        chosen,
    );
    return {
        to: setup.recipient || null,
        subject: draft.subject,
        body: draft.text,
        invoice: { number: last.number ?? '', issueDate: last.issueDate, period: last.period ?? null },
        unknownPlaceholders: draft.unknown,
        missingValues: draft.missing,
        templateId: chosen,
    };
}

/**
 * Who signs for an entity: the configured invoice issuer, else the ELSTER Betrieb name. Shared by the
 * cover email and the invoice cover letter (`{aussteller}`) so both are signed identically.
 */
export function issuerNameFor(entityId: string, path?: string): string | undefined {
    const issuer = loadEntityInvoicing(entityId, path).selfIssuer;
    const issuerName = issuer?.signature?.trim() || issuer?.name?.trim();
    return issuerName || resolveEntityElster(entityId, path)?.betrieb?.name?.trim() || undefined;
}
