import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { reconcileLastInvoices } from '../../../src/core/invoices/reconcile.ts';
import type { OutgoingInvoiceSummary } from '../../../src/core/invoices/provider.ts';
import { RecurringInvoiceSchema, type RecurringInvoice } from '../../../src/core/config/schema/recurring.ts';
import { loadRecurringInvoices } from '../../../src/core/config/index.ts';
import { reconcileRecurringInvoices } from '../../../src/core/actions/recurring-invoices.ts';
import { saveSchedule } from '../../../src/core/actions/recurring-schedules.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const period = { start: '2026-01-01', end: '2026-12-31' };

const schedule = (last: Record<string, unknown> | undefined): RecurringInvoice =>
    RecurringInvoiceSchema.parse({
        id: 'demo-hosting',
        entityId: 'demo',
        customer: { name: 'Demo Kunde' },
        nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
        items: [{ title: 'Hosting', unitPrice: 100 }],
        ...(last ? { lastInvoice: last } : {}),
    });

const draftLast = {
    number: '2026-PROFORMA',
    issueDate: '2026-01-05',
    period,
    providerId: 'inv-1',
    sentAt: '2026-01-06T08:00:00.000Z',
    sentTo: ['kunde@example.invalid'],
    messageId: '<m@example.invalid>',
};

const invoice = (over: Partial<OutgoingInvoiceSummary>): OutgoingInvoiceSummary => ({
    id: 'inv-1',
    number: 'RE-0001',
    status: 'unpaid',
    clientId: 'client-1',
    customerName: 'Demo Kunde',
    issueDate: '2026-01-05',
    dueDate: '2026-01-20',
    total: 119,
    currency: 'EUR',
    url: 'https://example.invalid/inv-1.pdf',
    performanceStart: period.start,
    performanceEnd: period.end,
    provider: 'qonto',
    ...over,
});

export default async () => {
    await describe('reconcileLastInvoices', async () => {
        await it('pulls the final number and link onto lastInvoice and keeps the mail log', async () => {
            const { schedules, changes } = reconcileLastInvoices([schedule(draftLast)], [invoice({})]);
            const last = schedules[0].lastInvoice!;
            expect(last.number).toBe('RE-0001');
            expect(last.url).toBe('https://example.invalid/inv-1.pdf');
            expect(last.providerId).toBe('inv-1');
            expect(last.messageId).toBe('<m@example.invalid>');
            expect(changes[0].outcome).toBe('updated');
            expect(changes[0].before).toBe('2026-PROFORMA');
            expect(changes[0].after).toBe('RE-0001');
        });

        await it('does not touch the period or the next period', async () => {
            const { schedules } = reconcileLastInvoices([schedule(draftLast)], [invoice({})]);
            expect(schedules[0].lastInvoice!.period).toStrictEqual(period);
            expect(schedules[0].nextPeriod.start).toBe('2027-01-01');
        });

        await it('reports unchanged and returns the very same schedule', async () => {
            const s = schedule({ ...draftLast, number: 'RE-0001', url: 'https://example.invalid/inv-1.pdf' });
            const { schedules, changes } = reconcileLastInvoices([s], [invoice({})]);
            expect(changes[0].outcome).toBe('unchanged');
            expect(schedules[0]).toBe(s);
        });

        await it('keeps the recorded number when the back-end has none (draft)', async () => {
            const { schedules } = reconcileLastInvoices(
                [schedule(draftLast)],
                [invoice({ number: null, status: 'draft' })],
            );
            expect(schedules[0].lastInvoice!.number).toBe('2026-PROFORMA');
        });

        await it('follows a cancellation to the replacement for the same period and drops the old mail log', async () => {
            const replacement = invoice({ id: 'inv-2', number: 'RE-0002', issueDate: '2026-02-01', url: null });
            const { schedules, changes } = reconcileLastInvoices(
                [schedule({ ...draftLast, number: 'RE-0001' })],
                [invoice({ status: 'canceled' }), replacement],
            );
            const last = schedules[0].lastInvoice!;
            expect(changes[0].outcome).toBe('replaced');
            expect(last.providerId).toBe('inv-2');
            expect(last.number).toBe('RE-0002');
            expect(last.issueDate).toBe('2026-02-01');
            expect(last.period).toStrictEqual(period);
            // The mail went out for the cancelled invoice, not for this one.
            expect(last.sentAt).toBe(undefined);
            expect(last.messageId).toBe(undefined);
        });

        await it('takes the newest replacement when a cancelled invoice was replaced twice', async () => {
            const { schedules } = reconcileLastInvoices(
                [schedule(draftLast)],
                [
                    invoice({ status: 'canceled' }),
                    invoice({ id: 'inv-2', number: 'RE-0002', status: 'canceled', issueDate: '2026-02-01' }),
                    invoice({ id: 'inv-3', number: 'RE-0003', issueDate: '2026-03-01' }),
                ],
            );
            expect(schedules[0].lastInvoice!.number).toBe('RE-0003');
        });

        await it('ignores invoices of another period or another customer', async () => {
            const { schedules, changes } = reconcileLastInvoices(
                [schedule(draftLast)],
                [
                    invoice({ status: 'canceled' }),
                    invoice({
                        id: 'inv-2',
                        number: 'RE-0002',
                        performanceStart: '2027-01-01',
                        performanceEnd: '2027-12-31',
                    }),
                    invoice({ id: 'inv-3', number: 'RE-0003', clientId: 'client-2' }),
                ],
            );
            expect(changes[0].outcome).toBe('cancelled-no-replacement');
            expect(schedules[0].lastInvoice!.providerId).toBe('inv-1');
        });

        await it('leaves a cancelled invoice alone when the period of the schedule is unknown', async () => {
            const { changes } = reconcileLastInvoices(
                [schedule({ ...draftLast, period: undefined })],
                [invoice({ status: 'canceled' }), invoice({ id: 'inv-2', number: 'RE-0002' })],
            );
            // advanceSchedule always records the period, so this is a hand-edited manifest.
            expect(changes[0].outcome).toBe('cancelled-no-replacement');
        });

        await it('reports a recorded invoice the back-end does not list, and skips schedules without providerId', async () => {
            const noId = { ...schedule({ ...draftLast, providerId: undefined }), id: 'no-id' };
            const never = { ...schedule(undefined), id: 'never' };
            const { changes } = reconcileLastInvoices([schedule(draftLast), noId, never], []);
            expect(changes).toHaveLength(1);
            expect(changes[0].outcome).toBe('missing');
        });
    });

    await describe('reconcileRecurringInvoices (Qonto fetch faked)', async () => {
        const dirs: string[] = [];
        const qontoInvoice = (over: Record<string, unknown>) => ({
            id: 'inv-1',
            number: 'RE-0001',
            status: 'unpaid',
            client: { id: 'client-1', name: 'Demo Kunde' },
            issue_date: '2026-01-05',
            due_date: '2026-01-20',
            currency: 'EUR',
            total_amount: { value: '119.00', currency: 'EUR' },
            invoice_url: 'https://example.invalid/inv-1.pdf',
            performance_start_date: period.start,
            performance_end_date: period.end,
            ...over,
        });
        const fixture = (): string => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        name: 'Demo Studio',
                        accounts: ['qonto:demo*'],
                        invoicing: { type: 'qonto' },
                        recurring: [{ ...schedule(draftLast) }],
                    },
                ],
            });
            dirs.push(made.dir);
            return made.path;
        };
        const fakeQonto = (invoices: unknown[]) => {
            const fetchFn = vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () =>
                    JSON.stringify({ client_invoices: invoices, meta: { current_page: 1, total_pages: 1 } }),
            }));
            vi.stubGlobal('fetch', fetchFn);
            return fetchFn;
        };

        beforeEach(() => {
            process.env.QONTO_ENV = 'production';
            process.env.QONTO_SIGN_IN = 'org-id';
            process.env.QONTO_SECRET_KEY = 'secret';
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            delete process.env.QONTO_ENV;
            delete process.env.QONTO_SIGN_IN;
            delete process.env.QONTO_SECRET_KEY;
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });

        await it('writes the final number to the manifest', async () => {
            const path = fixture();
            fakeQonto([qontoInvoice({})]);
            const res = await reconcileRecurringInvoices({ entityId: 'demo', path });
            expect(res.rewritten).toBe(true);
            expect(loadRecurringInvoices(path)[0].lastInvoice?.number).toBe('RE-0001');
        });

        await it('writes nothing on a dry run', async () => {
            const path = fixture();
            fakeQonto([qontoInvoice({})]);
            const res = await reconcileRecurringInvoices({ entityId: 'demo', path, dryRun: true });
            expect(res.rewritten).toBe(true);
            expect(res.changes[0].after).toBe('RE-0001');
            expect(loadRecurringInvoices(path)[0].lastInvoice?.number).toBe('2026-PROFORMA');
        });

        await it('follows a Qonto cancellation to the replacement', async () => {
            const path = fixture();
            fakeQonto([
                qontoInvoice({ status: 'canceled' }),
                qontoInvoice({ id: 'inv-2', number: 'RE-0002', issue_date: '2026-02-01', invoice_url: undefined }),
            ]);
            await reconcileRecurringInvoices({ entityId: 'demo', path });
            const last = loadRecurringInvoices(path)[0].lastInvoice;
            expect(last?.providerId).toBe('inv-2');
            expect(last?.number).toBe('RE-0002');
        });

        await it('keeps a reconciled lastInvoice when a stale edit dialog saves', async () => {
            const path = fixture();
            fakeQonto([qontoInvoice({})]);
            await reconcileRecurringInvoices({ entityId: 'demo', path });
            const stale = schedule(draftLast); // the dialog was opened before the sync
            const prev = process.env.STEUER_WORKSPACE;
            process.env.STEUER_WORKSPACE = path;
            try {
                saveSchedule({ ...stale, notes: 'edited' });
            } finally {
                if (prev === undefined) delete process.env.STEUER_WORKSPACE;
                else process.env.STEUER_WORKSPACE = prev;
            }
            const saved = loadRecurringInvoices(path)[0];
            expect(saved.notes).toBe('edited');
            expect(saved.lastInvoice?.number).toBe('RE-0001');
        });

        await it('makes no request when no schedule recorded an invoice id', async () => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        accounts: ['qonto:demo*'],
                        invoicing: { type: 'qonto' },
                        recurring: [schedule(undefined)],
                    },
                ],
            });
            dirs.push(made.dir);
            const fetchFn = fakeQonto([]);
            const res = await reconcileRecurringInvoices({ entityId: 'demo', path: made.path });
            expect(res.changes).toHaveLength(0);
            expect(fetchFn).toHaveBeenCalledTimes(0);
        });
    });
};
