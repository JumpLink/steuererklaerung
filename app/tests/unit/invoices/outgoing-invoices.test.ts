import { describe, it, expect } from '@gjsify/unit';
import { buildOneOffCreateInput } from '../../../src/core/actions/outgoing-invoices.ts';
import type { InvoiceSpec } from '../../../src/core/clients/qonto/client-invoices.ts';
import type { EntityInvoicingView } from '../../../src/core/config/index.ts';

function view(over: Partial<EntityInvoicingView> = {}): EntityInvoicingView {
    return {
        type: 'qonto',
        qontoAccount: true,
        iban: 'DE-VIEW',
        paymentTermsDays: null,
        defaultHeader: null,
        defaultClosing: null,
        defaultHeaderSie: null,
        defaultClosingSie: null,
        selfNumberPrefix: null,
        selfIssuer: null,
        mail: null,
        mailTemplates: [],
        defaultMailTemplate: null,
        ...over,
    };
}

function spec(over: Partial<InvoiceSpec> = {}): InvoiceSpec {
    return {
        issue_date: '2026-06-12',
        iban: '',
        items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unit_price: 100, vat_rate: 19 }],
        ...over,
    };
}

export default async () => {
    await describe('buildOneOffCreateInput', async () => {
        await it('defaults currency to EUR and computes the due date from payment_terms_days', async () => {
            const input = buildOneOffCreateInput(spec({ payment_terms_days: 15 }), view());
            expect(input.currency).toBe('EUR');
            expect(input.dueDate).toBe('2026-06-27');
        });

        await it('resolves the IBAN: invoice.iban > view.iban', async () => {
            expect(buildOneOffCreateInput(spec({ iban: '' }), view({ iban: 'DE-VIEW' })).iban).toBe('DE-VIEW');
            expect(buildOneOffCreateInput(spec({ iban: 'DE-SPEC' }), view({ iban: 'DE-VIEW' })).iban).toBe('DE-SPEC');
        });

        await it('falls back the payment term to view.paymentTermsDays, then 15 days', async () => {
            expect(buildOneOffCreateInput(spec({ iban: 'x' }), view({ paymentTermsDays: 30 })).dueDate).toBe(
                '2026-07-12',
            );
            expect(buildOneOffCreateInput(spec({ iban: 'x' }), view({ paymentTermsDays: null })).dueDate).toBe(
                '2026-06-27',
            );
        });

        await it('honors an explicit due_date over the computed one', async () => {
            const input = buildOneOffCreateInput(spec({ iban: 'x', due_date: '2026-07-01' }), view());
            expect(input.dueDate).toBe('2026-07-01');
        });

        await it('passes status, number, header/footer, terms and Leistungszeitraum through', async () => {
            const input = buildOneOffCreateInput(
                spec({
                    iban: 'x',
                    status: 'unpaid',
                    number: 'RE-1',
                    header: 'H',
                    footer: 'F',
                    terms_and_conditions: 'T',
                    performance_start_date: '2026-05-01',
                    performance_end_date: '2026-05-31',
                }),
                view(),
            );
            expect(input.status).toBe('unpaid');
            expect(input.number).toBe('RE-1');
            expect(input.header).toBe('H');
            expect(input.footer).toBe('F');
            expect(input.termsAndConditions).toBe('T');
            expect(input.performanceStart).toBe('2026-05-01');
            expect(input.performanceEnd).toBe('2026-05-31');
            expect(input.items).toHaveLength(1);
        });
    });
};
