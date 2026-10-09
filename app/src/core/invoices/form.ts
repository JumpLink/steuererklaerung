/**
 * Shared invoice-form helpers for the create/edit dialogs. DEPENDENCY-FREE (imported by the Vite
 * web client AND the native GJS app), so no node:/GJS/Qonto imports. Works on RAW string inputs
 * from the form fields (German decimals allowed) and mirrors the store's totals math so the live
 * preview matches what the back-end will freeze.
 */

/** One line-item row as the form holds it (all raw strings). */
export interface InvoiceItemDraft {
    title: string;
    description?: string;
    quantity: string;
    unit?: string;
    unitPrice: string;
    vatRate: string;
}

/** The whole draft as the form holds it. */
export interface InvoiceFormDraft {
    contactId: string;
    issueDate: string;
    dueDate?: string;
    performanceStart?: string;
    performanceEnd?: string;
    header?: string;
    footer?: string;
    termsAndConditions?: string;
    items: InvoiceItemDraft[];
}

/** Parse a German or plain decimal ("1.234,56" | "1234.56" | "1234,56") → number, or null. */
export function parseGermanDecimal(s: string): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    // If both separators appear, the LAST one is the decimal separator.
    let normalized = t;
    if (t.includes(',') && t.includes('.')) {
        normalized =
            t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (t.includes(',')) {
        normalized = t.replace(',', '.');
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

/** A fresh empty item row (sensible defaults: qty 1, 19 % VAT). */
export function emptyItem(): InvoiceItemDraft {
    return { title: '', quantity: '1', unitPrice: '', vatRate: '19' };
}

/** Parse a VAT-rate field ("19" | "19 %" | "0,19") into a fraction (0.19). */
export function parseVatRate(s: string): number | null {
    const n = parseGermanDecimal((s ?? '').replace('%', ''));
    if (n == null) return null;
    return n > 1 ? n / 100 : n;
}

/** Live totals from the raw form items (net, per-rate VAT, gross) — integer-cent math. */
export function computeFormTotals(items: InvoiceItemDraft[]): {
    net: number;
    vat: number;
    gross: number;
    byRate: { rate: number; net: number; vat: number }[];
} {
    const netCentsByRate = new Map<number, number>();
    for (const it of items) {
        const qty = parseGermanDecimal(it.quantity);
        const price = parseGermanDecimal(it.unitPrice);
        const rate = parseVatRate(it.vatRate);
        if (qty == null || price == null || rate == null) continue;
        const cents = Math.round(qty * price * 100);
        netCentsByRate.set(rate, (netCentsByRate.get(rate) ?? 0) + cents);
    }
    const byRate: { rate: number; net: number; vat: number }[] = [];
    let netTotal = 0;
    let vatTotal = 0;
    for (const rate of [...netCentsByRate.keys()].sort((a, b) => b - a)) {
        const netCents = netCentsByRate.get(rate) as number;
        const vatCents = Math.round(netCents * rate);
        netTotal += netCents;
        vatTotal += vatCents;
        byRate.push({ rate, net: netCents / 100, vat: vatCents / 100 });
    }
    return { net: netTotal / 100, vat: vatTotal / 100, gross: (netTotal + vatTotal) / 100, byRate };
}

/** Validate a form draft before saving. Returns German problems (empty = ok). */
export function validateFormDraft(draft: InvoiceFormDraft): string[] {
    const problems: string[] = [];
    if (!draft.contactId?.trim()) problems.push('Empfänger fehlt — bitte einen Kunden wählen.');
    if (!draft.issueDate?.trim()) problems.push('Ausstellungsdatum fehlt.');
    if (!draft.items.length) problems.push('Mindestens eine Position ist erforderlich.');
    draft.items.forEach((it, i) => {
        const n = i + 1;
        if (!it.title?.trim()) problems.push(`Position ${n}: Bezeichnung fehlt.`);
        if (parseGermanDecimal(it.quantity) == null) problems.push(`Position ${n}: ungültige Menge.`);
        if (parseGermanDecimal(it.unitPrice) == null) problems.push(`Position ${n}: ungültiger Einzelpreis.`);
        if (parseVatRate(it.vatRate) == null) problems.push(`Position ${n}: ungültiger USt-Satz.`);
    });
    return problems;
}
