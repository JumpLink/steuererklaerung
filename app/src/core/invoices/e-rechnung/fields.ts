/**
 * An e-invoice's fields in the shapes the two document stores already take — the AI-free way to
 * fill what `extractInvoiceFieldsFromContent` otherwise guesses from OCR text.
 *
 * Sign convention: a credit note (TypeCode 381) is written with POSITIVE amounts in the file; here
 * its amounts become NEGATIVE, as for a storno in the invoice store (`StoredInvoice`) — otherwise a
 * Gutschrift filed as an incoming invoice would add Vorsteuer instead of reducing it.
 */

import type { EInvoice } from './types.ts';

/** Same keys as `ExtractedInvoiceFields` (actions/paperless/extract-invoice.ts); structurally assignable. */
export interface EInvoiceFields {
    invoice_number?: string;
    invoice_date?: string;
    due_date?: string;
    currency?: string;
    total_net?: number;
    total_gross?: number;
    tax_amount?: number;
    tax_rate?: string;
    service_period_start?: string;
    service_period_end?: string;
    supplier_country?: string;
    supplier_vat_id?: string;
    reverse_charge?: boolean;
}

const sign = (inv: EInvoice): number => (inv.documentKind === 'credit-note' ? -1 : 1);

/** `+ 0` turns a negated zero (-0) back into 0. */
const scaled = (s: number, n: number): number => s * n + 0;

/** The VAT rate that carries most of the net amount — what a single "Steuersatz" field can show. */
function dominantRate(inv: EInvoice): number | null {
    const rated = inv.vat.filter((v) => v.rate != null && v.rate > 0 && v.category !== 'AE');
    if (rated.length === 0) return null;
    return rated.reduce((a, b) => ((b.basis ?? 0) > (a.basis ?? 0) ? b : a)).rate;
}

export function eInvoiceToFields(inv: EInvoice): EInvoiceFields {
    const s = sign(inv);
    const out: EInvoiceFields = {};
    if (inv.number) out.invoice_number = inv.number;
    if (inv.issueDate) out.invoice_date = inv.issueDate;
    if (inv.dueDate) out.due_date = inv.dueDate;
    if (inv.currency) out.currency = inv.currency;
    if (inv.totals.net != null) out.total_net = scaled(s, inv.totals.net);
    if (inv.totals.gross != null) out.total_gross = scaled(s, inv.totals.gross);
    if (inv.totals.vat != null) out.tax_amount = scaled(s, inv.totals.vat);
    const rate = dominantRate(inv);
    if (rate != null) out.tax_rate = `${rate}%`;
    if (inv.servicePeriodStart) out.service_period_start = inv.servicePeriodStart;
    if (inv.servicePeriodEnd) out.service_period_end = inv.servicePeriodEnd;
    if (inv.seller.country) out.supplier_country = inv.seller.country.toUpperCase();
    if (inv.seller.vatId) out.supplier_vat_id = inv.seller.vatId;
    if (inv.vat.length > 0) out.reverse_charge = inv.vat.some((v) => v.category === 'AE');
    return out;
}

/** The fields of the built-in DMS (`DmsDocument`) an e-invoice can fill without a person or an AI. */
export interface EInvoiceReceiptMetadata {
    title: string | null;
    correspondent: string | null;
    invoiceNumber: string | null;
    created: string | null;
    net: number | null;
    vat: number | null;
    gross: number | null;
}

export function eInvoiceToReceiptMetadata(inv: EInvoice): EInvoiceReceiptMetadata {
    const s = sign(inv);
    const signed = (n: number | null): number | null => (n == null ? null : scaled(s, n));
    const title = [inv.seller.name, inv.number].filter(Boolean).join(' ');
    return {
        title: title || null,
        correspondent: inv.seller.name,
        invoiceNumber: inv.number,
        created: inv.issueDate,
        net: signed(inv.totals.net),
        vat: signed(inv.totals.vat),
        gross: signed(inv.totals.gross),
    };
}
