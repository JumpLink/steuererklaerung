import { describe, it, expect } from '@gjsify/unit';
import {
    listEntityReminders,
    markReminderSent,
    migrate,
    openLedger,
    recordReminderDraft,
    type InvoiceReminderKey,
} from '@steuererklaerung/store';

const key: InvoiceReminderKey = { entityId: 'demo', invoiceId: 'inv-1', invoiceNumber: 'RE-0001', stage: 1 };

export default async () => {
    await describe('invoice reminders', async () => {
        await it('a draft is stored without a sent date; marking it sent adds the date and keeps the draft', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            recordReminderDraft(db, key, '2026-10-09T08:00:00.000Z');
            let rows = listEntityReminders(db, 'demo');
            expect(rows.length).toBe(1);
            expect(rows[0].stage).toBe(1);
            expect(rows[0].sentAt).toBe(null);
            expect(rows[0].draftedAt).toBe('2026-10-09T08:00:00.000Z');

            markReminderSent(db, key, '2026-10-09', '2026-10-09T09:00:00.000Z');
            rows = listEntityReminders(db, 'demo');
            expect(rows.length).toBe(1);
            expect(rows[0].sentAt).toBe('2026-10-09');
            expect(rows[0].draftedAt).toBe('2026-10-09T08:00:00.000Z');

            // Drafting the same stage again must not take the confirmation back.
            recordReminderDraft(db, key, '2026-10-10T08:00:00.000Z');
            expect(listEntityReminders(db, 'demo')[0].sentAt).toBe('2026-10-09');
            db.close();
        });

        await it('one row per (entity, invoice, stage); other entities stay apart; the log records both steps', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            markReminderSent(db, key, '2026-09-01', '2026-09-01T10:00:00.000Z');
            markReminderSent(db, { ...key, stage: 2 }, '2026-09-20', '2026-09-20T10:00:00.000Z');
            markReminderSent(db, { ...key, entityId: 'other' }, '2026-09-02', '2026-09-02T10:00:00.000Z');
            expect(listEntityReminders(db, 'demo').map((r) => r.stage)).toStrictEqual([1, 2]);
            expect(listEntityReminders(db, 'other').length).toBe(1);
            const log = db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'mahnung.%'`).all() as { action: string }[];
            expect(log.length).toBe(3);
            db.close();
        });

        await it('refuses a stage outside 1–3', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            let message = '';
            try {
                recordReminderDraft(db, { ...key, stage: 4 as 3 }, '2026-10-09T08:00:00.000Z');
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toBe('Mahnstufe 4 gibt es nicht (1–3).');
            expect(listEntityReminders(db, 'demo').length).toBe(0);
            db.close();
        });
    });
};
