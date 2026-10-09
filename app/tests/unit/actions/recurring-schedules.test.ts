import { describe, it, expect } from '@gjsify/unit';
import {
    addMonths,
    nextPeriod,
    slugForSchedule,
    uniqueScheduleId,
} from '../../../src/core/actions/recurring-schedules.ts';

export default async () => {
    await describe('recurring schedule maths', async () => {
        await it('advances a yearly period by MONTHS, not by 365 days', async () => {
            // Adding days drifts by one every leap year: a schedule starting 1 February would
            // eventually bill from 31 January, and the period boundaries stop matching the contract.
            expect(nextPeriod({ start: '2025-02-01', end: '2026-01-31' }, 12)).toStrictEqual({
                start: '2026-02-01',
                end: '2027-01-31',
            });
        });

        await it('makes consecutive periods touch without overlapping', async () => {
            // An overlap bills one day twice — on a yearly hosting invoice that is a real dispute.
            const first = { start: '2025-01-01', end: '2025-03-31' };
            const second = nextPeriod(first, 3);
            expect(second.start).toBe('2025-04-01');
            expect(second.end).toBe('2025-06-30');
            expect(nextPeriod(second, 3).start).toBe('2025-07-01');
        });

        await it('clamps a day that the target month does not have', async () => {
            expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
            expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
            expect(addMonths('2025-03-31', 1)).toBe('2025-04-30');
        });

        await it('builds a readable id from customer and description', async () => {
            expect(slugForSchedule('Musterkunde GmbH & Co. KG', 'Hosting example.com')).toBe(
                'musterkunde-gmbh-co-kg-hosting-example-com',
            );
            expect(slugForSchedule('Müller & Söhne')).toBe('mueller-soehne');
            // Never empty: an id is what the reminder and the manifest are read by.
            expect(slugForSchedule('———')).toBe('rechnung');
        });

        await it('suffixes a taken id instead of refusing', async () => {
            // Being asked to invent a unique id is not a task for someone who just wants to bill
            // their customer again next year.
            expect(uniqueScheduleId('hosting', [])).toBe('hosting');
            expect(uniqueScheduleId('hosting', ['hosting'])).toBe('hosting-2');
            expect(uniqueScheduleId('hosting', ['hosting', 'hosting-2'])).toBe('hosting-3');
        });
    });
};
