/**
 * Creating, editing and retiring a recurring-invoice schedule — the writer half of a feature that
 * only ever had a reader.
 *
 * The dashboard reminds, and `createRecurringInvoiceDraft` issues the next invoice. But a schedule
 * itself could only be written by editing the manifest by hand, which means the one recurring
 * revenue an app like this exists to not forget was configurable only in a text editor. Every
 * surface could USE a schedule; none could make one.
 *
 * Slug ids rather than random ones: an id appears in the manifest a human reads and in the reminder
 * a human acts on, and `musterkunde-hosting` says what `rec_7f3a` does not. Collisions get a
 * numeric suffix instead of an error — being asked to invent a unique id is not a task for the
 * person who just wants to bill their customer again next year.
 */

import { loadRecurringInvoices, saveRecurringInvoices } from '../config/index.ts';
import type { RecurringInvoice } from '../config/schema/recurring.ts';

/** `Musterkunde GmbH` + `Hosting` → `musterkunde-gmbh-hosting`. */
export function slugForSchedule(customer: string, description?: string): string {
    const raw = [customer, description].filter(Boolean).join(' ');
    const slug = raw
        .toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'rechnung';
}

/** A slug not yet taken in `existing`; `-2`, `-3`, … on collision. */
export function uniqueScheduleId(base: string, existing: readonly string[]): string {
    const taken = new Set(existing);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const candidate = `${base}-${n}`;
        if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`Keine freie Id für „${base}" gefunden.`);
}

/**
 * The service period following `period`, `intervalMonths` later.
 *
 * Month arithmetic, not 365 days: a yearly schedule starting 2025-02-01 must land on 2026-02-01,
 * and adding days drifts by one every leap year. The end is the day before the next start, so
 * consecutive periods touch without overlapping — an overlap would bill one day twice.
 */
export function nextPeriod(
    period: { start: string; end: string },
    intervalMonths: number,
): { start: string; end: string } {
    const start = addMonths(period.start, intervalMonths);
    const end = addDays(addMonths(start, intervalMonths), -1);
    return { start, end };
}

/** Add whole months to `YYYY-MM-DD`, clamping the day into the target month (31 Jan + 1 = 28 Feb). */
export function addMonths(iso: string, months: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay));
    return target.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));
    return date.toISOString().slice(0, 10);
}

/** Every schedule of an entity, in manifest order. */
export function listSchedules(entityId: string): RecurringInvoice[] {
    return loadRecurringInvoices().filter((r) => r.entityId === entityId);
}

/**
 * Insert or replace one schedule.
 *
 * Matched by id: an edit keeps its place in the list, so the manifest diff of a changed price is
 * the changed price and not a reordering of everything.
 */
export function saveSchedule(schedule: RecurringInvoice): RecurringInvoice {
    const all = loadRecurringInvoices();
    const index = all.findIndex((r) => r.id === schedule.id && r.entityId === schedule.entityId);
    // `lastInvoice` belongs to invoice creation and the background reconcile, never to the edit form:
    // a dialog opened before a sync holds a stale copy and would write the old number back.
    const stored = index >= 0 ? all[index].lastInvoice : undefined;
    const next = stored ? { ...schedule, lastInvoice: stored } : schedule;
    if (index >= 0) all[index] = next;
    else all.push(next);
    saveRecurringInvoices(all);
    return next;
}

/**
 * Set a schedule's status.
 *
 * `cancelled` rather than deletion is the default retirement: the schedule records what was billed
 * (`lastInvoice`) and why, and an issued invoice whose schedule vanished is a figure nobody can
 * explain later. {@link removeSchedule} exists for the case of a schedule created by mistake.
 */
export function setScheduleStatus(
    entityId: string,
    id: string,
    status: 'active' | 'paused' | 'cancelled',
): RecurringInvoice {
    const all = loadRecurringInvoices();
    const found = all.find((r) => r.id === id && r.entityId === entityId);
    if (!found) throw new Error(`Kein wiederkehrender Posten „${id}" für ${entityId}.`);
    found.status = status;
    saveRecurringInvoices(all);
    return found;
}

/** Delete a schedule outright — for one created by mistake; retiring one is a status change. */
export function removeSchedule(entityId: string, id: string): void {
    const all = loadRecurringInvoices();
    const rest = all.filter((r) => !(r.id === id && r.entityId === entityId));
    if (rest.length === all.length) throw new Error(`Kein wiederkehrender Posten „${id}" für ${entityId}.`);
    saveRecurringInvoices(rest);
}
