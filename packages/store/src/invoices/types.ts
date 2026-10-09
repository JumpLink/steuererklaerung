/**
 * Outgoing-invoice model for the self (local) invoicing provider — the alternative to drafting
 * via Qonto. One {@link StoredInvoice} is a locally created customer invoice on the SQLite
 * `invoices` + `invoice_items` tables (schema v4). The store is the system of record.
 *
 * German-law shape: a finalized invoice freezes its §14 UStG content (fortlaufende Nummer,
 * recipient + issuer snapshots, per-VAT-rate totals) and becomes immutable; corrections happen
 * via a storno counter-invoice, never by editing (enforced in repo.ts, not SQL). Money is REAL
 * euros; vat_rate is a fraction (0.19), like chart_of_accounts.
 */

/** draft → open (finalized/issued) → paid, or → cancelled (superseded by a storno). */
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'cancelled';

/** A normal invoice, or a storno (Stornorechnung) that cancels an earlier one. */
export type InvoiceKind = 'invoice' | 'storno';

/** §14 recipient block, snapshotted onto the invoice at finalize (frozen thereafter). */
export interface InvoiceRecipient {
    name: string;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    countryCode?: string | null;
    vatNumber?: string | null;
    email?: string | null;
}

/** §14 issuer block, snapshotted at finalize (resolved from config by the caller). */
export interface InvoiceIssuerSnapshot {
    name: string;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    countryCode?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    /** Steuernummer OR vatId must be present at finalize (§14). */
    taxNumber?: string | null;
    vatId?: string | null;
    /** §19 UStG small-business: no VAT is shown and the §19 note is required. */
    kleinunternehmer?: boolean;
    bank?: { iban?: string | null; bic?: string | null; bankName?: string | null; accountHolder?: string | null };
}

/** One invoice position (line item). */
export interface StoredInvoiceItem {
    title: string;
    description?: string | null;
    quantity: number;
    unit?: string | null;
    /** Net unit price in EUR. */
    unitPriceNet: number;
    /** VAT rate as a fraction (0.19, 0.07, 0). */
    vatRate: number;
    /** Frozen line totals (net = quantity × unitPriceNet, rounded; vat/gross derived). */
    net: number;
    vat: number;
    gross: number;
}

/** Per-VAT-rate breakdown for the §14 tax summary. */
export interface VatBreakdownEntry {
    /** VAT rate as a fraction (0.19, 0.07, 0). */
    rate: number;
    net: number;
    vat: number;
    gross: number;
}

/** Frozen document-archive references (built-in doc ids or Paperless ids). */
export interface InvoiceArchiveRefs {
    dms: string | null;
    pdfDocumentId: string | null;
    xmlDocumentId: string | null;
}

/** A stored invoice: the `invoices` row + its items, with JSON columns parsed. */
export interface StoredInvoice {
    id: string;
    /** Workspace entity id (gbr|jumplink|privat) — a free scoping tag. */
    entityId: string;
    kind: InvoiceKind;
    status: InvoiceStatus;
    /** Fortlaufende Rechnungsnummer, or null while still a draft. */
    number: string | null;
    contactId: string | null;
    /** Frozen at finalize; null on a draft (rendered live from the contact then). */
    recipient: InvoiceRecipient | null;
    issuer: InvoiceIssuerSnapshot | null;
    issueDate: string | null;
    dueDate: string | null;
    performanceStart: string | null;
    performanceEnd: string | null;
    currency: string;
    iban: string | null;
    /** BT-10 Leitweg-ID / buyer reference (optional, mostly public-sector). */
    buyerReference: string | null;
    header: string | null;
    footer: string | null;
    terms: string | null;
    items: StoredInvoiceItem[];
    /** Totals: frozen at finalize; computed live from items on a draft. */
    totals: { net: number; vat: number; gross: number; byRate: VatBreakdownEntry[] };
    /** Set on a storno row: the invoice this one cancels. */
    stornoOfId: string | null;
    /** Set on a cancelled invoice: the storno that cancelled it. */
    cancelledById: string | null;
    paidAt: string | null;
    paidTxId: string | null;
    archive: InvoiceArchiveRefs;
    finalizedAt: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string | null;
}

/** Writable draft fields (item totals are computed, not supplied). */
export interface InvoiceItemInput {
    title: string;
    description?: string | null;
    quantity: number;
    unit?: string | null;
    unitPriceNet: number;
    vatRate: number;
}

/** Create/update payload for a DRAFT invoice (id optional → generated on insert). */
export interface InvoiceDraftInput {
    id?: string;
    entityId: string;
    contactId?: string | null;
    /** Optional recipient override; normally resolved from the contact by the caller. */
    recipient?: InvoiceRecipient | null;
    issueDate?: string | null;
    dueDate?: string | null;
    performanceStart?: string | null;
    performanceEnd?: string | null;
    currency?: string;
    iban?: string | null;
    buyerReference?: string | null;
    header?: string | null;
    footer?: string | null;
    terms?: string | null;
    items: InvoiceItemInput[];
}
