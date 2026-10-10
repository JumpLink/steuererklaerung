import { describe, expect, it } from '@gjsify/unit';
import type { OpenItem } from '../../../src/core/actions/fristen.ts';
import { buildFristenIcsEvents, buildFristenReminder } from '../../../src/core/actions/fristen-reminder.ts';
import { buildIcs } from '../../../src/core/actions/ics.ts';

function item(over: Partial<OpenItem> = {}): OpenItem {
    return {
        id: 1,
        title: 'Rechnung 2026-001',
        correspondent: 'Beispiel GmbH',
        amount: 119,
        dueDate: '2026-10-01',
        daysUntil: -9,
        overdue: true,
        dataScope: null,
        ...over,
    };
}

export default async () => {
    await describe('Fristen-Wächter: Erinnerung', async () => {
        await it('schweigt als null, wenn nichts im Vorlauf liegt oder nichts datiert ist', () => {
            const reminder = buildFristenReminder([
                item({ id: 1, daysUntil: 30, overdue: false, dueDate: '2026-11-09' }),
                item({ id: 2, daysUntil: null, overdue: false, dueDate: null }),
            ]);
            expect(reminder).toBe(null);
            expect(buildFristenReminder([])).toBe(null);
        });

        await it('zählt überfällige und bald fällige, überfällige zuerst', () => {
            const reminder = buildFristenReminder([
                item({ id: 2, dueDate: '2026-10-14', daysUntil: 4, overdue: false }),
                item({ id: 1 }),
            ]);
            expect(reminder?.items.map((i) => i.id).join(',')).toBe('1,2');
            expect(reminder?.overdue).toBe(1);
            expect(reminder?.dueSoon).toBe(1);
            expect(reminder?.title).toBe('2 Fristen, 1 überfällig, 1 in 7 Tagen oder früher');
            expect(reminder?.lines[0].startsWith('ÜBERFÄLLIG  2026-10-01')).toBe(true);
            expect(reminder?.body.includes('Beispiel GmbH — Rechnung 2026-001')).toBe(true);
        });

        await it('respektiert den Vorlauf', () => {
            const items = [item({ dueDate: '2026-10-17', daysUntil: 7, overdue: false })];
            expect(buildFristenReminder(items, { leadDays: 3 })).toBe(null);
            expect(buildFristenReminder(items, { leadDays: 7 })?.items.length).toBe(1);
        });

        await it('kürzt lange Listen', () => {
            const many = Array.from({ length: 8 }, (_, n) => item({ id: n + 1 }));
            const reminder = buildFristenReminder(many);
            expect(reminder?.lines.length).toBe(6);
            expect(reminder?.lines[5]).toBe('… und 3 weitere');
        });
    });

    await describe('Fristen-Wächter: Kalender', async () => {
        await it('schreibt ein Ereignis je datiertem Posten, mit stabiler UID aus der Paperless-ID', () => {
            const events = buildFristenIcsEvents([
                item({ id: 42 }),
                item({ id: 43, dueDate: null, daysUntil: null, overdue: false }),
            ]);
            expect(events.length).toBe(1);
            expect(events[0].uid).toBe('openitem-42');
            expect(events[0].date).toBe('2026-10-01');
            expect(events[0].summary.startsWith('ÜBERFÄLLIG: ')).toBe(true);
            expect(events[0].alarmDaysBefore).toBe(3);
        });

        await it('markiert nicht überfällige Posten nicht und liefert ein VALARM 3 Tage vorher', () => {
            const events = buildFristenIcsEvents([item({ dueDate: '2026-10-20', daysUntil: 10, overdue: false })]);
            expect(events[0].summary.startsWith('ÜBERFÄLLIG')).toBe(false);
            const ics = buildIcs(events, { dtstamp: '20261010T000000Z' });
            expect(ics.includes('TRIGGER:-P3D')).toBe(true);
            expect(ics.includes('DTSTART;VALUE=DATE:20261020')).toBe(true);
            expect(ics.includes('UID:openitem-1@steuererklaerung')).toBe(true);
        });
    });
};
