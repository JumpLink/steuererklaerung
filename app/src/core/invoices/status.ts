/**
 * Shared outgoing-invoice status vocabulary. DEPENDENCY-FREE on purpose: this module is imported
 * by the Vite web client, the Hono server AND the native GJS app, so it must not pull in node:/GJS/
 * Qonto code. It normalises the two back-ends' raw statuses (self: draft|open|paid|cancelled;
 * Qonto: draft|unpaid|paid|canceled) and derives `overdue`, with a label + a tone per state.
 */

import { _p } from '../lib/i18n.ts';

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

/**
 * Label per display state. A function, not a `Record` constant: a module-level map would be built
 * before a frontend registers its translator, and would then stay in the source language forever.
 */
export function invoiceStatusLabel(status: DisplayInvoiceStatus): string {
    switch (status) {
        case 'draft':
            return _p('invoice status', 'Draft');
        case 'open':
            return _p('invoice status', 'Open');
        case 'overdue':
            return _p('invoice status', 'Overdue');
        case 'paid':
            return _p('invoice status', 'Paid');
        case 'cancelled':
            return _p('invoice status', 'Cancelled');
    }
}

/** Tone per display state (UIs map this to their own CSS/GTK classes). */
export const INVOICE_STATUS_TONE: Record<DisplayInvoiceStatus, StatusTone> = {
    draft: 'neutral',
    open: 'warn',
    overdue: 'error',
    paid: 'success',
    cancelled: 'neutral',
};
