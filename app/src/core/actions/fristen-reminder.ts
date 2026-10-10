/**
 * Fristen-Wächter — what a reminder about open Paperless items SAYS, and the calendar feed for them.
 *
 * Pure on purpose, like the recurring-invoice reminder: delivery (desktop notification, file) is a
 * separate concern in the CLI; the wording is business logic and is tested as such. The data comes
 * from {@link listOpenItems}.
 */

import type { OpenItem } from './fristen.ts';
import type { IcsEvent } from './ics.ts';

/** Days before the due date at which the calendar alarm fires. */
export const FRISTEN_ALARM_DAYS = 3;

/** How many items the notification lists before it summarises the rest. */
const MAX_LINES = 5;

export interface FristenReminder {
    /** Overdue first, then soonest due — only items that need action inside the lead window. */
    items: OpenItem[];
    overdue: number;
    dueSoon: number;
    /** One line: how many, how many of them late. */
    title: string;
    /** One line per item (capped), then a "… und n weitere" line if needed. */
    lines: string[];
    /** `lines` joined — what most notification APIs want. */
    body: string;
}

/** German money formatting, so the reminder reads like the documents it is about. */
function formatAmount(value: number): string {
    const [whole, cents] = Math.abs(value).toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${value < 0 ? '-' : ''}${grouped},${cents} €`;
}

function label(item: OpenItem): string {
    return [item.correspondent, item.title].filter(Boolean).join(' — ') || `#${item.id}`;
}

/**
 * Build the reminder for everything overdue or due within `leadDays`. Undated items never qualify:
 * without a date there is nothing to be late for.
 *
 * Returns `null` when nothing needs action, so a caller cannot notify about an empty list.
 */
export function buildFristenReminder(items: OpenItem[], opts: { leadDays?: number } = {}): FristenReminder | null {
    const lead = opts.leadDays ?? 7;
    const actionable = items
        .filter((i) => i.dueDate != null && i.daysUntil != null && i.daysUntil <= lead)
        .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.id - b.id));
    if (actionable.length === 0) return null;

    const overdue = actionable.filter((i) => i.overdue).length;
    const dueSoon = actionable.length - overdue;
    const noun = actionable.length === 1 ? 'Frist' : 'Fristen';
    let title = `${actionable.length} ${noun}`;
    if (overdue > 0) title += `, ${overdue} überfällig`;
    if (dueSoon > 0) title += `, ${dueSoon} in ${lead} Tagen oder früher`;

    const lines = actionable.slice(0, MAX_LINES).map((i) => {
        const mark = i.overdue ? 'ÜBERFÄLLIG' : 'bald fällig';
        const amount = i.amount != null ? `  ${formatAmount(i.amount)}` : '';
        return `${mark}  ${i.dueDate}${amount}  ${label(i)}`;
    });
    if (actionable.length > MAX_LINES) lines.push(`… und ${actionable.length - MAX_LINES} weitere`);

    return { items: actionable, overdue, dueSoon, title, lines, body: lines.join('\n') };
}

/**
 * One all-day event per DATED open item, on its real due date. The UID comes from the Paperless id,
 * so re-running the export updates the entry instead of duplicating it. Overdue items keep their
 * due date and are marked in the summary.
 */
export function buildFristenIcsEvents(items: OpenItem[]): IcsEvent[] {
    const events: IcsEvent[] = [];
    for (const i of items) {
        if (!i.dueDate) continue;
        const amount = i.amount != null ? ` · ${formatAmount(i.amount)}` : '';
        events.push({
            uid: `openitem-${i.id}`,
            date: i.dueDate,
            summary: `${i.overdue ? 'ÜBERFÄLLIG: ' : ''}[Offen] ${label(i)}${amount}`,
            description: i.title ?? undefined,
            alarmDaysBefore: FRISTEN_ALARM_DAYS,
        });
    }
    return events;
}
