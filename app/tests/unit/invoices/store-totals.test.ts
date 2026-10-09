import { describe, it, expect } from '@gjsify/unit';
import {
    computeInvoiceTotals,
    computeItemTotals,
    isKleinbetragsrechnung,
    type InvoiceItemInput,
} from '@steuererklaerung/store';

const item = (over: Partial<InvoiceItemInput>): InvoiceItemInput => ({
    title: 'Leistung',
    quantity: 1,
    unitPriceNet: 100,
    vatRate: 0.19,
    ...over,
});

export default async () => {
    await describe('invoice totals', async () => {
        await it('computes a single line net/vat/gross', async () => {
            const t = computeItemTotals(item({ quantity: 2, unitPriceNet: 100, vatRate: 0.19 }));
            expect(t.net).toBe(200);
            expect(t.vat).toBe(38);
            expect(t.gross).toBe(238);
        });

        await it('sums VAT per rate on the rate net (not per line) and reconciles', async () => {
            const t = computeInvoiceTotals([
                item({ quantity: 1, unitPriceNet: 100, vatRate: 0.19 }),
                item({ quantity: 1, unitPriceNet: 50, vatRate: 0.19 }),
                item({ quantity: 1, unitPriceNet: 100, vatRate: 0.07 }),
            ]);
            expect(t.net).toBe(250);
            // 150 @ 19% = 28.5; 100 @ 7% = 7 → 35.5
            expect(t.vat).toBe(35.5);
            expect(t.gross).toBe(285.5);
            // gross always equals net + vat exactly
            expect(t.gross).toBe(Math.round((t.net + t.vat) * 100) / 100);
            expect(t.byRate.map((r) => r.rate)).toStrictEqual([0.19, 0.07]); // highest first
            expect(t.byRate[0]).toStrictEqual({ rate: 0.19, net: 150, vat: 28.5, gross: 178.5 });
        });

        await it('rounds cents deterministically (no float drift)', async () => {
            const t = computeInvoiceTotals([item({ quantity: 3, unitPriceNet: 9.99, vatRate: 0.19 })]);
            expect(t.net).toBe(29.97);
            expect(t.vat).toBe(5.69); // round(29.97 * 0.19) = round(5.6943) = 5.69
            expect(t.gross).toBe(35.66);
        });

        await it('flags the §33 UStDV Kleinbetragsrechnung boundary at 250 €', async () => {
            expect(isKleinbetragsrechnung(250)).toBe(true);
            expect(isKleinbetragsrechnung(250.0)).toBe(true);
            expect(isKleinbetragsrechnung(250.01)).toBe(false);
        });
    });
};
