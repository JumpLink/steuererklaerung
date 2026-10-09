/**
 * One-off outgoing (customer) invoices — provider-agnostic orchestration shared by the CLI, MCP
 * and web UI. Mirrors the recurring layer (see createRecurringInvoiceDraft): it routes through the
 * per-entity invoicing back-end (`makeOutgoingInvoiceProvider`) instead of calling Qonto directly,
 * so an entity configured `invoicing.type = "self"` uses the self back-end exactly like the DMS
 * provider switch. Nothing here auto-sends — only a DRAFT is created for human review.
 */

import { shiftDate } from '@steuererklaerung/shared';
import {
    type CreateClientBody,
    findClientByName,
    findOrCreateClient,
    type InvoiceSpec,
} from '../clients/qonto/index.ts';
import type { EntityInvoicingView } from '../config/index.ts';
import {
    checkTimeBeforeFinalize,
    releaseTimeOfDraft,
    reserveTimeForDraft,
    settleTimeOnFinalize,
} from './time-invoice.ts';
import { clearRechnungProjekt, setRechnungProjekt } from './rechnung-projekt.ts';
import { requireInvoicingBackend } from '../invoices/backend-gate.ts';
import {
    type CreateInvoiceInput,
    type InvoiceCapabilities,
    makeOutgoingInvoiceProvider,
    type OutgoingInvoiceDetail,
    type OutgoingInvoiceDraft,
    type OutgoingInvoiceFile,
    type OutgoingInvoiceProvider,
    type OutgoingInvoiceSummary,
} from '../invoices/provider.ts';

/** Display name from a friendly customer spec (company name, else "First Last"). */
function clientBodyName(body: CreateClientBody): string {
    return (body.name ?? [body.first_name, body.last_name].filter(Boolean).join(' ')).trim();
}

/**
 * Map a friendly {@link InvoiceSpec} (the JSON spec file / MCP shape) to the provider-agnostic
 * {@link CreateInvoiceInput}, resolving the payment IBAN, payment term and due date from the
 * entity's invoicing config (then the QONTO_IBAN / BILLING_IBAN env fallback). Pure apart from the
 * env read, so the CLI/MCP can `--dry-run`-print it without any network call.
 */
export function buildOneOffCreateInput(invoice: InvoiceSpec, view: EntityInvoicingView): CreateInvoiceInput {
    const currency = invoice.currency ?? 'EUR';
    const termDays = invoice.payment_terms_days ?? view.paymentTermsDays ?? 15;
    const dueDate = invoice.due_date ?? shiftDate(invoice.issue_date, termDays);
    const iban = invoice.iban || view.iban || process.env.QONTO_IBAN || process.env.BILLING_IBAN || '';
    return {
        issueDate: invoice.issue_date,
        dueDate,
        currency,
        iban,
        ...(invoice.status ? { status: invoice.status } : {}),
        ...(invoice.number ? { number: invoice.number } : {}),
        ...(invoice.header ? { header: invoice.header } : {}),
        ...(invoice.footer ? { footer: invoice.footer } : {}),
        ...(invoice.terms_and_conditions ? { termsAndConditions: invoice.terms_and_conditions } : {}),
        ...(invoice.performance_start_date ? { performanceStart: invoice.performance_start_date } : {}),
        ...(invoice.performance_end_date ? { performanceEnd: invoice.performance_end_date } : {}),
        items: invoice.items,
    };
}

/** Provider-agnostic input for a single one-off invoice (the JSON spec file / MCP payload). */
export interface CreateOutgoingInvoiceInput {
    /** Entity whose invoicing back-end applies; omitted ⇒ the default (Qonto) config. */
    entityId?: string;
    /** Friendly customer spec — used to find-or-create the customer for the Qonto back-end. */
    client: CreateClientBody;
    /** Friendly invoice spec (items, dates, optional IBAN/header/footer/…). */
    invoice: InvoiceSpec;
    /** Resolve the customer read-only and return the prepared payload without creating anything. */
    dryRun?: boolean;
}

export interface CreateOutgoingOptions {
    /** Override the workspace manifest path (tests). */
    path?: string;
}

/** A resolved/previewed customer for the Qonto back-end (absent for the self back-end). */
export interface OutgoingInvoiceClientRef {
    /** Whether the customer was reused (found) or will be / was created. */
    action: 'reuse' | 'create';
    /** Qonto client id (absent when a dry-run would create the customer on the real run). */
    id?: string;
    name: string;
}

export interface CreateOutgoingResult {
    dryRun: boolean;
    providerType: 'qonto' | 'self';
    /** Back-end display name (e.g. "Qonto"). */
    provider: string;
    /** Resolved/previewed customer (Qonto back-end only). */
    client?: OutgoingInvoiceClientRef;
    /** The provider-agnostic input that was built (transparency + dry-run preview). */
    input: CreateInvoiceInput;
    /** Content-validation problems (dry-run reports them; a live run throws before creating). */
    problems: string[];
    /** The created draft (absent on a dry run). */
    draft?: OutgoingInvoiceDraft;
}

/**
 * Create a DRAFT outgoing invoice for one entity via its configured back-end, finding-or-creating
 * the Qonto customer by name first. On `dryRun` it resolves the customer read-only and returns the
 * prepared payload + any validation problems without an API call. A live run validates the invoice
 * content BEFORE touching the customer (so a malformed invoice never leaves an orphan Qonto client).
 */
export async function createOutgoingInvoiceDraft(
    input: CreateOutgoingInvoiceInput,
    opts: CreateOutgoingOptions = {},
): Promise<CreateOutgoingResult> {
    const view = requireInvoicingBackend(input.entityId ?? '', opts.path);
    const provider = makeOutgoingInvoiceProvider({ type: view.type }, { entityId: input.entityId, path: opts.path });
    const cinput = buildOneOffCreateInput(input.invoice, view);
    const name = clientBodyName(input.client);

    if (input.dryRun) {
        let client: OutgoingInvoiceClientRef | undefined;
        if (provider.type === 'qonto') {
            const existing = name ? await findClientByName(name) : undefined;
            cinput.clientId = existing?.id ?? '<<resolved-on-create>>';
            client = existing ? { action: 'reuse', id: existing.id, name } : { action: 'create', name };
        }
        return {
            dryRun: true,
            providerType: provider.type,
            provider: provider.name,
            client,
            input: cinput,
            problems: provider.validate(cinput),
        };
    }

    // Validate the invoice content first — before any customer is created on the back-end.
    const problems = provider.validate(cinput);
    if (problems.length) {
        throw new Error(`Rechnung ungültig:\n- ${problems.join('\n- ')}`);
    }

    let client: OutgoingInvoiceClientRef | undefined;
    if (provider.type === 'qonto') {
        const resolved = await findOrCreateClient(input.client);
        cinput.clientId = resolved.client.id;
        client = { action: resolved.created ? 'create' : 'reuse', id: resolved.client.id, name };
    }

    const draft = await provider.createDraft(cinput);
    return {
        dryRun: false,
        providerType: provider.type,
        provider: provider.name,
        client,
        input: cinput,
        problems: [],
        draft,
    };
}

// ── Lifecycle actions (shared by CLI, MCP and both UIs) ──────────────────────────────
// All go through the per-entity provider; each throws a uniform message when the back-end
// lacks the capability, so callers/UIs can rely on capabilities to gate the action.

/** Build the invoicing provider for an entity. */
function providerFor(entityId: string, path?: string): OutgoingInvoiceProvider {
    const view = requireInvoicingBackend(entityId, path);
    return makeOutgoingInvoiceProvider({ type: view.type }, { entityId, path });
}

/** The provider's capabilities + display info (sync, no I/O) — the UIs render actions from this. */
export function getInvoiceCapabilities(
    entityId: string,
    path?: string,
): { providerType: 'qonto' | 'self'; providerName: string; capabilities: InvoiceCapabilities } {
    const provider = providerFor(entityId, path);
    return { providerType: provider.type, providerName: provider.name, capabilities: provider.capabilities };
}

function unsupported(provider: OutgoingInvoiceProvider, what: string): Error {
    return new Error(`Provider „${provider.name}" unterstützt ${what} nicht.`);
}

/** List issued invoices for an entity (newest first). */
export async function listOutgoingInvoicesFor(
    entityId: string,
    opts: { status?: string; path?: string } = {},
): Promise<OutgoingInvoiceSummary[]> {
    return providerFor(entityId, opts.path).listInvoices(opts.status ? { status: opts.status } : {});
}

/** Full detail for one invoice, or null. */
export async function getOutgoingInvoice(
    entityId: string,
    id: string,
    path?: string,
): Promise<OutgoingInvoiceDetail | null> {
    const provider = providerFor(entityId, path);
    if (!provider.getInvoice) throw unsupported(provider, 'die Detailansicht');
    return provider.getInvoice(id);
}

/** Project and time entries a draft is saved with (self back-end for the time entries). */
export interface DraftLinks {
    /** Assign the invoice to this project; null clears the assignment, undefined leaves it. */
    projectId?: string | null;
    /** Open time entries the draft reserves; they are billed only when the invoice is finalized. */
    timeEntryIds?: readonly string[];
}

/** Create or (when `id` given) update a DRAFT invoice; optionally assign a project and reserve time entries. */
export async function saveOutgoingInvoiceDraft(
    entityId: string,
    input: CreateInvoiceInput,
    id?: string,
    path?: string,
    links: DraftLinks = {},
): Promise<OutgoingInvoiceDraft> {
    const provider = providerFor(entityId, path);
    if (links.timeEntryIds?.length && provider.type !== 'self') {
        throw new Error(
            'Zeiten als Positionen gehen nur mit der eigenen Rechnungserstellung (Qonto kann keine Entwürfe bearbeiten).',
        );
    }
    let draft: OutgoingInvoiceDraft;
    if (id) {
        if (!provider.updateDraft) throw unsupported(provider, 'das Bearbeiten von Entwürfen');
        draft = await provider.updateDraft(id, input);
    } else {
        draft = await provider.createDraft(input);
    }
    try {
        if (links.timeEntryIds) reserveTimeForDraft(entityId, draft.id, links.timeEntryIds);
        if (links.projectId !== undefined) {
            if (links.projectId === null) clearRechnungProjekt(entityId, draft.id);
            else setRechnungProjekt(entityId, draft.id, links.projectId);
        }
    } catch (err) {
        if (!id) await provider.deleteDraft?.(draft.id).catch(() => undefined);
        throw err;
    }
    return draft;
}

/** Delete a DRAFT invoice; its reserved time entries stay open. */
export async function deleteOutgoingInvoiceDraft(entityId: string, id: string, path?: string): Promise<void> {
    const provider = providerFor(entityId, path);
    if (!provider.deleteDraft) throw unsupported(provider, 'das Löschen von Entwürfen');
    await provider.deleteDraft(id);
    releaseTimeOfDraft(entityId, id);
    clearRechnungProjekt(entityId, id);
}

/**
 * Festschreiben: assign the number, freeze, render + archive. Irreversible. The time entries the draft
 * reserved become billed here and only here — checked first, so a finalize never leaves hours on two invoices.
 */
export async function finalizeOutgoingInvoice(
    entityId: string,
    id: string,
    path?: string,
): Promise<OutgoingInvoiceSummary> {
    const provider = providerFor(entityId, path);
    if (!provider.finalize) throw unsupported(provider, 'das Festschreiben');
    checkTimeBeforeFinalize(entityId, id);
    const summary = await provider.finalize(id);
    settleTimeOnFinalize(entityId, id);
    return summary;
}

/** Mark an open invoice paid (optionally linking the settling transaction). */
export async function markOutgoingInvoicePaid(
    entityId: string,
    id: string,
    opts: { txId?: string; paidAt?: string; path?: string } = {},
): Promise<OutgoingInvoiceSummary> {
    const provider = providerFor(entityId, opts.path);
    if (!provider.markPaid) throw unsupported(provider, 'die Zahlungsmarkierung');
    return provider.markPaid(id, { txId: opts.txId, paidAt: opts.paidAt });
}

/** Cancel an invoice via a storno counter-invoice. */
export async function cancelOutgoingInvoice(
    entityId: string,
    id: string,
    opts: { reason?: string; path?: string } = {},
): Promise<{ storno: OutgoingInvoiceSummary; original: OutgoingInvoiceSummary }> {
    const provider = providerFor(entityId, opts.path);
    if (!provider.cancel) throw unsupported(provider, 'das Stornieren');
    return provider.cancel(id, { reason: opts.reason });
}

/** The invoice PDF: rendered bytes (self) or a hosted URL (Qonto). */
export async function getOutgoingInvoicePdf(
    entityId: string,
    id: string,
    path?: string,
): Promise<OutgoingInvoiceFile | null> {
    const provider = providerFor(entityId, path);
    if (!provider.getPdf) throw unsupported(provider, 'den PDF-Abruf');
    return provider.getPdf(id);
}

/**
 * The invoice PDF as bytes for a mail attachment: downloaded for Qonto (whose getPdf is only a URL),
 * the rendered bytes for self.
 */
export async function getOutgoingInvoicePdfBytes(
    entityId: string,
    id: string,
    path?: string,
): Promise<OutgoingInvoiceFile | null> {
    const provider = providerFor(entityId, path);
    if (provider.downloadPdf) return provider.downloadPdf(id);
    return getOutgoingInvoicePdf(entityId, id, path);
}

/** The invoice XRechnung XML bytes (self only). */
export async function getOutgoingInvoiceXml(
    entityId: string,
    id: string,
    path?: string,
): Promise<OutgoingInvoiceFile | null> {
    const provider = providerFor(entityId, path);
    if (!provider.getXml) throw unsupported(provider, 'den XRechnung-Export');
    return provider.getXml(id);
}
