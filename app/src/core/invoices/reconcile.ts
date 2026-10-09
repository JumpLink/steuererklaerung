/**
 * Keep a recurring schedule's `lastInvoice` in step with what the invoicing back-end holds.
 *
 * "Entwurf erstellen" records the draft's number (Qonto: a `-PROFORMA` one). The final number only
 * exists once the invoice is finalized, and a cancellation (Storno plus a new invoice) replaces the
 * invoice altogether. Pure: it takes the schedules and the back-end's invoice list and returns what
 * to change, so the action layer decides whether to write.
 */

import type { LastInvoice, RecurringInvoice } from '../config/schema/recurring.ts';
import { normalizeInvoiceStatus } from './status.ts';
import type { OutgoingInvoiceSummary } from './provider.ts';

export type ReconcileOutcome =
    /** The back-end invoice carries a different number, date or link: `lastInvoice` follows it. */
    | 'updated'
    /** The invoice was cancelled and a replacement for the same period exists: `lastInvoice` points to it. */
    | 'replaced'
    /** The invoice was cancelled and no replacement exists (yet): left as it is. */
    | 'cancelled-no-replacement'
    /** The recorded invoice is not in the back-end list (e.g. a deleted draft): left as it is. */
    | 'missing'
    | 'unchanged';

export interface ReconcileChange {
    scheduleId: string;
    outcome: ReconcileOutcome;
    /** The recorded number before and after (null when none). */
    before: string | null;
    after: string | null;
}

export interface ReconcileResult {
    /** The schedules with `lastInvoice` brought up to date (same array order; untouched ones are the same objects). */
    schedules: RecurringInvoice[];
    changes: ReconcileChange[];
}

/** The fields of `lastInvoice` that describe one specific invoice, from a back-end summary. */
function fromInvoice(inv: OutgoingInvoiceSummary, base: LastInvoice): LastInvoice {
    return {
        ...(inv.number ? { number: inv.number } : {}),
        issueDate: inv.issueDate ?? base.issueDate,
        ...(base.period ? { period: base.period } : {}),
        providerId: inv.id,
        ...(inv.url ? { url: inv.url } : {}),
    };
}

/** The same invoice, refreshed: keeps the mail log, since that mail went out for this very invoice. */
function refresh(inv: OutgoingInvoiceSummary, last: LastInvoice): LastInvoice {
    return {
        ...last,
        ...(inv.number ? { number: inv.number } : {}),
        issueDate: inv.issueDate ?? last.issueDate,
        ...(inv.url ? { url: inv.url } : {}),
    };
}

function samePeriod(inv: OutgoingInvoiceSummary, period: { start: string; end: string }): boolean {
    return inv.performanceStart === period.start && inv.performanceEnd === period.end;
}

/**
 * The invoice that took the place of a cancelled one: the newest live invoice for the same
 * customer and the same service period. Without a period on the recorded invoice or on the
 * candidate there is nothing to tell a replacement from an unrelated invoice, so none is picked.
 */
function findReplacement(
    cancelled: OutgoingInvoiceSummary,
    schedule: RecurringInvoice,
    invoices: OutgoingInvoiceSummary[],
): OutgoingInvoiceSummary | undefined {
    const period = schedule.lastInvoice?.period;
    if (!period) return undefined;
    const clientId = cancelled.clientId;
    return invoices
        .filter(
            (c) =>
                c.id !== cancelled.id &&
                normalizeInvoiceStatus(c.status) !== 'cancelled' &&
                (!clientId || c.clientId === clientId) &&
                samePeriod(c, period),
        )
        .sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''))[0];
}

export function reconcileLastInvoices(
    schedules: RecurringInvoice[],
    invoices: OutgoingInvoiceSummary[],
): ReconcileResult {
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const changes: ReconcileChange[] = [];
    const next = schedules.map((schedule) => {
        const last = schedule.lastInvoice;
        if (!last?.providerId) return schedule;
        const before = last.number ?? null;
        const record = (outcome: ReconcileOutcome, after: string | null = before): void => {
            changes.push({ scheduleId: schedule.id, outcome, before, after });
        };
        const invoice = byId.get(last.providerId);
        if (!invoice) {
            record('missing');
            return schedule;
        }
        if (normalizeInvoiceStatus(invoice.status) === 'cancelled') {
            const replacement = findReplacement(invoice, schedule, invoices);
            if (!replacement) {
                record('cancelled-no-replacement');
                return schedule;
            }
            record('replaced', replacement.number ?? null);
            return { ...schedule, lastInvoice: fromInvoice(replacement, last) };
        }
        const refreshed = refresh(invoice, last);
        const changed =
            refreshed.number !== last.number || refreshed.issueDate !== last.issueDate || refreshed.url !== last.url;
        if (!changed) {
            record('unchanged');
            return schedule;
        }
        record('updated', refreshed.number ?? null);
        return { ...schedule, lastInvoice: refreshed };
    });
    return { schedules: next, changes };
}

/** Whether a change rewrote `lastInvoice`. */
export function isRewrite(change: ReconcileChange): boolean {
    return change.outcome === 'updated' || change.outcome === 'replaced';
}
