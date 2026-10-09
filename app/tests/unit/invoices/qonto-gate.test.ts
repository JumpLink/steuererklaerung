import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { hasQontoAccount, loadEntityInvoicing, resolveInvoicingType } from '../../../src/core/config/index.ts';
import { invoicingBlock, QontoNotConfiguredError } from '../../../src/core/invoices/backend-gate.ts';
import { createOutgoingInvoiceDraft, getInvoiceCapabilities } from '../../../src/core/actions/outgoing-invoices.ts';
import { listOutgoingInvoices } from '../../../src/core/actions/recurring-invoices.ts';
import { loadInvoicingBlock, selectInvoicesForYear } from '../../../src/core/presenters/rechnungen.ts';
import type { OutgoingInvoiceSummary } from '../../../src/core/invoices/provider.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const summary = (over: Partial<OutgoingInvoiceSummary>): OutgoingInvoiceSummary =>
    ({
        id: 'x',
        number: null,
        status: 'unpaid',
        issueDate: '2026-01-10',
        dueDate: '2026-01-25',
        total: 100,
        ...over,
    }) as OutgoingInvoiceSummary;

export default async () => {
    await describe('Qonto invoicing needs a Qonto account', async () => {
        const dirs: string[] = [];
        let fetchFn: ReturnType<typeof vi.fn>;

        /** Three entities: a live Qonto one, a dissolved one with only imported accounts, a misconfigured one. */
        const fixture = (): string => {
            const made = writeManifestFixture({
                entities: [
                    { id: 'live', accounts: ['qonto:demo*'], invoicing: { type: 'qonto' } },
                    { id: 'derived-live', accounts: ['qonto:demo*'] },
                    { id: 'dissolved', accounts: ['camt:demo*'] },
                    { id: 'misconfigured', accounts: ['camt:demo*'], invoicing: { type: 'qonto' } },
                    { id: 'own', accounts: ['camt:demo*'], invoicing: { type: 'self' } },
                ],
            });
            dirs.push(made.dir);
            return made.path;
        };

        beforeEach(() => {
            process.env.QONTO_ENV = 'production';
            process.env.QONTO_SIGN_IN = 'org-id';
            process.env.QONTO_SECRET_KEY = 'secret';
            fetchFn = vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ client_invoices: [], clients: [], meta: {} }),
            }));
            vi.stubGlobal('fetch', fetchFn);
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            delete process.env.QONTO_ENV;
            delete process.env.QONTO_SIGN_IN;
            delete process.env.QONTO_SECRET_KEY;
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });

        await it('recognises a qonto: account and nothing else', async () => {
            expect(hasQontoAccount(['camt:abc*', 'qonto:01234*'])).toBe(true);
            expect(hasQontoAccount(['camt:abc*', 'paypal:x'])).toBe(false);
            expect(hasQontoAccount([])).toBe(false);
        });

        await it('derives the default type from the accounts, an explicit type wins', async () => {
            expect(resolveInvoicingType(undefined, ['qonto:a*'])).toBe('qonto');
            expect(resolveInvoicingType(undefined, ['camt:a*'])).toBe('self');
            expect(resolveInvoicingType('qonto', ['camt:a*'])).toBe('qonto');
            expect(resolveInvoicingType('self', ['qonto:a*'])).toBe('self');
        });

        await it('reads the effective type and Qonto account per entity', async () => {
            const path = fixture();
            expect(loadEntityInvoicing('live', path).type).toBe('qonto');
            expect(loadEntityInvoicing('derived-live', path).type).toBe('qonto');
            expect(loadEntityInvoicing('dissolved', path).type).toBe('self');
            expect(loadEntityInvoicing('dissolved', path).qontoAccount).toBe(false);
            expect(loadEntityInvoicing('misconfigured', path).type).toBe('qonto');
            expect(loadEntityInvoicing('misconfigured', path).qontoAccount).toBe(false);
            // No entity named (CLI default config): the global Qonto setup stays usable.
            expect(loadEntityInvoicing('', path).qontoAccount).toBe(true);
        });

        await it('blocks only an entity configured for Qonto without a Qonto account', async () => {
            const path = fixture();
            expect(invoicingBlock('live', path)).toBe(null);
            expect(invoicingBlock('derived-live', path)).toBe(null);
            expect(invoicingBlock('dissolved', path)).toBe(null);
            expect(invoicingBlock('own', path)).toBe(null);
            expect(invoicingBlock('', path)).toBe(null);
            const reason = invoicingBlock('misconfigured', path) ?? '';
            expect(reason).toContain('kein Qonto-Konto');
            expect(reason).toContain('Einstellungen → Anbindungen');
        });

        await it('the presenter reports the block for the notice page', async () => {
            process.env.STEUER_WORKSPACE = fixture();
            try {
                expect(loadInvoicingBlock('misconfigured')).toContain('kein Qonto-Konto');
                expect(loadInvoicingBlock('live')).toBe(null);
            } finally {
                delete process.env.STEUER_WORKSPACE;
            }
        });

        await it('lists nothing from Qonto for a blocked entity — no request is made', async () => {
            const path = fixture();
            let error: unknown;
            try {
                await listOutgoingInvoices({ entityId: 'misconfigured', path });
            } catch (e) {
                error = e;
            }
            expect(error instanceof QontoNotConfiguredError).toBe(true);
            expect(String((error as Error).message)).toContain('kein Qonto-Konto');
            expect(fetchFn.mock.calls.length).toBe(0);
        });

        await it('creates no draft and no customer for a blocked entity, even as a dry run', async () => {
            const path = fixture();
            for (const dryRun of [true, false]) {
                let error: unknown;
                try {
                    await createOutgoingInvoiceDraft(
                        {
                            entityId: 'misconfigured',
                            client: { kind: 'company', name: 'Demo Kunde' } as never,
                            invoice: {
                                issue_date: '2026-01-05',
                                items: [
                                    {
                                        title: 'Hosting',
                                        quantity: '1',
                                        unit_price: { value: '10.00', currency: 'EUR' },
                                        vat_rate: '0.19',
                                    },
                                ],
                            } as never,
                            dryRun,
                        },
                        { path },
                    );
                } catch (e) {
                    error = e;
                }
                expect(error instanceof QontoNotConfiguredError).toBe(true);
            }
            expect(fetchFn.mock.calls.length).toBe(0);
        });

        await it('still lists through Qonto for an entity with a Qonto account', async () => {
            const path = fixture();
            const list = await listOutgoingInvoices({ entityId: 'live', path });
            expect(list.length).toBe(0);
            expect(fetchFn.mock.calls.length).toBe(1);
        });

        await it('capabilities of a blocked entity throw the explanation; others resolve', async () => {
            const path = fixture();
            let error: unknown;
            try {
                getInvoiceCapabilities('misconfigured', path);
            } catch (e) {
                error = e;
            }
            expect(error instanceof QontoNotConfiguredError).toBe(true);
            expect(getInvoiceCapabilities('live', path).providerType).toBe('qonto');
        });
    });

    await describe('selectInvoicesForYear', async () => {
        const today = '2026-07-01';
        await it('keeps paid and cancelled invoices of the selected year only', async () => {
            const list = [
                summary({ id: 'paid-25', status: 'paid', issueDate: '2025-03-01', dueDate: '2025-03-15' }),
                summary({ id: 'paid-26', status: 'paid', issueDate: '2026-03-01', dueDate: '2026-03-15' }),
                summary({ id: 'canc-26', status: 'canceled', issueDate: '2026-03-02', dueDate: '2026-03-16' }),
            ];
            expect(
                selectInvoicesForYear(list, 2025, today)
                    .map((i) => i.id)
                    .join(),
            ).toBe('paid-25');
            expect(
                selectInvoicesForYear(list, 2026, today)
                    .map((i) => i.id)
                    .join(),
            ).toBe('paid-26,canc-26');
        });

        await it('keeps every unpaid invoice whatever its year', async () => {
            const list = [
                summary({ id: 'open-26', status: 'unpaid', issueDate: '2026-06-20', dueDate: '2026-08-01' }),
                summary({ id: 'overdue-24', status: 'unpaid', issueDate: '2024-01-01', dueDate: '2024-01-15' }),
                summary({ id: 'draft', status: 'draft', issueDate: '2026-02-01', dueDate: '2026-02-15' }),
            ];
            expect(selectInvoicesForYear(list, 2025, today).length).toBe(3);
        });

        await it('does not drop an undated paid invoice', async () => {
            const list = [summary({ id: 'p', status: 'paid', issueDate: null, dueDate: null })];
            expect(selectInvoicesForYear(list, 2025, today).length).toBe(1);
        });
    });
};
