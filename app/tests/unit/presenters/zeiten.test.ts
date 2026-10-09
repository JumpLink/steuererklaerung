import { describe, expect, it } from '@gjsify/unit';
import type { TimeEntry } from '@steuererklaerung/store';
import type { Project } from '../../../src/core/config/index.ts';
import { buildTimeDays, buildTimeRow, timeRowStatus } from '../../../src/core/presenters/zeiten.ts';

function entry(over: Partial<TimeEntry>): TimeEntry {
    return {
        id: 'e1',
        entityId: 'gbr',
        contactId: null,
        project: 'Relaunch',
        projectId: null,
        description: null,
        startedAt: new Date(2026, 9, 6, 9, 0).toISOString(),
        endedAt: new Date(2026, 9, 6, 10, 0).toISOString(),
        durationSeconds: 3600,
        billable: true,
        invoiceId: null,
        source: 'manual',
        externalId: null,
        note: null,
        ...over,
    } as TimeEntry;
}

const project = { id: 'p1', name: 'Neuer Name' } as Project;
const names = new Map([['c1', 'Kunde A']]);
const NOW = new Date(2026, 9, 6, 15, 0);

export default async () => {
    await describe('presenters/zeiten — status', async () => {
        await it('billed wins over everything else', async () => {
            expect(timeRowStatus({ invoiceId: 'inv', billable: false })).toBe('billed');
        });
        await it('unbilled + billable is open, unbillable is internal', async () => {
            expect(timeRowStatus({ invoiceId: null, billable: true })).toBe('open');
            expect(timeRowStatus({ invoiceId: null, billable: false })).toBe('internal');
        });
        await it('ignores a "NICHT BERECHNET" text prefix and keeps the text untouched', async () => {
            const text = 'NICHT BERECHNET: Abstimmung';
            const row = buildTimeRow(entry({ description: text }), [], names);
            expect(row.status).toBe('open');
            expect(row.title).toBe(text);
        });
    });

    await describe('presenters/zeiten — row', async () => {
        await it('uses the project label when there is no description', async () => {
            expect(buildTimeRow(entry({}), [], names).title).toBe('Relaunch');
        });
        await it('resolves the project name through projectId', async () => {
            const row = buildTimeRow(entry({ projectId: 'p1' }), [project], names);
            expect(row.project).toBe('Neuer Name');
        });
        await it('shows the customer only when the project does not already name them', async () => {
            expect(buildTimeRow(entry({ contactId: 'c1' }), [], names).customer).toBe('Kunde A');
            expect(buildTimeRow(entry({ contactId: 'c1', project: 'Kunde A Relaunch' }), [], names).customer).toBe(
                null,
            );
            expect(buildTimeRow(entry({ contactId: 'zz' }), [], names).customer).toBe(null);
        });
        await it('formats time and duration, flags estimates, locks billed rows', async () => {
            const row = buildTimeRow(entry({ source: 'reconstructed', invoiceId: 'inv' }), [], names);
            expect(row.time).toBe('09:00');
            expect(row.duration).toBe('01:00:00');
            expect(row.estimated).toBe(true);
            expect(row.editable).toBe(false);
        });
    });

    await describe('presenters/zeiten — days', async () => {
        const yesterday = (h: number) => new Date(2026, 9, 5, h, 0).toISOString();
        const older = new Date(2026, 9, 1, 8, 0).toISOString();
        const entries = [
            entry({ id: 'a', durationSeconds: 1800 }),
            entry({ id: 'b', startedAt: yesterday(9), durationSeconds: 3600 }),
            entry({ id: 'c', startedAt: yesterday(14), durationSeconds: 900 }),
            entry({ id: 'd', startedAt: older, durationSeconds: 60 }),
            entry({ id: 'run', endedAt: null, durationSeconds: null }),
        ];
        const days = buildTimeDays(entries, [], names, NOW);

        await it('groups newest day first and skips running entries', async () => {
            expect(days.map((d) => d.day).join()).toBe('2026-10-06,2026-10-05,2026-10-01');
            expect(days.flatMap((d) => d.rows).some((r) => r.entry.id === 'run')).toBe(false);
        });
        await it('marks today and yesterday', async () => {
            expect(days.map((d) => d.relative ?? '-').join()).toBe('today,yesterday,-');
        });
        await it('sums each day and orders its entries newest first', async () => {
            expect(days[1].seconds).toBe(4500);
            expect(days[1].total).toBe('01:15:00');
            expect(days[1].rows.map((r) => r.entry.id).join()).toBe('c,b');
        });
    });
};
