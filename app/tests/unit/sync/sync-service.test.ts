import { describe, it, expect } from '@gjsify/unit';
import { DEFAULT_SYNC_SCHEDULE, type SyncEntityInfo, type SyncSource } from '../../../src/core/sync/plan.ts';
import { createSyncService, type SyncRunner } from '../../../src/core/sync/service.ts';
import { createRunners, invoiceFingerprint } from '../../../src/core/sync/runners.ts';
import type { OutgoingInvoiceSummary } from '../../../src/core/invoices/provider.ts';

const entity: SyncEntityInfo = { id: 'demo', hasQontoAccount: true, invoicingViaQonto: true, usesPaperless: true };

const inv = (over: Partial<OutgoingInvoiceSummary> = {}): OutgoingInvoiceSummary => ({
    id: 'i1',
    number: 'R-1',
    status: 'unpaid',
    clientId: null,
    customerName: null,
    issueDate: '2026-01-01',
    dueDate: null,
    total: 10,
    currency: 'EUR',
    url: null,
    provider: 'qonto',
    ...over,
});

function harness(runners: Partial<Record<SyncSource, SyncRunner>> = {}) {
    const calls: SyncSource[] = [];
    const clock = { t: 0 };
    const mk =
        (s: SyncSource, changed = true): SyncRunner =>
        async () => {
            calls.push(s);
            return { changed };
        };
    const service = createSyncService({
        runners: {
            'qonto-invoices': mk('qonto-invoices'),
            'qonto-transactions': mk('qonto-transactions'),
            paperless: mk('paperless'),
            ...runners,
        },
        schedule: () => DEFAULT_SYNC_SCHEDULE,
        now: () => clock.t,
    });
    return { service, calls, clock };
}

export default async () => {
    await describe('sync service', async () => {
        await it('runs the open view first and reports what changed', async () => {
            const { service, calls } = harness();
            const r = await service.run({ entity, view: 'transactions', trigger: 'manual' });
            expect(JSON.stringify(calls)).toBe(JSON.stringify(['qonto-transactions', 'qonto-invoices', 'paperless']));
            expect(r.changed.length).toBe(3);
        });

        await it('merges a second call into the running run', async () => {
            let release: () => void = () => {};
            const gate = new Promise<void>((res) => (release = res));
            const { service, calls } = harness({
                'qonto-invoices': async () => {
                    calls.push('qonto-invoices');
                    await gate;
                    return { changed: false };
                },
            });
            const a = service.run({ entity, view: 'rechnungen', trigger: 'manual' });
            const b = service.run({ entity, view: 'rechnungen', trigger: 'manual' });
            expect(service.status().running).toBe(true);
            expect(await service.tick({ entity })).toBe(null);
            release();
            const [ra, rb] = await Promise.all([a, b]);
            expect(ra).toBe(rb);
            expect(calls.filter((c) => c === 'qonto-invoices').length).toBe(1);
            expect(service.status().running).toBe(false);
        });

        await it('records a failure, continues, and clears it on a clean run', async () => {
            let fail = true;
            const { service, clock } = harness({
                'qonto-invoices': async () => {
                    if (fail) throw new Error('boom');
                    return { changed: false };
                },
            });
            clock.t = 5;
            const r = await service.run({ entity, view: 'rechnungen', trigger: 'manual' });
            expect(r.ran.length).toBe(3);
            expect(r.failures.length).toBe(1);
            expect(service.status('demo').lastError?.message).toBe('boom');
            fail = false;
            clock.t = 10;
            await service.run({ entity, trigger: 'manual' });
            expect(service.status('demo').lastError).toBe(undefined);
            expect(service.status('demo').lastSuccessAt).toBe(10);
        });

        await it('ticks only what is due, with the fake clock', async () => {
            const { service, calls, clock } = harness();
            await service.tick({ entity });
            expect(calls.length).toBe(3);
            clock.t = 10 * 60_000;
            expect(await service.tick({ entity })).toBe(null);
            clock.t = 15 * 60_000;
            const r = await service.tick({ entity });
            expect(JSON.stringify(r?.ran)).toBe(JSON.stringify(['qonto-invoices']));
        });

        await it('keeps history, success and error per entity', async () => {
            let fail = true;
            const { service, calls, clock } = harness({
                'qonto-invoices': async () => {
                    if (fail) throw new Error('boom');
                    return { changed: false };
                },
            });
            const other: SyncEntityInfo = { ...entity, id: 'other' };
            clock.t = 1;
            await service.run({ entity, trigger: 'manual' });
            expect(service.status('demo').lastError?.message).toBe('boom');
            expect(service.status('other').lastError).toBe(undefined);
            expect(service.status('other').lastSuccessAt).toBe(undefined);
            // A synced, B never synced: B is due at once, and A's failure backoff does not apply to it.
            const before = calls.length;
            const r = await service.tick({ entity: other });
            expect(r?.ran.length).toBe(3);
            // the overridden invoices runner does not record into `calls`
            expect(calls.length).toBe(before + 2);
            expect(await service.tick({ entity })).toBe(null);
        });

        await it('runs a click for another entity after the running one', async () => {
            let release: () => void = () => {};
            const gate = new Promise<void>((res) => (release = res));
            const ran: string[] = [];
            const service = createSyncService({
                runners: {
                    'qonto-invoices': async (e) => {
                        ran.push(e.id);
                        if (e.id === 'demo') await gate;
                        return { changed: false };
                    },
                    'qonto-transactions': async () => ({ changed: false }),
                    paperless: async () => ({ changed: false }),
                },
                schedule: () => DEFAULT_SYNC_SCHEDULE,
                now: () => 0,
            });
            const other: SyncEntityInfo = { ...entity, id: 'other' };
            const a = service.run({ entity, trigger: 'manual' });
            const b = service.run({ entity: other, trigger: 'manual' });
            const b2 = service.run({ entity: other, trigger: 'manual' });
            expect(b2).toBe(b);
            expect(ran.length).toBe(1);
            release();
            await Promise.all([a, b]);
            expect(ran.join(',')).toBe('demo,other');
            expect(service.status().running).toBe(false);
        });

        await it('notifies subscribers while running', async () => {
            const { service } = harness();
            const seen: boolean[] = [];
            service.subscribe(() => seen.push(service.status().running));
            await service.run({ entity, trigger: 'manual' });
            expect(seen[0]).toBe(true);
            expect(seen[seen.length - 1]).toBe(false);
        });
    });

    await describe('sync runners', async () => {
        await it('reconciles lastInvoice and flags a changed invoice list', async () => {
            let list = [inv()];
            let reconciled = 0;
            const runners = createRunners({
                listInvoices: async () => list,
                reconcile: async () => {
                    reconciled++;
                    return { rewritten: false };
                },
                syncQonto: async () => ({ added: 0, updated: 0 }),
                listDocumentIds: async () => [],
            });
            expect((await runners['qonto-invoices'](entity)).changed).toBe(true); // first sight
            expect((await runners['qonto-invoices'](entity)).changed).toBe(false);
            list = [inv({ status: 'paid' })];
            expect((await runners['qonto-invoices'](entity)).changed).toBe(true);
            expect(reconciled).toBe(3);
        });

        await it('turns a Qonto transaction error into a failure', async () => {
            const runners = createRunners({
                listInvoices: async () => [],
                reconcile: async () => ({ rewritten: false }),
                syncQonto: async () => ({ added: 0, updated: 0, error: 'HTTP 429' }),
                listDocumentIds: async () => [],
            });
            let message = '';
            try {
                await runners['qonto-transactions'](entity);
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toBe('HTTP 429');
        });

        await it('fingerprints what the user sees', async () => {
            expect(invoiceFingerprint([inv()])).not.toBe(invoiceFingerprint([inv({ number: 'R-2' })]));
        });
    });
};
