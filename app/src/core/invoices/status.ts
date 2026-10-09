/**
 * Shared outgoing-invoice status vocabulary. DEPENDENCY-FREE on purpose: this module is imported
 * by the Vite web client, the Hono server AND the native GJS app, so it must not pull in node:/GJS/
 * Qonto code. It normalises the two back-ends' raw statuses (self: draft|open|paid|cancelled;
 * Qonto: draft|unpaid|paid|canceled) and derives `overdue`, with German labels + a tone per state.
 */

export type NormalizedInvoiceStatus = 'draft' | 'open' | 'paid' | 'cancelled';
export type DisplayInvoiceStatus = NormalizedInvoiceStatus | 'overdue';
export type StatusTone = 'neutral' | 'warn' | 'error' | 'success';

/** Map a back-end status string to the normalized lifecycle state. */
export function normalizeInvoiceStatus(raw: string): NormalizedInvoiceStatus {
    switch (raw) {
        case 'unpaid':
        case 'open':
            return 'open';
        case 'paid':
            return 'paid';
        case 'canceled':
        case 'cancelled':
            return 'cancelled';
        default:
            return 'draft';
    }
}

/** The display state incl. `overdue` (an open invoice past its due date). `today` is YYYY-MM-DD. */
export function displayInvoiceStatus(raw: string, dueDate: string | null, today: string): DisplayInvoiceStatus {
    const norm = normalizeInvoiceStatus(raw);
    if (norm === 'open' && dueDate && dueDate < today) return 'overdue';
    return norm;
}

/** German label per display state. */
export const INVOICE_STATUS_LABEL: Record<DisplayInvoiceStatus, string> = {
    draft: 'Entwurf',
    open: 'Offen',
    overdue: 'Überfällig',
    paid: 'Bezahlt',
    cancelled: 'Storniert',
};

/** Tone per display state (UIs map this to their own CSS/GTK classes). */
export const INVOICE_STATUS_TONE: Record<DisplayInvoiceStatus, StatusTone> = {
    draft: 'neutral',
    open: 'warn',
    overdue: 'error',
    paid: 'success',
    cancelled: 'neutral',
};
