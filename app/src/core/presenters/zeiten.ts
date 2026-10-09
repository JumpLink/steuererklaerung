/**
 * Zeiten presenter — the DERIVE seam of the "Erfasste Zeiten" list: finished entries grouped by
 * local day, each row reduced to what the list shows (one-line title, project, billing status,
 * duration) and each day to its total.
 *
 * The status comes from the entry's own fields (`invoiceId`, `billable`), never from its free text:
 * imported descriptions often carry a hand-written "NICHT BERECHNET: " prefix, which is user data and
 * stays exactly as typed.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM; the view translates the
 * labels and formats the day heading from {@link TimeDay.relative} / {@link TimeDay.day}.
 */

import type { Project } from '../config/index.ts';
import { formatDuration, timeProjectLabel } from '../actions/time.ts';
import type { TimeEntry } from '@steuererklaerung/store';

/** `billed` = went into an invoice · `internal` = deliberately not billable · `open` = still to bill. */
export type TimeRowStatus = 'open' | 'billed' | 'internal';

export interface TimeListRow {
    entry: TimeEntry;
    /** Local start time, `HH:MM`. */
    time: string;
    /** The description, or the project label for an entry without one. Untouched user text. */
    title: string;
    project: string;
    /** The customer's name, or null when unknown or already part of the project label. */
    customer: string | null;
    status: TimeRowStatus;
    /** A reconstructed entry is an estimate. */
    estimated: boolean;
    /** `HH:MM:SS`, the same format as the timer and the unbilled summary. */
    duration: string;
    /** Billed entries stay put: deleting one would leave its invoice line unexplainable. */
    editable: boolean;
}

export interface TimeDay {
    /** Local day, `YYYY-MM-DD`. */
    day: string;
    /** Set for today/yesterday, so the view can say "Heute"/"Gestern" in its own language. */
    relative: 'today' | 'yesterday' | null;
    seconds: number;
    /** `HH:MM:SS` of {@link seconds}. */
    total: string;
    rows: TimeListRow[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of a timestamp — an entry started at 23:30 belongs to that evening. */
export function localDay(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The billing status of one entry. */
export function timeRowStatus(entry: Pick<TimeEntry, 'invoiceId' | 'billable'>): TimeRowStatus {
    if (entry.invoiceId) return 'billed';
    return entry.billable ? 'open' : 'internal';
}

/** Whether `label` already says who the customer is — then repeating the name adds nothing. */
function mentions(label: string, customer: string): boolean {
    return label.toLocaleLowerCase('de').includes(customer.toLocaleLowerCase('de'));
}

/** One list row: only what the list shows. */
export function buildTimeRow(
    entry: TimeEntry,
    projects: readonly Project[],
    names: ReadonlyMap<string, string>,
): TimeListRow {
    const project = timeProjectLabel(entry, projects);
    const who = entry.contactId ? (names.get(entry.contactId) ?? null) : null;
    const started = new Date(entry.startedAt);
    const status = timeRowStatus(entry);
    return {
        entry,
        time: `${pad(started.getHours())}:${pad(started.getMinutes())}`,
        title: entry.description?.trim() || project,
        project,
        customer: who && !mentions(project, who) ? who : null,
        status,
        estimated: entry.source === 'reconstructed',
        duration: formatDuration(entry.durationSeconds ?? 0),
        editable: status !== 'billed',
    };
}

/**
 * Group finished entries by local day, newest day first and, within a day, newest entry first.
 * Running entries (no end yet) belong to the timer, not to this list.
 */
export function buildTimeDays(
    entries: readonly TimeEntry[],
    projects: readonly Project[],
    names: ReadonlyMap<string, string>,
    now: Date = new Date(),
): TimeDay[] {
    const today = localDay(now);
    const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
    const byDay = new Map<string, TimeEntry[]>();
    for (const e of entries) {
        if (e.endedAt === null) continue;
        const key = localDay(new Date(e.startedAt));
        const list = byDay.get(key) ?? [];
        list.push(e);
        byDay.set(key, list);
    }
    return [...byDay.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, list]) => {
            const seconds = list.reduce((sum, e) => sum + (e.durationSeconds ?? 0), 0);
            return {
                day,
                relative: day === today ? 'today' : day === yesterday ? 'yesterday' : null,
                seconds,
                total: formatDuration(seconds),
                rows: [...list]
                    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                    .map((e) => buildTimeRow(e, projects, names)),
            };
        });
}
