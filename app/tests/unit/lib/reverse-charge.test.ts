import { describe, it, expect } from '@gjsify/unit';
import {
    isEuCountry,
    classifyReverseCharge,
    emptyReverseChargeTotals,
    addReverseChargeItem,
    hasReverseCharge,
    type ReverseChargeItem,
} from '../../../src/core/elster/reverse-charge.ts';

export default async () => {
    await describe('isEuCountry', async () => {
        await it('accepts EU codes incl. the Greek "EL" VAT prefix, rejects DE / third countries', async () => {
            expect(isEuCountry('IE')).toBe(true);
            expect(isEuCountry('ie')).toBe(true);
            expect(isEuCountry('EL')).toBe(true); // Greece VAT prefix
            expect(isEuCountry('DE')).toBe(false); // domestic ≠ §13b Abs. 1
            expect(isEuCountry('US')).toBe(false);
            expect(isEuCountry('GB')).toBe(false); // post-Brexit
            expect(isEuCountry(null)).toBe(false);
        });
    });

    await describe('classifyReverseCharge', async () => {
        await it('classifies an EU service (Adobe IE) as §13b Abs. 1 with 19 % tax', async () => {
            const r = classifyReverseCharge({
                reverseCharge: true,
                supplierCountry: 'IE',
                saleType: 'SERVICES',
                net: 55.84,
            });
            expect(r.item).not.toBe(null);
            expect(r.item?.kind).toBe('abs1');
            expect(r.item?.base).toBe(55.84);
            expect(r.item?.tax).toBe(10.61); // round2(55.84 * 0.19)
        });

        await it('classifies a third-country service (DigitalOcean US) as §13b Abs. 2', async () => {
            const r = classifyReverseCharge({
                reverseCharge: true,
                supplierCountry: 'US',
                saleType: 'SERVICES',
                net: 100,
            });
            expect(r.item?.kind).toBe('abs2');
            expect(r.item?.base).toBe(100);
            expect(r.item?.tax).toBe(19);
        });

        await it('treats a foreign 0 %-VAT invoice without an explicit flag as reverse charge', async () => {
            const r = classifyReverseCharge({ supplierCountry: 'US', saleType: 'SERVICES', net: 50 });
            expect(r.item?.kind).toBe('abs2');
        });

        await it('is not §13b for a domestic invoice', async () => {
            const r = classifyReverseCharge({ supplierCountry: 'DE', net: 100 });
            expect(r.item).toBe(null);
            expect(r.review).toBe(null);
        });

        await it('flags EU goods as i.g. Erwerb (not §13b) for review', async () => {
            const r = classifyReverseCharge({
                reverseCharge: true,
                supplierCountry: 'FR',
                saleType: 'GOODS',
                net: 200,
            });
            expect(r.item).toBe(null);
            expect(r.review).toContain('i.g. Erwerb');
        });

        await it('flags a reverse-charge invoice with no country for review', async () => {
            const r = classifyReverseCharge({ reverseCharge: true, net: 30 });
            expect(r.item).toBe(null);
            expect(r.review).toContain('ohne Lieferantenland');
        });
    });

    await describe('reverse-charge totals', async () => {
        await it('sums Abs. 1 + Abs. 2 and derives the deductible Kz 67 = Σ tax', async () => {
            const t = emptyReverseChargeTotals();
            const items: ReverseChargeItem[] = [
                { kind: 'abs1', base: 55.84, tax: 10.61 },
                { kind: 'abs1', base: 55.84, tax: 10.61 },
                { kind: 'abs2', base: 100, tax: 19 },
            ];
            for (const i of items) addReverseChargeItem(t, i);
            expect(t.abs1Base).toBe(111.68);
            expect(t.abs1Tax).toBe(21.22);
            expect(t.abs2Base).toBe(100);
            expect(t.abs2Tax).toBe(19);
            expect(t.deductibleVat).toBe(40.22); // 21.22 + 19 — nets against the owed tax
            expect(t.count).toBe(3);
            expect(hasReverseCharge(t)).toBe(true);
        });

        await it('empty totals report no reverse charge', async () => {
            expect(hasReverseCharge(emptyReverseChargeTotals())).toBe(false);
        });
    });
};
