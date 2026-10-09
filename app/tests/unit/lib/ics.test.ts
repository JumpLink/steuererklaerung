import { describe, it, expect } from '@gjsify/unit';
import { buildIcs, type IcsEvent } from '../../../src/core/actions/ics.ts';

const STAMP = '20260704T120000Z';

export default async () => {
    await describe('buildIcs', async () => {
        const events: IcsEvent[] = [
            {
                uid: 'jumplink:ustva:2026-Q2',
                date: '2026-07-10',
                summary: '[Steuer] JumpLink: USt-VA Q2/2026',
                description: 'Regelfrist; prüfen',
                alarmDaysBefore: 7,
            },
        ];
        const ics = buildIcs(events, { dtstamp: STAMP, calName: 'Fristen' });

        await it('wraps events in a VCALENDAR with CRLF line endings', async () => {
            expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
            expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
            expect(ics).toContain('VERSION:2.0');
        });

        await it('renders an all-day event with an exclusive DTEND (next day)', async () => {
            expect(ics).toContain('DTSTART;VALUE=DATE:20260710');
            expect(ics).toContain('DTEND;VALUE=DATE:20260711');
            expect(ics).toContain('SUMMARY:[Steuer] JumpLink: USt-VA Q2/2026');
            expect(ics).toContain(`DTSTAMP:${STAMP}`);
            expect(ics).toContain('UID:jumplink:ustva:2026-Q2@steuererklaerung');
        });

        await it('adds a VALARM with a day-based trigger', async () => {
            expect(ics).toContain('BEGIN:VALARM');
            expect(ics).toContain('TRIGGER:-P7D');
        });

        await it('escapes TEXT special characters (comma, semicolon)', async () => {
            const out = buildIcs([{ uid: 'x', date: '2026-01-01', summary: 'A, B; C' }], { dtstamp: STAMP });
            expect(out).toContain('SUMMARY:A\\, B\\; C');
        });

        await it('handles a year-end date rollover in DTEND', async () => {
            const out = buildIcs([{ uid: 'y', date: '2026-12-31', summary: 'Jahresende' }], { dtstamp: STAMP });
            expect(out).toContain('DTSTART;VALUE=DATE:20261231');
            expect(out).toContain('DTEND;VALUE=DATE:20270101');
        });
    });
};
