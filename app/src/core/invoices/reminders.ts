/**
 * Active reminders for recurring invoices — without any auto-send:
 *  - {@link buildIcs} renders a subscribable iCalendar feed (VEVENT + VALARM) so GNOME Calendar
 *    or a phone actively notifies before each invoice is due. Portable, no GJS/EDS write needed.
 *
 * The cover-email draft lives in `core/mail/invoice-mail.ts`; {@link buildIcs} is a pure string
 * builder (no I/O) so the caller decides where the output goes.
 */

import { fmtDe } from '../lib/money.ts';
import type { RecurringDueEntry } from './recurring.ts';

/** YYYY-MM-DD → YYYYMMDD (iCal DATE value). */
function icsDate(d: string): string {
    return d.replace(/-/g, '');
}

/** Escape a text value per RFC 5545 (commas, semicolons, backslashes, newlines). */
function icsEscape(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/([,;])/g, '\\$1')
        .replace(/\n/g, '\\n');
}

/** Add one day to a YYYYMMDD string (for the all-day DTEND, which is exclusive). */
function nextDay(yyyymmdd: string): string {
    const y = Number(yyyymmdd.slice(0, 4));
    const m = Number(yyyymmdd.slice(4, 6));
    const d = Number(yyyymmdd.slice(6, 8));
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
}

export interface IcsOptions {
    /** DTSTAMP date (YYYY-MM-DD); defaults to today. Pass a fixed value for reproducible output. */
    stamp?: string;
    /** Calendar name shown by subscribers. */
    calendarName?: string;
}

/**
 * Render an iCalendar document with one all-day VEVENT per schedule on its due date, each with a
 * DISPLAY VALARM firing `reminderLeadDays` ahead. Subscribe to the written .ics in GNOME Calendar
 * (or import it) to get active notifications.
 */
export function buildIcs(entries: Array<RecurringDueEntry & { leadDays?: number }>, opts: IcsOptions = {}): string {
    const stamp = `${icsDate(opts.stamp ?? new Date().toISOString().slice(0, 10))}T000000Z`;
    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//JumpLink//steuererklaerung recurring-invoices//DE',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape(opts.calendarName ?? 'Wiederkehrende Rechnungen')}`,
    ];
    for (const e of entries) {
        const start = icsDate(e.dueDate);
        const lead = e.leadDays ?? 28;
        const summary = `Rechnung fällig: ${e.customer} — ${fmtDe(e.totals.gross)} ${e.currency}`;
        const what = e.description ?? e.domains.join(', ');
        const desc = [
            what,
            `Leistungszeitraum ${e.period.start} – ${e.period.end}`,
            e.lastInvoiceNumber ? `Letzte Rechnung ${e.lastInvoiceNumber}` : '',
            `Erstellen: steuer invoices recurring create ${e.id}`,
        ]
            .filter(Boolean)
            .join('\n');
        lines.push(
            'BEGIN:VEVENT',
            `UID:recurring-${e.id}-${start}@steuererklaerung.jumplink`,
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${start}`,
            `DTEND;VALUE=DATE:${nextDay(start)}`,
            `SUMMARY:${icsEscape(summary)}`,
            `DESCRIPTION:${icsEscape(desc)}`,
            'TRANSP:TRANSPARENT',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `TRIGGER:-P${lead}D`,
            `DESCRIPTION:${icsEscape(summary)}`,
            'END:VALARM',
            'END:VEVENT',
        );
    }
    lines.push('END:VCALENDAR');
    // RFC 5545 mandates CRLF line endings.
    return `${lines.join('\r\n')}\r\n`;
}
