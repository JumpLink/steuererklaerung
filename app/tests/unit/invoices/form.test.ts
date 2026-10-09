import { describe, it, expect } from '@gjsify/unit';
import {
    parseGermanDecimal,
    parseVatRate,
    computeFormTotals,
    validateFormDraft,
    emptyItem,
    type InvoiceItemDraft,
} from '../../../src/core/invoices/form.ts';

const item = (over: Partial<InvoiceItemDraft> = {}): InvoiceItemDraft => ({
    title: 'Beratung',
    quantity: '2',
    unitPrice: '100',
    vatRate: '19',
    ...over,
});

export default async () => {
    await describe('invoice form helpers', async () => {
        await it('parses German + plain decimals', async () => {
            expect(parseGermanDecimal('1.234,56')).toBe(1234.56);
            expect(parseGermanDecimal('1234.56')).toBe(1234.56);
            expect(parseGermanDecimal('1234,56')).toBe(1234.56);
            expect(parseGermanDecimal('100')).toBe(100);
            expect(parseGermanDecimal('')).toBe(null);
            expect(parseGermanDecimal('abc')).toBe(null);
        });

        await it('parses VAT rates to fractions', async () => {
            expect(parseVatRate('19')).toBe(0.19);
            expect(parseVatRate('19 %')).toBe(0.19);
            expect(parseVatRate('0,19')).toBe(0.19);
            expect(parseVatRate('0')).toBe(0);
        });

        await it('computes live totals per VAT rate', async () => {
            const t = computeFormTotals([
                item({ quantity: '2', unitPrice: '100', vatRate: '19' }),
                item({ quantity: '1', unitPrice: '100', vatRate: '7' }),
            ]);
            expect(t.net).toBe(300);
            expect(t.vat).toBe(45); // 200*0.19=38 + 100*0.07=7
            expect(t.gross).toBe(345);
            expect(t.byRate[0].rate).toBe(0.19); // highest first
        });

        await it('ignores unparseable rows in the live preview', async () => {
            const t = computeFormTotals([item(), item({ unitPrice: '' })]);
            expect(t.net).toBe(200);
        });

        await it('validates a draft (German messages)', async () => {
            expect(validateFormDraft({ contactId: 'c1', issueDate: '2026-03-01', items: [item()] })).toStrictEqual([]);
            const problems = validateFormDraft({
                contactId: '',
                issueDate: '',
                items: [item({ title: '', quantity: 'x' })],
            });
            expect(problems.some((p) => p.includes('Empfänger'))).toBe(true);
            expect(problems.some((p) => p.includes('Ausstellungsdatum'))).toBe(true);
            expect(problems.some((p) => p.includes('Bezeichnung'))).toBe(true);
            expect(problems.some((p) => p.includes('Menge'))).toBe(true);
        });

        await it('emptyItem has sensible defaults', async () => {
            expect(emptyItem()).toStrictEqual({ title: '', quantity: '1', unitPrice: '', vatRate: '19' });
        });
    });
};
