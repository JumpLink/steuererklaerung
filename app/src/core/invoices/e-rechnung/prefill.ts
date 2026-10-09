/**
 * Pre-filling the manual entry of an incoming invoice that is NOT an e-invoice (Idee 2, point 4):
 * the sender is recognised by name and category, VAT rate and payment term come from that sender's
 * last invoice. A suggestion, never a decision — the person confirms or overwrites every value.
 */

/** What the helper needs from an earlier document; the DMS shapes map onto it field by field. */
export interface PrefillRecord {
    id: string;
    correspondent: string | null;
    /** Invoice date, YYYY-MM-DD. */
    date: string | null;
    direction?: 'incoming' | 'outgoing' | null;
    net: number | null;
    vat: number | null;
    gross: number | null;
    /** Booking category, where the store keeps one (Paperless: accounting_category). */
    category?: string | null;
    /** Due date, YYYY-MM-DD, where the store keeps one (Paperless: due_date). */
    dueDate?: string | null;
}

export interface InvoicePrefill {
    /** The document the values were taken from — shown to the person as the reason. */
    sourceId: string;
    sourceDate: string | null;
    category: string | null;
    /** As a fraction, like `VAT_RATES` (0.19). */
    vatRate: number | null;
    paymentTermDays: number | null;
    direction: 'incoming' | 'outgoing' | null;
}

/** The fields of a DMS document the helper reads (structural, so this file stays free of the DMS package). */
interface PrefillSource {
    id: string;
    correspondent: string | null;
    created: string | null;
    direction: 'incoming' | 'outgoing' | null;
    net: number | null;
    vat: number | null;
    gross: number | null;
}

/** DMS document → history record. Category and due date are not on `DmsDocument` yet — so only the VAT rate and the direction can be suggested from the built-in list today. */
export function prefillRecordOf(doc: PrefillSource): PrefillRecord {
    return {
        id: doc.id,
        correspondent: doc.correspondent,
        date: doc.created,
        direction: doc.direction,
        net: doc.net,
        vat: doc.vat,
        gross: doc.gross,
    };
}

const KNOWN_RATES = [0, 0.07, 0.19];

/** "Lieferant  GmbH " and "lieferant gmbh" are the same sender. */
export function senderKey(name: string | null | undefined): string {
    return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** VAT ÷ net, snapped to a German rate when it is within half a percentage point of one. */
export function vatRateOf(net: number | null, vat: number | null): number | null {
    if (net == null || vat == null || net === 0) return null;
    const ratio = Math.abs(vat / net);
    const hit = KNOWN_RATES.find((r) => Math.abs(r - ratio) <= 0.005);
    return hit ?? Math.round(ratio * 1000) / 1000;
}

function daysBetween(from: string, to: string): number | null {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const d = Math.round((b - a) / 86_400_000);
    return d >= 0 ? d : null;
}

/**
 * The suggestion for `correspondent` from the newest earlier invoice of the same sender that says
 * anything useful, or `null` when the sender has none. `excludeId` keeps a document from
 * suggesting itself.
 */
export function prefillFromLastInvoice(
    history: readonly PrefillRecord[],
    correspondent: string | null | undefined,
    excludeId?: string,
): InvoicePrefill | null {
    const key = senderKey(correspondent);
    if (!key) return null;
    const same = history
        .filter((r) => r.id !== excludeId && senderKey(r.correspondent) === key)
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    for (const r of same) {
        const vatRate = vatRateOf(r.net, r.vat);
        const paymentTermDays = r.date && r.dueDate ? daysBetween(r.date, r.dueDate) : null;
        const category = r.category?.trim() || null;
        if (vatRate == null && paymentTermDays == null && category == null) continue;
        return {
            sourceId: r.id,
            sourceDate: r.date,
            category,
            vatRate,
            paymentTermDays,
            direction: r.direction ?? null,
        };
    }
    return null;
}

/** One German line saying where a suggestion came from, e.g. for a row subtitle. */
export function prefillReason(prefill: InvoicePrefill, correspondent: string): string {
    const when = prefill.sourceDate ? ` vom ${prefill.sourceDate.split('-').reverse().join('.')}` : '';
    return `Vorbelegt aus der letzten Rechnung von ${correspondent}${when}.`;
}
