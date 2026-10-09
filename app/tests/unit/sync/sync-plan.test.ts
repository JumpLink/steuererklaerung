import { describe, it, expect } from '@gjsify/unit';
import {
    applicableSources,
    affectsView,
    DEFAULT_SYNC_SCHEDULE,
    dueSources,
    intervalMinutes,
    prioritize,
    type SyncEntityInfo,
} from '../../../src/core/sync/plan.ts';

const entity = (over: Partial<SyncEntityInfo> = {}): SyncEntityInfo => ({
    id: 'demo',
    hasQontoAccount: true,
    invoicingViaQonto: true,
    usesPaperless: true,
    ...over,
});

export default async () => {
    await describe('sync plan', async () => {
        await it('uses Qonto only for an entity with a qonto: account', async () => {
            expect(JSON.stringify(applicableSources(entity()))).toBe(
                JSON.stringify(['qonto-invoices', 'qonto-transactions', 'paperless']),
            );
            expect(JSON.stringify(applicableSources(entity({ hasQontoAccount: false })))).toBe(
                JSON.stringify(['paperless']),
            );
            expect(JSON.stringify(applicableSources(entity({ invoicingViaQonto: false })))).toBe(
                JSON.stringify(['qonto-transactions', 'paperless']),
            );
            expect(JSON.stringify(applicableSources(entity({ hasQontoAccount: false, usesPaperless: false })))).toBe(
                JSON.stringify([]),
            );
        });

        await it('puts the source of the open view first', async () => {
            const all = applicableSources(entity());
            expect(prioritize('rechnungen', all)[0]).toBe('qonto-invoices');
            expect(JSON.stringify(prioritize('transactions', all))).toBe(
                JSON.stringify(['qonto-transactions', 'qonto-invoices', 'paperless']),
            );
            expect(prioritize('review', all)[0]).toBe('paperless');
            expect(JSON.stringify(prioritize('settings', all))).toBe(JSON.stringify(all));
        });

        await it('never adds a source the entity does not have', async () => {
            expect(JSON.stringify(prioritize('rechnungen', ['paperless']))).toBe(JSON.stringify(['paperless']));
        });

        await it('reloads a view only when its sources changed', async () => {
            expect(affectsView('rechnungen', ['qonto-invoices'])).toBe(true);
            expect(affectsView('rechnungen', ['paperless'])).toBe(false);
            expect(affectsView('settings', ['paperless'])).toBe(false);
        });

        await it('is due at the first run, then after the interval', async () => {
            const all = applicableSources(entity());
            const s = DEFAULT_SYNC_SCHEDULE;
            expect(JSON.stringify(dueSources(0, {}, s, all))).toBe(JSON.stringify(all));
            const t0 = 1_000_000;
            const history = { 'qonto-invoices': { lastAttemptAt: t0, failures: 0 } };
            expect(JSON.stringify(dueSources(t0 + 14 * 60_000, history, s, ['qonto-invoices']))).toBe(
                JSON.stringify([]),
            );
            expect(JSON.stringify(dueSources(t0 + 15 * 60_000, history, s, ['qonto-invoices']))).toBe(
                JSON.stringify(['qonto-invoices']),
            );
        });

        await it('backs off after failures, capped', async () => {
            const s = DEFAULT_SYNC_SCHEDULE;
            const t0 = 0;
            const failed = (n: number) => ({ 'qonto-invoices': { lastAttemptAt: t0, failures: n } });
            expect(JSON.stringify(dueSources(29 * 60_000, failed(1), s, ['qonto-invoices']))).toBe(JSON.stringify([]));
            expect(JSON.stringify(dueSources(30 * 60_000, failed(1), s, ['qonto-invoices']))).toBe(
                JSON.stringify(['qonto-invoices']),
            );
            // capped at 8x of 15 min = 2 h
            expect(JSON.stringify(dueSources(120 * 60_000, failed(20), s, ['qonto-invoices']))).toBe(
                JSON.stringify(['qonto-invoices']),
            );
            expect(JSON.stringify(dueSources(119 * 60_000, failed(20), s, ['qonto-invoices']))).toBe(
                JSON.stringify([]),
            );
        });

        await it('honours off switch and the rate-limit floor', async () => {
            expect(JSON.stringify(dueSources(0, {}, { ...DEFAULT_SYNC_SCHEDULE, enabled: false }, ['paperless']))).toBe(
                JSON.stringify([]),
            );
            expect(intervalMinutes({ ...DEFAULT_SYNC_SCHEDULE, transactionsMinutes: 1 }, 'qonto-transactions')).toBe(
                15,
            );
            expect(intervalMinutes({ ...DEFAULT_SYNC_SCHEDULE, paperlessMinutes: 0 }, 'paperless')).toBe(0);
        });
    });
};
