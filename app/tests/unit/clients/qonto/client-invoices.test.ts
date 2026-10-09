import { describe, it, expect } from '@gjsify/unit';
import {
    addDays,
    buildClientInvoiceBody,
    buildInvoiceItem,
    buildSendInvoiceBody,
    normalizeAmount,
    normalizeVatRate,
    type InvoiceSpec,
} from '../../../../src/core/clients/qonto/client-invoices.ts';

export default async () => {
    await describe('normalizeVatRate', async () => {
        await it('converts percent (>1) to decimal string', async () => {
            expect(normalizeVatRate(19)).toBe('0.19');
            expect(normalizeVatRate('19')).toBe('0.19');
            expect(normalizeVatRate(7)).toBe('0.07');
        });

        await it('passes decimal (<=1) through', async () => {
            expect(normalizeVatRate('0.19')).toBe('0.19');
            expect(normalizeVatRate(0)).toBe('0');
        });

        await it('throws on invalid input', async () => {
            expect(() => normalizeVatRate('abc')).toThrow();
            expect(() => normalizeVatRate(-1)).toThrow();
        });
    });

    await describe('normalizeAmount', async () => {
        await it('formats to 2 decimals and accepts comma decimals', async () => {
            expect(normalizeAmount(100)).toBe('100.00');
            expect(normalizeAmount('75')).toBe('75.00');
            expect(normalizeAmount('100,5')).toBe('100.50');
        });
    });

    await describe('addDays', async () => {
        await it('adds calendar days across month boundaries', async () => {
            expect(addDays('2026-06-12', 15)).toBe('2026-06-27');
            expect(addDays('2026-12-20', 15)).toBe('2027-01-04');
        });
    });

    await describe('buildInvoiceItem', async () => {
        await it('maps a friendly item spec to the Qonto shape', async () => {
            const item = buildInvoiceItem(
                {
                    title: 'Programmierung',
                    description: 'SEO\nDNS',
                    quantity: 3,
                    unit: 'Std',
                    unit_price: 100,
                    vat_rate: 19,
                },
                'EUR',
            );
            expect(item).toStrictEqual({
                title: 'Programmierung',
                description: 'SEO\nDNS',
                quantity: '3',
                unit: 'Std',
                unit_price: { value: '100.00', currency: 'EUR' },
                vat_rate: '0.19',
            });
        });

        await it('rejects a title longer than 40 chars', async () => {
            expect(() =>
                buildInvoiceItem({ title: 'x'.repeat(41), quantity: 1, unit_price: 1, vat_rate: 19 }, 'EUR'),
            ).toThrow();
        });
    });

    await describe('buildClientInvoiceBody', async () => {
        const spec: InvoiceSpec = {
            issue_date: '2026-06-12',
            payment_terms_days: 15,
            iban: 'DE13 3704 0044 0532 0130 10',
            performance_start_date: '2026-05-31',
            performance_end_date: '2026-06-12',
            items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unit_price: 100, vat_rate: 19 }],
        };

        await it('defaults to draft, EUR, computed due date, and normalizes the IBAN', async () => {
            const body = buildClientInvoiceBody('client-123', spec);
            expect(body.client_id).toBe('client-123');
            expect(body.status).toBe('draft');
            expect(body.currency).toBe('EUR');
            expect(body.due_date).toBe('2026-06-27');
            expect(body.payment_methods.iban).toBe('DE13370400440532013010');
            expect(body.performance_start_date).toBe('2026-05-31');
            expect(body.items).toHaveLength(1);
            expect(body.items[0].unit_price).toStrictEqual({ value: '100.00', currency: 'EUR' });
        });

        await it('honors an explicit due_date and status override', async () => {
            const body = buildClientInvoiceBody('c1', { ...spec, due_date: '2026-07-01', status: 'unpaid' });
            expect(body.due_date).toBe('2026-07-01');
            expect(body.status).toBe('unpaid');
        });

        await it('throws without items or iban', async () => {
            expect(() => buildClientInvoiceBody('c1', { ...spec, items: [] })).toThrow();
            expect(() => buildClientInvoiceBody('c1', { ...spec, iban: '' })).toThrow();
        });
    });

    await describe('buildSendInvoiceBody', async () => {
        await it('accepts a comma-separated recipient string and defaults copy_to_self to true', async () => {
            const body = buildSendInvoiceBody({ sendTo: 'a@x.de, b@y.de', subject: 'Rechnung', body: 'Hallo' });
            expect(body).toStrictEqual({
                send_to: ['a@x.de', 'b@y.de'],
                email_title: 'Rechnung',
                email_body: 'Hallo',
                copy_to_self: true,
            });
        });

        await it('accepts an array and honors copyToSelf=false; omits empty body', async () => {
            const body = buildSendInvoiceBody({ sendTo: ['a@x.de'], subject: 'Re', copyToSelf: false });
            expect(body.send_to).toStrictEqual(['a@x.de']);
            expect(body.copy_to_self).toBe(false);
            expect(body.email_body).toBeUndefined();
        });

        await it('throws without a recipient or subject', async () => {
            expect(() => buildSendInvoiceBody({ sendTo: ' , ', subject: 'x' })).toThrow();
            expect(() => buildSendInvoiceBody({ sendTo: 'a@x.de', subject: '' })).toThrow();
        });
    });
};
