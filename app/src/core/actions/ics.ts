/**
 * Minimal iCalendar (RFC 5545) serialization for the Fristen export — turn deadlines into all-day
 * VEVENTs a calendar app (GNOME Calendar / Evolution via an .ics import) can show, each with a
 * reminder alarm. Pure + deterministic: the caller passes `dtstamp` so the output is reproducible.
 */

export interface IcsEvent {
    /** Stable unique id (no domain needed; we append one). */
    uid: string;
    /** All-day date (YYYY-MM-DD). */
    date: string;
    summary: string;
    description?: string;
    /** Reminder N days before the date (VALARM). Omitted → no alarm. */
    alarmDaysBefore?: number;
}

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
function esc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** YYYY-MM-DD → YYYYMMDD (DATE value). */
function dateValue(iso: string): string {
    return iso.replace(/-/g, '');
}

/** The day after `iso` (YYYY-MM-DD) as a DATE value — the exclusive DTEND of an all-day event. */
function nextDayValue(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Fold a content line to ≤ 75 octets per RFC 5545 §3.1 (continuation lines start with a space).
 * We fold on character count (good enough for our ASCII-ish content) to keep it dependency-free.
 */
function fold(line: string): string {
    if (line.length <= 75) return line;
    const parts: string[] = [line.slice(0, 75)];
    let rest = line.slice(75);
    while (rest.length > 74) {
        parts.push(` ${rest.slice(0, 74)}`);
        rest = rest.slice(74);
    }
    parts.push(` ${rest}`);
    return parts.join('\r\n');
}

/**
 * Serialize events to an iCalendar string (CRLF line endings). `dtstamp` is a UTC instant
 * (YYYYMMDDTHHMMSSZ) supplied by the caller so the result is deterministic/testable.
 */
export function buildIcs(events: IcsEvent[], opts: { dtstamp: string; prodId?: string; calName?: string }): string {
    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${opts.prodId ?? '-//JumpLink//steuererklaerung//Fristen//DE'}`,
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
    ];
    if (opts.calName) lines.push(`X-WR-CALNAME:${esc(opts.calName)}`);
    for (const e of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${esc(e.uid)}@steuererklaerung`);
        lines.push(`DTSTAMP:${opts.dtstamp}`);
        lines.push(`DTSTART;VALUE=DATE:${dateValue(e.date)}`);
        lines.push(`DTEND;VALUE=DATE:${nextDayValue(e.date)}`);
        lines.push(`SUMMARY:${esc(e.summary)}`);
        if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
        if (e.alarmDaysBefore != null && e.alarmDaysBefore > 0) {
            lines.push('BEGIN:VALARM');
            lines.push('ACTION:DISPLAY');
            lines.push(`DESCRIPTION:${esc(e.summary)}`);
            lines.push(`TRIGGER:-P${e.alarmDaysBefore}D`);
            lines.push('END:VALARM');
        }
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}
