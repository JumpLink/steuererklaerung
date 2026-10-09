/**
 * Runtime-agnostic model for the Umsatzaufstellung (revenue listing) PDF — a formal proof of an
 * entity's taxable turnover for a year, used e.g. as the Anlage to a Tourismusbeitrag declaration.
 * All fields are pre-formatted display strings (de-DE) so the GJS renderer (index.gjs.ts) stays
 * pure drawing. The CLI builds this from its UmsatzReport; the renderer only lays it out.
 */

/** One revenue line (pre-formatted). */
export interface UmsatzPdfRow {
    date: string;
    /** Invoice/reference number, or '' when unknown. */
    ref: string;
    party: string;
    net: string;
    vat: string;
    gross: string;
}

/** One net-by-VAT-rate summary line. */
export interface UmsatzPdfSummaryRow {
    label: string;
    net: string;
    vat: string;
}

/** The complete Umsatzaufstellung render model (A4). */
export interface UmsatzPdfModel {
    title: string;
    /** One-line method note under the title, e.g. "Umsatz i.S.d. §1 UStG · Ist-Versteuerung". */
    subtitle: string;
    /** Key/value header block (Entität, Steuernummer, Jahr, erfasster Zeitraum, Bemessungsgrundlage). */
    meta: { label: string; value: string }[];
    /** Coverage caveat (missing period) shown prominently, or null when the year is fully covered. */
    warning: string | null;
    rows: UmsatzPdfRow[];
    /** Net-by-rate summary (19 % / 7 % / 0 %). */
    summary: UmsatzPdfSummaryRow[];
    totalNet: string;
    totalVat: string;
    totalGross: string;
    /** Closing methodology note (data source, how the figure was derived), or null. */
    note: string | null;
}
