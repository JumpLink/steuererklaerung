import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    getTimeEntry,
    ledgerDbPath,
    migrate,
    openLedger,
    upsertTimeEntry,
    type TimeEntry,
} from '@steuererklaerung/store';
import { reserveTimeForDraft } from '../../../src/core/actions/time-invoice.ts';
import { assertFinalizable } from '../../../src/core/clients/qonto/client-invoices.ts';
import { qontoFinalizeInvoice } from '../../../src/core/actions/qonto.ts';
import { RecurringInvoiceSchema } from '../../../src/core/config/schema/recurring.ts';
import { loadRecurringInvoices } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const period = { start: '2026-01-01', end: '2026-12-31' };

const schedule = RecurringInvoiceSchema.parse({
    id: 'demo-hosting',
    entityId: 'demo',
    customer: { name: 'Demo Kunde' },
    nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
    items: [{ title: 'Hosting', unitPrice: 100 }],
    lastInvoice: { number: '2026-PROFORMA', issueDate: '2026-01-05', period, providerId: 'inv-1' },
});

const qontoInvoice = (over: Record<string, unknown>) => ({
    id: 'inv-1',
    number: '2026-PROFORMA',
    status: 'draft',
    client: { id: 'client-1', name: 'Demo Kunde' },
    issue_date: '2026-01-05',
    due_date: '2026-01-20',
    currency: 'EUR',
    total_amount: { value: '119.00', currency: 'EUR' },
    performance_start_date: period.start,
    performance_end_date: period.end,
    ...over,
});

export default async () => {
    await describe('assertFinalizable', async () => {
        await it('accepts a draft', async () => {
            expect(() => assertFinalizable({ id: 'x', status: 'draft' })).not.toThrow();
        });
        await it('refuses anything else with a clear message', async () => {
            expect(() => assertFinalizable({ id: 'x', status: 'unpaid' })).toThrow();
            expect(() => assertFinalizable({ id: 'x', status: undefined })).toThrow();
        });
    });

    await describe('qontoFinalizeInvoice (Qonto fetch faked)', async () => {
        const dirs: string[] = [];
        let state: Record<string, unknown>;
        let calls: { method: string; url: string }[];

        const fakeQonto = (initial: Record<string, unknown>) => {
            state = initial;
            calls = [];
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string, init?: { method?: string }) => {
                    const method = init?.method ?? 'GET';
                    calls.push({ method, url: String(url) });
                    if (method === 'POST' && String(url).endsWith('/finalize')) {
                        state = { ...state, status: 'unpaid', number: 'RE-0001' };
                        return { ok: true, status: 200, text: async () => JSON.stringify({ client_invoice: state }) };
                    }
                    const body = String(url).includes('/client_invoices/')
                        ? { client_invoice: state }
                        : { client_invoices: [state], meta: { current_page: 1, total_pages: 1 } };
                    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
                }),
            );
        };
        const fixture = (): string => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        name: 'Demo Studio',
                        accounts: ['qonto:demo*'],
                        invoicing: { type: 'qonto' },
                        recurring: [{ ...schedule }],
                    },
                ],
            });
            dirs.push(made.dir);
            return made.path;
        };

        let ledgerBefore: string | undefined;
        beforeEach(() => {
            ledgerBefore = process.env.LEDGER_DB_PATH;
            process.env.QONTO_ENV = 'production';
            process.env.QONTO_SIGN_IN = 'org-id';
            process.env.QONTO_SECRET_KEY = 'secret';
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            delete process.env.QONTO_ENV;
            delete process.env.QONTO_SIGN_IN;
            delete process.env.QONTO_SECRET_KEY;
            if (ledgerBefore === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = ledgerBefore;
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });

        await it('previews by default and posts nothing', async () => {
            const path = fixture();
            fakeQonto(qontoInvoice({}));
            const res = await qontoFinalizeInvoice('inv-1', { path });
            expect(res.finalized).toBe(false);
            expect(calls.some((c) => c.method === 'POST')).toBe(false);
            expect(loadRecurringInvoices(path)[0].lastInvoice?.number).toBe('2026-PROFORMA');
        });

        await it('refuses a non-draft invoice before posting', async () => {
            const path = fixture();
            fakeQonto(qontoInvoice({ status: 'unpaid', number: 'RE-0001' }));
            let failed = false;
            try {
                await qontoFinalizeInvoice('inv-1', { confirm: true, path });
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
            expect(calls.some((c) => c.method === 'POST')).toBe(false);
        });

        await it('finalizes with confirm and replaces the PROFORMA number on the schedule', async () => {
            const path = fixture();
            fakeQonto(qontoInvoice({}));
            const res = await qontoFinalizeInvoice('inv-1', { confirm: true, path });
            expect(res.finalized).toBe(true);
            const post = calls.find((c) => c.method === 'POST');
            expect(post?.url.endsWith('/client_invoices/inv-1/finalize')).toBe(true);
            expect(loadRecurringInvoices(path)[0].lastInvoice?.number).toBe('RE-0001');
        });

        await it('with an entity, bills the time entries the draft reserved', async () => {
            const path = fixture();
            process.env.LEDGER_DB_PATH = join(dirs[dirs.length - 1], 'ledger.db');
            const at = '2026-05-01T08:00:00.000Z';
            const entry: TimeEntry = {
                id: 't1',
                entityId: 'demo',
                contactId: null,
                project: 'Demo',
                projectId: null,
                description: 'Konzept',
                startedAt: '2026-03-02T12:00:00.000Z',
                endedAt: '2026-03-02T13:00:00.000Z',
                durationSeconds: 3600,
                billable: true,
                invoiceId: null,
                source: 'manual',
                externalId: null,
                note: null,
                createdAt: at,
                updatedAt: at,
            };
            const billedTo = () => {
                const db = openLedger(ledgerDbPath());
                try {
                    return getTimeEntry(db, 't1')?.invoiceId ?? null;
                } finally {
                    db.close();
                }
            };
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                upsertTimeEntry(db, entry, at);
            } finally {
                db.close();
            }
            reserveTimeForDraft('demo', 'inv-1', ['t1']);
            fakeQonto(qontoInvoice({}));
            await qontoFinalizeInvoice('inv-1', { confirm: true, path, entityId: 'demo' });
            expect(billedTo()).toBe('inv-1');
        });
    });
};
