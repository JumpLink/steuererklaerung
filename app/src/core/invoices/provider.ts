/**
 * Pluggable back-end for creating OUTGOING (customer) invoices — selected per entity exactly
 * like the DMS provider (see makeDmsProvider in web/server.ts). `qonto` drafts the invoice via
 * the Qonto client-invoices API for human review/send; `self` generates it locally (phase 2).
 *
 * The recurrence + reminder layer is provider-agnostic; only the final "create" step differs.
 */

import {
    buildClientInvoiceBody,
    createClientInvoice,
    getClientInvoice,
    type InvoiceItemSpec,
    listClientInvoices,
    normalizeAmount,
    normalizeVatRate,
} from '../clients/qonto/client-invoices.ts';
import { downloadAttachmentContent, getAttachment } from '../clients/qonto/attachments.ts';
import type { ClientInvoice } from '../clients/qonto/types.ts';
import type { EntityInvoicingConfig } from '../config/index.ts';
import { requireInvoicingBackend } from './backend-gate.ts';
import { buildSelfProvider } from './self-provider.ts';

/** A created invoice as returned by any back-end (after a draft/create call). */
export interface OutgoingInvoiceDraft {
    /** Back-end record id (Qonto client_invoice id, or a local id for the self provider). */
    id: string;
    /** Human invoice number, if the back-end assigned one. */
    number: string | null;
    /** Lifecycle status, e.g. "draft". */
    status: string;
    /** Hosted PDF / review URL (Qonto invoice_url), if any. */
    url: string | null;
    provider: 'qonto' | 'self';
}

/** Provider-agnostic input for creating one invoice from a recurring schedule. */
export interface CreateInvoiceInput {
    /** Resolved Qonto client id to bill (required by the Qonto back-end). */
    clientId?: string;
    /** Contact-master id to bill (the self back-end resolves the §14 recipient from it). */
    contactId?: string;
    /** Explicit §14 recipient block (self back-end); normally resolved from `contactId`. */
    recipient?: OutgoingInvoiceRecipient;
    issueDate: string;
    dueDate: string;
    currency: string;
    /** Own IBAN the customer pays to (Qonto requires it on every invoice). */
    iban: string;
    /** Leistungszeitraum — printed on the invoice and used for §14 UStG compliance. */
    performanceStart?: string;
    performanceEnd?: string;
    /** BT-10 Leitweg-ID / buyer reference (self back-end; mostly public-sector). */
    buyerReference?: string;
    /** Explicit invoice number (only when automatic numbering is disabled). */
    number?: string;
    /** Lifecycle to create in: "draft" (default — editable, not sent) or "unpaid" (finalized). */
    status?: 'draft' | 'unpaid';
    header?: string;
    footer?: string;
    /** Zahlungsbedingungen / AGB text printed on the invoice. */
    termsAndConditions?: string;
    items: InvoiceItemSpec[];
}

/** §14 recipient block for the self back-end (superset of what a Qonto client carries). */
export interface OutgoingInvoiceRecipient {
    name: string;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    countryCode?: string | null;
    vatNumber?: string | null;
    email?: string | null;
}

/** A provider-agnostic summary of an already-issued outgoing invoice (for listings). */
export interface OutgoingInvoiceSummary {
    /** Back-end record id (Qonto client_invoice id, or a local id for the self provider). */
    id: string;
    /** Human invoice number, if assigned (null for an unnumbered draft). */
    number: string | null;
    /** Lifecycle status as the back-end reports it (draft, unpaid, paid, canceled, …). */
    status: string;
    /** Back-end customer id (Qonto client_id) — used to resolve a display name. */
    clientId: string | null;
    /** Customer display name, resolved by the caller where possible (else null). */
    customerName: string | null;
    issueDate: string | null;
    dueDate: string | null;
    /** Gross total as a number (currency in `currency`). */
    total: number | null;
    currency: string | null;
    /** Hosted PDF / review URL, if any. */
    url: string | null;
    /** Service period, where the back-end lists it (Qonto does; used to find a replacement invoice). */
    performanceStart?: string | null;
    performanceEnd?: string | null;
    /** The date the invoice was marked paid, where the back-end records one (self does; Qonto's list does not). */
    paidOn?: string | null;
    provider: 'qonto' | 'self';
}

/** Filters for listing already-issued invoices (all optional). */
export interface ListOutgoingInvoicesOptions {
    /** Restrict to a single back-end status (e.g. "draft", "unpaid", "paid"). */
    status?: string;
}

/**
 * What a back-end can do — the UIs render actions from THIS (never from `type`). A missing
 * capability means the matching optional method on {@link OutgoingInvoiceProvider} is absent.
 */
export interface InvoiceCapabilities {
    /**
     * Whether the entity supports creating an invoice via the interactive, contact-based invoice
     * FORM (the "Neue Rechnung" button). Qonto is false: its create needs a resolved Qonto client
     * id + IBAN, not the form's contactId shape — the recurring/one-off path calls
     * provider.createDraft directly and does not consult this flag.
     */
    createDraft: boolean;
    /** Whether a draft can be edited in place (requires provider.updateDraft). */
    editDraft: boolean;
    deleteDraft: boolean;
    finalize: boolean;
    markPaid: boolean;
    cancelStorno: boolean;
    /** How a PDF is obtained: 'hosted' (a URL, Qonto), 'local' (rendered bytes, self), or none. */
    pdf: 'hosted' | 'local' | null;
    /** Whether a structured e-invoice (XRechnung) can be produced. */
    xml: boolean;
}

/** One line item on a detailed invoice view. */
export interface OutgoingInvoiceItemView {
    title: string;
    description: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    vatRate: number;
    net: number;
}

/** Full detail for one invoice (the summary + everything a detail view / edit form needs). */
export interface OutgoingInvoiceDetail extends OutgoingInvoiceSummary {
    kind: 'invoice' | 'storno';
    recipient: OutgoingInvoiceRecipient | null;
    contactId: string | null;
    items: OutgoingInvoiceItemView[];
    totals: { net: number; vat: number; gross: number; byRate: { rate: number; net: number; vat: number }[] };
    performanceStart: string | null;
    performanceEnd: string | null;
    /** Own IBAN the customer pays to (self); preserved across edits. */
    iban: string | null;
    /** BT-10 buyer reference / Leitweg-ID (self); preserved across edits. */
    buyerReference: string | null;
    header: string | null;
    footer: string | null;
    termsAndConditions: string | null;
    paidOn: string | null;
    paidTxId: string | null;
    /** This IS a storno cancelling …; and/or this invoice was cancelled BY … */
    cancelsId: string | null;
    cancelledById: string | null;
}

/** A rendered PDF (self) or a hosted URL (Qonto). */
export type OutgoingInvoiceFile = { kind: 'bytes'; bytes: Uint8Array; filename: string } | { kind: 'url'; url: string };

/** Interface every invoicing back-end implements. */
export interface OutgoingInvoiceProvider {
    /** Human-readable name for display (e.g. "Qonto"). */
    readonly name: string;
    readonly type: 'qonto' | 'self';
    /** What this back-end supports; the UIs render actions from this, not from `type`. */
    readonly capabilities: InvoiceCapabilities;
    /**
     * Validate the invoice CONTENT against this back-end's constraints — pure, no network, no
     * identity (the orchestration layer resolves `clientId`). Returns a list of human-readable
     * problems (empty array = ok) so the CLI/MCP can fail fast and dry-runs can report issues.
     */
    validate(input: CreateInvoiceInput): string[];
    /**
     * Create the invoice as a DRAFT (never auto-sent) so a human reviews and sends it.
     * Returns the back-end record so the caller can record it on the schedule.
     */
    createDraft(input: CreateInvoiceInput): Promise<OutgoingInvoiceDraft>;
    /** List already-issued invoices (newest first), for the "Alle Rechnungen" overview. */
    listInvoices(opts?: ListOutgoingInvoicesOptions): Promise<OutgoingInvoiceSummary[]>;

    // ── Optional lifecycle (presence mirrors `capabilities`) ─────────────────────────
    /** Full detail for one invoice (edit form / detail view). */
    getInvoice?(id: string): Promise<OutgoingInvoiceDetail | null>;
    /** Replace a draft's content (draft-only). */
    updateDraft?(id: string, input: CreateInvoiceInput): Promise<OutgoingInvoiceDraft>;
    /** Delete a draft (draft-only). */
    deleteDraft?(id: string): Promise<void>;
    /** Festschreiben: assign the number, freeze, render+archive. Irreversible. */
    finalize?(id: string): Promise<OutgoingInvoiceSummary>;
    /** Mark an open invoice paid, optionally linking the settling transaction. */
    markPaid?(id: string, opts?: { txId?: string; paidAt?: string }): Promise<OutgoingInvoiceSummary>;
    /** Cancel via a storno counter-invoice. Returns both records. */
    cancel?(
        id: string,
        opts?: { reason?: string },
    ): Promise<{ storno: OutgoingInvoiceSummary; original: OutgoingInvoiceSummary }>;
    /** The invoice PDF (rendered bytes for self, hosted URL for Qonto). */
    getPdf?(id: string): Promise<OutgoingInvoiceFile | null>;
    /**
     * The invoice PDF as bytes, for attaching to a mail. Only needed where {@link getPdf} hands out a
     * URL (Qonto); a back-end whose getPdf already returns bytes leaves it out.
     */
    downloadPdf?(id: string): Promise<OutgoingInvoiceFile | null>;
    /** The invoice XRechnung XML bytes (self only). */
    getXml?(id: string): Promise<OutgoingInvoiceFile | null>;
}

/** Capability presets. */
export const QONTO_CAPABILITIES: InvoiceCapabilities = {
    // The interactive contact-based form + in-place edit are NOT supported by Qonto (its create
    // needs a Qonto client id + IBAN, and it has no updateDraft) — so the UIs must not offer
    // "Neue Rechnung"/"Bearbeiten" for a Qonto entity. Recurring/one-off creation still works via
    // the direct provider.createDraft call, which does not consult these flags.
    createDraft: false,
    editDraft: false,
    deleteDraft: false,
    finalize: false,
    markPaid: false,
    cancelStorno: false,
    pdf: 'hosted',
    xml: false,
};
export const SELF_CAPABILITIES: InvoiceCapabilities = {
    createDraft: true,
    editDraft: true,
    deleteDraft: true,
    finalize: true,
    markPaid: true,
    cancelStorno: true,
    pdf: 'local',
    xml: true,
};

/** Qonto caps each line-item title at 40 characters (Positions-Titel). */
export const MAX_QONTO_ITEM_TITLE_LENGTH = 40;

/**
 * Provider-independent content checks shared by every back-end: dates/currency present, at least
 * one item, and each item carries a title plus parseable quantity/price/VAT. Pure (no network).
 * Back-end-specific limits (e.g. the Qonto 40-char title cap) are added by each provider's
 * {@link OutgoingInvoiceProvider.validate}.
 */
export function commonInvoiceProblems(input: CreateInvoiceInput): string[] {
    const problems: string[] = [];
    if (!input.issueDate) problems.push('Ausstellungsdatum (issueDate) fehlt.');
    if (!input.dueDate) problems.push('Fälligkeitsdatum (dueDate) fehlt.');
    if (!input.currency) problems.push('Währung (currency) fehlt.');
    if (!input.items?.length) {
        problems.push('Mindestens eine Rechnungsposition ist erforderlich.');
        return problems;
    }
    input.items.forEach((it, i) => {
        const n = i + 1;
        if (!it.title?.trim()) problems.push(`Position ${n}: Titel fehlt.`);
        const quantity = Number(String(it.quantity).replace(',', '.'));
        if (!Number.isFinite(quantity) || quantity <= 0) {
            problems.push(`Position ${n}: ungültige Menge "${String(it.quantity)}".`);
        }
        try {
            normalizeAmount(it.unit_price);
        } catch {
            problems.push(`Position ${n}: ungültiger Einzelpreis "${String(it.unit_price)}".`);
        }
        try {
            normalizeVatRate(it.vat_rate);
        } catch {
            problems.push(`Position ${n}: ungültiger USt-Satz "${String(it.vat_rate)}".`);
        }
    });
    return problems;
}

/** Parse a Qonto money string ("128.52") into a number, or null if absent/invalid. */
function parseMoney(value: string | undefined): number | null {
    if (value == null) return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

/** Display name from the invoice's embedded client (company name, else "First Last"). */
function invoiceClientName(client: ClientInvoice['client']): string | null {
    if (!client) return null;
    if (client.name?.trim()) return client.name.trim();
    const full = [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
    return full || null;
}

/** Qonto back-end: drafts a client invoice via POST /v2/client_invoices (status=draft). */
export class QontoOutgoingInvoiceProvider implements OutgoingInvoiceProvider {
    readonly name = 'Qonto';
    readonly type = 'qonto' as const;
    readonly capabilities = QONTO_CAPABILITIES;

    validate(input: CreateInvoiceInput): string[] {
        const problems = commonInvoiceProblems(input);
        if (!input.iban) {
            problems.push('Qonto-Provider: keine Zahlungs-IBAN konfiguriert (invoicing.iban bzw. QONTO_IBAN).');
        }
        input.items?.forEach((it, i) => {
            if (it.title && it.title.length > MAX_QONTO_ITEM_TITLE_LENGTH) {
                problems.push(
                    `Position ${i + 1}: Titel länger als ${MAX_QONTO_ITEM_TITLE_LENGTH} Zeichen (Qonto-Limit).`,
                );
            }
        });
        return problems;
    }

    async createDraft(input: CreateInvoiceInput): Promise<OutgoingInvoiceDraft> {
        if (!input.clientId) {
            throw new Error(
                'Qonto-Provider: customer.qontoClientId fehlt. Lege den Kunden in Qonto an (oder hinterlege die Client-ID in recurring-invoices.json), bevor du die Rechnung erstellst.',
            );
        }
        const problems = this.validate(input);
        if (problems.length) {
            throw new Error(`Rechnung ungültig:\n- ${problems.join('\n- ')}`);
        }
        const body = buildClientInvoiceBody(input.clientId, {
            issue_date: input.issueDate,
            due_date: input.dueDate,
            currency: input.currency,
            iban: input.iban,
            status: input.status ?? 'draft',
            ...(input.number ? { number: input.number } : {}),
            ...(input.header ? { header: input.header } : {}),
            ...(input.footer ? { footer: input.footer } : {}),
            ...(input.termsAndConditions ? { terms_and_conditions: input.termsAndConditions } : {}),
            ...(input.performanceStart ? { performance_start_date: input.performanceStart } : {}),
            ...(input.performanceEnd ? { performance_end_date: input.performanceEnd } : {}),
            items: input.items,
        });
        const inv = await createClientInvoice(body);
        return {
            id: inv.id,
            number: inv.number ?? null,
            status: inv.status ?? 'draft',
            url: inv.invoice_url ?? null,
            provider: 'qonto',
        };
    }

    async listInvoices(opts: ListOutgoingInvoicesOptions = {}): Promise<OutgoingInvoiceSummary[]> {
        const invoices = await listClientInvoices(opts.status ? { status: opts.status } : {});
        const summaries = invoices.map(
            (inv): OutgoingInvoiceSummary => ({
                id: inv.id,
                number: inv.number ?? null,
                status: inv.status ?? 'draft',
                // The list endpoint embeds the full client object (no flat client_id) — read both.
                clientId: inv.client?.id ?? inv.client_id ?? null,
                customerName: invoiceClientName(inv.client),
                issueDate: inv.issue_date ?? null,
                dueDate: inv.due_date ?? null,
                total: parseMoney(inv.total_amount?.value),
                currency: inv.total_amount?.currency ?? inv.currency ?? null,
                url: inv.invoice_url ?? null,
                performanceStart: inv.performance_start_date ?? null,
                performanceEnd: inv.performance_end_date ?? null,
                provider: 'qonto',
            }),
        );
        // Newest first by issue date (Qonto returns oldest-first); undated rows sink to the bottom.
        return summaries.sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''));
    }

    /**
     * The PDF bytes via the invoice's attachment (a short-lived pre-signed URL). Qonto generates the
     * file asynchronously and never for a draft, so both cases fail with a message that says what to do.
     */
    async downloadPdf(id: string): Promise<OutgoingInvoiceFile | null> {
        const inv = await getClientInvoice(id);
        if (inv.status === 'draft') {
            throw new Error(
                'Ein Entwurf hat noch kein endgültiges PDF. Die Rechnung muss erst in Qonto abgeschlossen werden.',
            );
        }
        if (!inv.attachment_id) {
            throw new Error(
                'Qonto hat das PDF dieser Rechnung noch nicht erzeugt (das dauert nach dem Abschließen einige Sekunden). Bitte gleich noch einmal versuchen.',
            );
        }
        const attachment = await getAttachment(inv.attachment_id);
        if (attachment.file_content_type && attachment.file_content_type !== 'application/pdf') {
            throw new Error(`Die Rechnungsdatei bei Qonto ist kein PDF (${attachment.file_content_type}).`);
        }
        const bytes = await downloadAttachmentContent(attachment);
        // The number may hold a slash ("2026/001"), which a file name must not.
        const name = (inv.number ?? id).replace(/[^\w.-]+/g, '_');
        return { kind: 'bytes', bytes: new Uint8Array(bytes), filename: `${name}.pdf` };
    }

    /** Qonto hosts the PDF — return its URL (the UI opens it) rather than bytes. */
    async getPdf(id: string): Promise<OutgoingInvoiceFile | null> {
        const list = await this.listInvoices();
        const inv = list.find((i) => i.id === id);
        return inv?.url ? { kind: 'url', url: inv.url } : null;
    }
}

/** Context for selecting/constructing a provider (the self back-end needs the entity id). */
export interface OutgoingInvoiceProviderContext {
    /** Workspace entity id (required for the self back-end). */
    entityId?: string;
    /** Manifest path override (tests). */
    path?: string;
}

/**
 * Select the invoicing back-end for an entity (mirrors makeDmsProvider). For `self`, the heavy
 * deps (issuer resolution, DMS provider, ledger DB) are wired lazily by {@link buildSelfProvider}
 * in self-provider.ts — a workspace entity id is required. Without one, a guard provider is
 * returned whose write methods throw a clear error (list/validate still work as no-ops).
 */
export function makeOutgoingInvoiceProvider(
    invoicing: EntityInvoicingConfig,
    ctx: OutgoingInvoiceProviderContext = {},
): OutgoingInvoiceProvider {
    if (invoicing.type === 'self') return buildSelfProvider(invoicing, ctx);
    if (ctx.entityId) requireInvoicingBackend(ctx.entityId, ctx.path);
    return new QontoOutgoingInvoiceProvider();
}
