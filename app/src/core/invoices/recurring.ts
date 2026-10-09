/**
 * Recurring outgoing invoices — pure domain logic (no I/O): money totals, schedule
 * advancement, and the reminder dashboard that powers both the CLI `invoices recurring due`
 * view and the web dashboard card. Kept side-effect-free so it is fully unit-testable, exactly
 * like the Steuer-Fristen logic in src/elster/fristen.ts.
 */

import { shiftDate } from '@steuererklaerung/shared';
import { round2 } from '../lib/money.ts';
import { dueDateOf, type LastInvoice, type RecurringInvoice, type RecurringItem } from '../config/index.ts';

/** Parse a decimal that may be a number or a German/period string ("108", "108,00", "1.5"). */
function toNum(v: string | number): number {
    if (typeof v === 'number') return v;
    const n = Number.parseFloat(String(v).replace(',', '.').trim());
    if (!Number.isFinite(n)) throw new Error(`Invalid number: ${String(v)}`);
    return n;
}

/** Normalize a VAT rate to a fraction: 19 → 0.19, "0.07" → 0.07 (values > 1 are percent). */
function vatFraction(v: string | number): number {
    const n = toNum(v);
    return n > 1 ? n / 100 : n;
}

export interface InvoiceTotals {
    net: number;
    vat: number;
    gross: number;
}

/** Sum a schedule's line items into net / VAT / gross totals (rounded to cents). */
export function computeItemTotals(items: RecurringItem[]): InvoiceTotals {
    let net = 0;
    let vat = 0;
    for (const it of items) {
        const lineNet = toNum(it.quantity) * toNum(it.unitPrice);
        net += lineNet;
        vat += lineNet * vatFraction(it.vatRate);
    }
    net = round2(net);
    vat = round2(vat);
    return { net, vat, gross: round2(net + vat) };
}

/** Parse a YYYY-MM-DD date into a UTC-midnight epoch (ms). */
function parseDay(dateStr: string): number {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** Whole days from `from` to `to` (negative when `to` is in the past). */
export function daysBetween(from: string, to: string): number {
    return Math.round((parseDay(to) - parseDay(from)) / 86_400_000);
}

/** Add `months` to a YYYY-MM-DD date, clamping the day to the target month's length. */
export function addMonths(dateStr: string, months: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1 + months, 1));
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/**
 * Advance a schedule after an invoice was issued: record it as `lastInvoice` and roll the
 * service period + due date forward by `intervalMonths`. The new period starts the day after
 * the old period ends, so consecutive invoices tile the calendar without gaps or overlaps.
 */
export function advanceSchedule(inv: RecurringInvoice, issued: LastInvoice): RecurringInvoice {
    const billed = inv.nextPeriod;
    const newStart = shiftDate(billed.end, 1);
    const newEnd = shiftDate(addMonths(newStart, inv.intervalMonths), -1);
    return {
        ...inv,
        lastInvoice: { ...issued, period: issued.period ?? billed },
        nextPeriod: { start: newStart, end: newEnd },
        nextDueDate: newStart,
    };
}

export type RecurringDueStatus = 'overdue' | 'due-soon' | 'upcoming' | 'paused' | 'cancelled';

export interface RecurringDueEntry {
    id: string;
    entityId: string;
    customer: string;
    description: string | null;
    domains: string[];
    /** The project the contract belongs to, if any. */
    projectId: string | null;
    /** When the next invoice should be issued (YYYY-MM-DD). */
    dueDate: string;
    period: { start: string; end: string };
    totals: InvoiceTotals;
    currency: string;
    status: RecurringDueStatus;
    /** Days until due; negative when overdue. */
    daysUntilDue: number;
    lastInvoiceNumber: string | null;
}

export interface DashboardOptions {
    /** Reference "today" as YYYY-MM-DD. */
    today: string;
    /**
     * Optional global override for the "due-soon" window (days). When omitted, each schedule's
     * own `reminderLeadDays` is used — so a customer with a 4-week cancellation window lights up
     * 28 days ahead while others can differ.
     */
    leadDaysOverride?: number;
}

/** Map one schedule to a dashboard entry with its computed status. */
export function toDueEntry(inv: RecurringInvoice, opts: DashboardOptions): RecurringDueEntry {
    const dueDate = dueDateOf(inv);
    const daysUntilDue = daysBetween(opts.today, dueDate);
    const lead = opts.leadDaysOverride ?? inv.reminderLeadDays;
    let status: RecurringDueStatus;
    if (inv.status === 'cancelled') status = 'cancelled';
    else if (inv.status === 'paused') status = 'paused';
    else if (daysUntilDue < 0) status = 'overdue';
    else if (daysUntilDue <= lead) status = 'due-soon';
    else status = 'upcoming';
    return {
        id: inv.id,
        entityId: inv.entityId,
        customer: inv.customer.name,
        description: inv.description ?? null,
        domains: inv.domains,
        projectId: inv.projectId ?? null,
        dueDate,
        period: inv.nextPeriod,
        totals: computeItemTotals(inv.items),
        currency: inv.currency,
        status,
        daysUntilDue,
        lastInvoiceNumber: inv.lastInvoice?.number ?? null,
    };
}

const STATUS_ORDER: Record<RecurringDueStatus, number> = {
    overdue: 0,
    'due-soon': 1,
    upcoming: 2,
    paused: 3,
    cancelled: 4,
};

/**
 * Compute the full reminder dashboard: every schedule mapped to an entry, sorted by urgency
 * (overdue first, then by due date). Filter the result with {@link isActionable} for the
 * "what needs doing now" view.
 */
export function computeRecurringInvoiceDashboard(
    invoices: RecurringInvoice[],
    opts: DashboardOptions,
): RecurringDueEntry[] {
    return invoices
        .map((inv) => toDueEntry(inv, opts))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.dueDate.localeCompare(b.dueDate));
}

/** A schedule that needs action now: overdue or inside its reminder window. */
export function isActionable(entry: RecurringDueEntry): boolean {
    return entry.status === 'overdue' || entry.status === 'due-soon';
}

/** One reminder, ready for any channel: a desktop notification, a mail, a log line. */
export interface RecurringReminder {
    /** The schedules the reminder is about — overdue first. Empty means: say nothing. */
    entries: RecurringDueEntry[];
    /** One line: how many, how much, how late. */
    title: string;
    /** One line per schedule. */
    lines: string[];
    /** `lines` joined — what most notification APIs want. */
    body: string;
    /** Sum over {@link entries}, in `currency`. */
    totalGross: number;
    currency: string;
    /** Days the oldest overdue schedule is past due; 0 when nothing is overdue. */
    oldestOverdueDays: number;
}

/** German money formatting, so a reminder reads like the invoices it is about. */
function formatAmount(value: number, currency: string): string {
    const [whole, cents] = Math.abs(value).toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${value < 0 ? '-' : ''}${grouped},${cents} ${currency}`;
}

/**
 * Build the reminder for everything that needs action now.
 *
 * Pure on purpose. The delivery — a desktop notification, a mail, a line in a log — is a separate,
 * swappable concern; what a reminder SAYS is business logic and belongs next to the dashboard that
 * decides what is due. The first version of this lived in a shell script beside the app, which
 * meant the wording was untestable and only one machine in the world ever reminded anyone.
 *
 * Returns `null` when nothing is actionable, so a caller cannot accidentally notify about an empty
 * list: "nothing due" and "here is your reminder" are different shapes, not the same shape with a
 * zero in it.
 */
export function buildReminder(entries: RecurringDueEntry[]): RecurringReminder | null {
    const actionable = entries.filter(isActionable);
    if (actionable.length === 0) return null;

    const currency = actionable[0].currency;
    const totalGross = actionable.reduce((sum, e) => sum + e.totals.gross, 0);
    const overdue = actionable.filter((e) => e.status === 'overdue');
    const oldestOverdueDays = overdue.length ? Math.abs(Math.min(...overdue.map((e) => e.daysUntilDue))) : 0;

    const plural = actionable.length === 1 ? 'Rechnung' : 'Rechnungen';
    let title = `${actionable.length} ${plural} offen, ${formatAmount(totalGross, currency)}`;
    if (oldestOverdueDays > 0) title += ` — älteste seit ${oldestOverdueDays} Tagen`;

    const lines = [...actionable]
        .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
        .map((e) => {
            const mark = e.status === 'overdue' ? 'ÜBERFÄLLIG ' : 'bald fällig';
            const what = e.description ?? e.customer;
            return `${mark}  ${e.dueDate}  ${formatAmount(e.totals.gross, e.currency)}  ${what}`;
        });

    return { entries: actionable, title, lines, body: lines.join('\n'), totalGross, currency, oldestOverdueDays };
}
