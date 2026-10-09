import { describe, expect, it } from '@gjsify/unit';
import type { RecurringInvoice } from '../../../src/core/config/index.ts';
import {
    addMonths,
    advanceSchedule,
    computeItemTotals,
    computeRecurringInvoiceDashboard,
    daysBetween,
    isActionable,
    toDueEntry,
} from '../../../src/core/invoices/recurring.ts';
import { buildIcs } from '../../../src/core/invoices/reminders.ts';

/** Minimal valid schedule for tests (post-parse shape — all fields present). */
function makeInv(overrides: Partial<RecurringInvoice> = {}): RecurringInvoice {
    return {
        id: 'test',
        entityId: 'jumplink',
        status: 'active',
        customer: { name: 'Test Kunde' },
        description: 'Website Hosting test.de',
        domains: ['test.de'],
        intervalMonths: 12,
        nextPeriod: { start: '2026-07-08', end: '2027-07-07' },
        reminderLeadDays: 28,
        currency: 'EUR',
        items: [{ title: 'Website Hosting | Basic', quantity: 1, unitPrice: 108, vatRate: 19 }],
        ...overrides,
    };
}

export default async () => {
    await describe('computeItemTotals', async () => {
        await it('computes net/vat/gross for a single 19% item', async () => {
            const t = computeItemTotals([{ title: 'X', quantity: 1, unitPrice: 108, vatRate: 19 }]);
            expect(`${t.net}/${t.vat}/${t.gross}`).toBe('108/20.52/128.52');
        });

        await it('sums multiple items', async () => {
            const t = computeItemTotals([
                { title: 'A', quantity: 1, unitPrice: 108, vatRate: 19 },
                { title: 'B', quantity: 1, unitPrice: 14, vatRate: 19 },
            ]);
            expect(`${t.net}/${t.vat}/${t.gross}`).toBe('122/23.18/145.18');
        });

        await it('respects quantity and decimal-string prices', async () => {
            const t = computeItemTotals([{ title: 'C', quantity: 12, unitPrice: '19,00', vatRate: '0.19' }]);
            expect(`${t.net}/${t.vat}/${t.gross}`).toBe('228/43.32/271.32');
        });
    });

    await describe('date helpers', async () => {
        await it('addMonths advances a year', async () => {
            expect(addMonths('2026-07-08', 12)).toBe('2027-07-08');
        });
        await it('addMonths clamps to the shorter target month', async () => {
            expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
        });
        await it('daysBetween is signed', async () => {
            expect(daysBetween('2026-06-25', '2026-07-08')).toBe(13);
            expect(daysBetween('2026-06-25', '2026-01-01')).toBe(-175);
        });
    });

    await describe('advanceSchedule', async () => {
        await it('records the issued invoice and rolls the period forward', async () => {
            const inv = makeInv();
            const next = advanceSchedule(inv, { number: 'RE-1', issueDate: '2026-07-08' });
            expect(next.lastInvoice?.number).toBe('RE-1');
            expect(JSON.stringify(next.lastInvoice?.period)).toBe('{"start":"2026-07-08","end":"2027-07-07"}');
            expect(JSON.stringify(next.nextPeriod)).toBe('{"start":"2027-07-08","end":"2028-07-07"}');
            expect(next.nextDueDate).toBe('2027-07-08');
        });
    });

    await describe('dashboard classification', async () => {
        const today = '2026-06-25';
        await it('flags overdue, due-soon and upcoming', async () => {
            const overdue = toDueEntry(makeInv({ nextPeriod: { start: '2026-01-01', end: '2026-12-31' } }), { today });
            const dueSoon = toDueEntry(makeInv({ nextPeriod: { start: '2026-07-08', end: '2027-07-07' } }), { today });
            const upcoming = toDueEntry(makeInv({ nextPeriod: { start: '2026-09-04', end: '2027-09-03' } }), { today });
            expect(overdue.status).toBe('overdue');
            expect(dueSoon.status).toBe('due-soon');
            expect(upcoming.status).toBe('upcoming');
            expect(isActionable(overdue)).toBe(true);
            expect(isActionable(dueSoon)).toBe(true);
            expect(isActionable(upcoming)).toBe(false);
        });

        await it('honours paused/cancelled status', async () => {
            const paused = toDueEntry(makeInv({ status: 'paused' }), { today });
            const cancelled = toDueEntry(makeInv({ status: 'cancelled' }), { today });
            expect(paused.status).toBe('paused');
            expect(cancelled.status).toBe('cancelled');
            expect(isActionable(paused)).toBe(false);
        });

        await it('sorts overdue first, then by due date', async () => {
            const list = computeRecurringInvoiceDashboard(
                [
                    makeInv({ id: 'b', nextPeriod: { start: '2026-07-08', end: '2027-07-07' } }),
                    makeInv({ id: 'a', nextPeriod: { start: '2026-01-01', end: '2026-12-31' } }),
                ],
                { today },
            );
            expect(list.map((e) => e.id).join(',')).toBe('a,b');
        });
    });

    await describe('buildIcs', async () => {
        await it('renders a VCALENDAR with a VALARM at the schedule lead', async () => {
            const entry = toDueEntry(makeInv(), { today: '2026-06-25' });
            const ics = buildIcs([{ ...entry, leadDays: 28 }], { stamp: '2026-06-25' });
            expect(ics).toContain('BEGIN:VCALENDAR');
            expect(ics).toContain('DTSTART;VALUE=DATE:20260708');
            expect(ics).toContain('TRIGGER:-P28D');
            expect(ics).toContain('END:VCALENDAR');
        });
    });
};
