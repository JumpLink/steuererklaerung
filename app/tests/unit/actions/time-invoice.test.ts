import { describe, expect, it } from '@gjsify/unit';
import type { TimeEntry } from '@steuererklaerung/store';
import { buildTimeInvoice, describeEntries, roundSecondsUp } from '../../../src/core/actions/time-invoice.ts';

function entry(over: Partial<TimeEntry> = {}): TimeEntry {
    return {
        id: `t_${Math.random().toString(16).slice(2)}`,
        entityId: 'jumplink',
        contactId: 'c_kunde',
        project: 'Nordwerk',
        projectId: null,
        description: null,
        startedAt: '2026-08-12T08:00:00Z',
        endedAt: '2026-08-12T09:00:00Z',
        durationSeconds: 3600,
        billable: true,
        invoiceId: null,
        source: 'manual',
        externalId: null,
        note: null,
        createdAt: '2026-08-12T09:00:00Z',
        updatedAt: '2026-08-12T09:00:00Z',
        ...over,
    };
}

const TERMS = { hourlyRate: 100, vatRate: 0.19, roundToMinutes: 0 };

export default async () => {
    await describe('roundSecondsUp', async () => {
        await it('leaves the value alone without a step', async () => {
            expect(roundSecondsUp(3661, 0)).toBe(3661);
            expect(roundSecondsUp(3661, undefined)).toBe(3661);
        });

        await it('rounds UP to the next multiple, never down', async () => {
            expect(roundSecondsUp(60, 15)).toBe(900);
            expect(roundSecondsUp(901, 15)).toBe(1800);
            // An exact multiple must not jump a step — otherwise every full hour becomes 1.25 h.
            expect(roundSecondsUp(1800, 15)).toBe(1800);
        });
    });

    await describe('buildTimeInvoice', async () => {
        await it('makes one line per project and sums its entries', async () => {
            const built = buildTimeInvoice(
                [
                    entry({ project: 'Nordwerk', durationSeconds: 3600 }),
                    entry({ project: 'Nordwerk', durationSeconds: 1800 }),
                    entry({ project: 'Leuchtturm', durationSeconds: 900 }),
                ],
                TERMS,
            );
            expect(built.items.length).toBe(2);
            const posten = built.items.find((i) => i.title === 'Nordwerk');
            expect(posten?.quantity).toBe(1.5);
            expect(posten?.unitPriceNet).toBe(100);
            expect(posten?.unit).toBe('Std');
            expect(built.lines.find((l) => l.project === 'Nordwerk')?.entries).toBe(2);
        });

        await it('rounds the PROJECT total, not each entry', async () => {
            // Three five-minute fixes = 15 min. Per entry they would round to 3 × 15 = 45 min.
            const built = buildTimeInvoice(
                [entry({ durationSeconds: 300 }), entry({ durationSeconds: 300 }), entry({ durationSeconds: 300 })],
                { ...TERMS, roundToMinutes: 15 },
            );
            expect(built.lines[0].seconds).toBe(900);
            expect(built.items[0].quantity).toBe(0.25);
        });

        await it('derives the Leistungszeitraum from the entries', async () => {
            const built = buildTimeInvoice(
                [
                    entry({ startedAt: '2026-08-04T07:00:00Z', endedAt: '2026-08-04T11:00:00Z' }),
                    entry({ startedAt: '2026-07-20T18:00:00Z', endedAt: '2026-07-20T19:00:00Z' }),
                ],
                TERMS,
            );
            expect(built.performanceStart).toBe('2026-07-20');
            expect(built.performanceEnd).toBe('2026-08-04');
        });

        await it('refuses to build an empty invoice', async () => {
            let threw = false;
            try {
                buildTimeInvoice([], TERMS);
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });
    });

    await describe('describeEntries', async () => {
        await it('lists the sessions oldest first so the line can be checked', async () => {
            const text = describeEntries([
                entry({ startedAt: '2026-08-12T08:00:00Z', durationSeconds: 3600, description: 'Zweitens' }),
                entry({ startedAt: '2026-08-11T08:00:00Z', durationSeconds: 1800, description: 'Erstens' }),
            ]);
            const lines = text.split('\n');
            expect(lines[0].includes('Erstens')).toBe(true);
            expect(lines[1].includes('Zweitens')).toBe(true);
            expect(lines[1].includes('01:00:00')).toBe(true);
        });

        await it('omits a missing description instead of printing an empty dash', async () => {
            const text = describeEntries([entry({ description: null, durationSeconds: 3600 })]);
            expect(text.includes('—')).toBe(false);
        });
    });
};
