import { describe, it, expect } from '@gjsify/unit';
import { parseGermanInput, parseNumericString, parseIntId } from '../../../src/core/lib/parsing.ts';

export default async () => {
    await describe('parseNumericString', async () => {
        await it('parses positive numbers', async () => {
            expect(parseNumericString('14.85')).toBe(14.85);
        });

        await it('parses negative numbers', async () => {
            expect(parseNumericString('-14.85')).toBe(-14.85);
        });

        await it('parses zero', async () => {
            expect(parseNumericString('0')).toBe(0);
        });

        await it('handles German format (comma as decimal)', async () => {
            expect(parseNumericString('14,85')).toBe(14.85);
        });

        await it('handles German format with thousands separator', async () => {
            expect(parseNumericString('1.234,56')).toBe(1234.56);
        });

        await it('handles English format with thousands separator', async () => {
            expect(parseNumericString('1,234.56')).toBe(1234.56);
        });

        await it('handles large numbers with thousands separators', async () => {
            expect(parseNumericString('1.234.567,89')).toBe(1234567.89);
            expect(parseNumericString('1,234,567.89')).toBe(1234567.89);
        });

        await it('handles whitespace', async () => {
            expect(parseNumericString('  42.5  ')).toBe(42.5);
        });

        await it('returns null for null/undefined/empty', async () => {
            expect(parseNumericString(null)).toBeNull();
            expect(parseNumericString(undefined)).toBeNull();
            expect(parseNumericString('')).toBeNull();
            expect(parseNumericString('   ')).toBeNull();
        });

        await it('returns null for non-numeric strings', async () => {
            expect(parseNumericString('abc')).toBeNull();
            expect(parseNumericString('not a number')).toBeNull();
        });
    });

    await describe('parseIntId', async () => {
        await it('returns number directly if already number', async () => {
            expect(parseIntId(42)).toBe(42);
        });

        await it('parses numeric string', async () => {
            expect(parseIntId('123')).toBe(123);
        });

        await it('returns NaN for null/undefined/empty', async () => {
            expect(parseIntId(null)).toBeNaN();
            expect(parseIntId(undefined)).toBeNaN();
            expect(parseIntId('')).toBeNaN();
        });

        await it('returns NaN for non-numeric strings', async () => {
            expect(parseIntId('abc')).toBeNaN();
        });
    });

    await describe('parseGermanInput', async () => {
        await it('reads what a German keyboard types', async () => {
            expect(parseGermanInput('12.500,00')).toBe(12500);
            expect(parseGermanInput('1.234.567,89')).toBe(1234567.89);
            expect(parseGermanInput('1234,56')).toBe(1234.56);
            expect(parseGermanInput('-1.500,50')).toBe(-1500.5);
        });

        await it('differs from parseNumericString on exactly one case: a lone dot', async () => {
            // `12.500` is twelve and a half thousand to someone typing German, and twelve-point-five
            // to a machine emitting English with three decimals. Same eight characters, two answers
            // a thousandfold apart — so the SOURCE decides which parser is right, not the string.
            expect(parseGermanInput('12.500')).toBe(12500);
            expect(parseNumericString('12.500')).toBe(12.5);
            // Not grouping: two digits after the dot cannot be a thousands group.
            expect(parseGermanInput('1.50')).toBe(1.5);
            expect(parseNumericString('1.50')).toBe(1.5);
        });

        await it('refuses a half-read instead of storing it', async () => {
            expect(parseGermanInput('12abc')).toBe(null);
            expect(parseGermanInput('1,2,3')).toBe(null);
            expect(parseGermanInput('')).toBe(null);
            expect(parseGermanInput('-')).toBe(null);
            expect(parseGermanInput('1.23.456')).toBe(null);
        });

        await it('ignores currency and the spaces a copied amount brings along', async () => {
            expect(parseGermanInput('12.500,00 \u20ac')).toBe(12500);
            expect(parseGermanInput(' 1 234,5 ')).toBe(1234.5);
            expect(parseGermanInput('1\u202f234,5')).toBe(1234.5);
            expect(parseGermanInput('1\u00a0234,5')).toBe(1234.5);
        });
    });
};
