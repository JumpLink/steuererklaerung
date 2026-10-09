import { describe, it, expect } from '@gjsify/unit';
import {
    isEmptyValue,
    normalizeAmountValue,
    parseMonetaryValue,
    formatMonetaryValue,
} from '@steuererklaerung/paperless';

// Characterization tests: these lock the CURRENT behaviour of the money parsers
// that feed EÜR aggregation, reconciliation and LLM extraction. A silent change
// here would corrupt tax totals.

export default async () => {
    await describe('parseMonetaryValue', async () => {
        await it('parses plain numbers with the default currency', async () => {
            expect(parseMonetaryValue(57.6)).toStrictEqual({ amount: 57.6, currency: 'EUR' });
            expect(parseMonetaryValue(-10)).toStrictEqual({ amount: -10, currency: 'EUR' });
        });
        await it('parses the Paperless "CUR123.45" format', async () => {
            expect(parseMonetaryValue('USD57.60')).toStrictEqual({ amount: 57.6, currency: 'USD' });
            expect(parseMonetaryValue('EUR100.00')).toStrictEqual({ amount: 100, currency: 'EUR' });
        });
        await it('parses a plain numeric string with the default currency', async () => {
            expect(parseMonetaryValue('57.60')).toStrictEqual({ amount: 57.6, currency: 'EUR' });
            expect(parseMonetaryValue('57.60', 'USD')).toStrictEqual({ amount: 57.6, currency: 'USD' });
        });
        await it('treats comma as a THOUSANDS separator (known quirk — not a decimal comma)', async () => {
            expect(parseMonetaryValue('1,234.56')).toStrictEqual({ amount: 1234.56, currency: 'EUR' });
            // A German decimal comma is therefore MISREAD as thousands — documented, not desired:
            expect(parseMonetaryValue('1,50')).toStrictEqual({ amount: 150, currency: 'EUR' });
        });
        await it('returns null for empty / null / unparseable / NaN', async () => {
            expect(parseMonetaryValue(null)).toBeNull();
            expect(parseMonetaryValue(undefined)).toBeNull();
            expect(parseMonetaryValue('')).toBeNull();
            expect(parseMonetaryValue('   ')).toBeNull();
            expect(parseMonetaryValue('abc')).toBeNull();
            expect(parseMonetaryValue(Number.NaN)).toBeNull();
        });
    });

    await describe('normalizeAmountValue', async () => {
        await it('rounds to 2 decimals from numbers and monetary strings', async () => {
            expect(normalizeAmountValue(57.605)).toBe(57.61);
            expect(normalizeAmountValue('USD57.605')).toBe(57.61);
            expect(normalizeAmountValue('100')).toBe(100);
        });
        await it('returns null for unparseable / null', async () => {
            expect(normalizeAmountValue(null)).toBeNull();
            expect(normalizeAmountValue('abc')).toBeNull();
        });
    });

    await describe('formatMonetaryValue', async () => {
        await it('always upper-cases the currency and uses two decimals', async () => {
            expect(formatMonetaryValue(57.6, 'usd')).toBe('USD57.60');
            expect(formatMonetaryValue(100, 'EUR')).toBe('EUR100.00');
            expect(formatMonetaryValue(-9.5, 'eur')).toBe('EUR-9.50');
        });
    });

    await describe('isEmptyValue', async () => {
        await it('treats null, blank strings and NaN as empty; 0 and false are NOT empty', async () => {
            expect(isEmptyValue(null)).toBe(true);
            expect(isEmptyValue(undefined)).toBe(true);
            expect(isEmptyValue('')).toBe(true);
            expect(isEmptyValue('  ')).toBe(true);
            expect(isEmptyValue(Number.NaN)).toBe(true);
            expect(isEmptyValue(0)).toBe(false);
            expect(isEmptyValue(false)).toBe(false);
            expect(isEmptyValue('x')).toBe(false);
        });
    });
};
