import { describe, it, expect } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { buildCreateInput } from '../../../src/core/actions/recurring-invoices.ts';
import { buildClientInvoiceBody } from '../../../src/core/clients/qonto/client-invoices.ts';
import { loadRecurringInvoices } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const year = { start: '2026-01-01', end: '2026-12-31' };

export default async () => {
    await describe('the create call for a recurring schedule', async () => {
        const dirs: string[] = [];
        const built = (type: 'qonto' | 'self') => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        accounts: ['qonto:demo*'],
                        invoicing: { type, iban: 'DE02120300000000202051' },
                        recurring: [
                            {
                                id: 'demo-hosting',
                                entityId: 'demo',
                                customer: { name: 'Demo Kunde', qontoClientId: 'client-1' },
                                nextPeriod: year,
                                items: [{ title: 'Hosting', unitPrice: 100 }],
                            },
                        ],
                    },
                ],
            });
            dirs.push(made.dir);
            const inv = loadRecurringInvoices(made.path)[0];
            return buildCreateInput(inv, { path: made.path, today: '2026-01-05' }).input;
        };

        await it('sends the period as start and end date and leaves the item text alone', async () => {
            const input = built('qonto');
            const body = buildClientInvoiceBody('client-1', {
                issue_date: input.issueDate,
                iban: input.iban,
                performance_start_date: input.performanceStart,
                performance_end_date: input.performanceEnd,
                items: input.items,
            });
            expect(body.performance_start_date).toBe('2026-01-01');
            expect(body.performance_end_date).toBe('2026-12-31');
            // Qonto prints the range itself as "Leistungsdatum: Vom … bis …".
            expect(body.items[0].description).toBe(undefined);
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });

        await it('does not touch the item of the self back-end either', async () => {
            const input = built('self');
            expect(input.items[0].description).toBe(undefined);
            expect(input.performanceStart).toBe('2026-01-01');
            expect(input.performanceEnd).toBe('2026-12-31');
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });
    });
};
