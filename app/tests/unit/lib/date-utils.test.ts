import { describe, it, expect } from '@gjsify/unit';
import {
    toDateOnly,
    normalizeDateValue,
    isDateInRange,
    isDateInRangeStrict,
    shiftDate,
    fiscalYearRange,
} from '@steuererklaerung/shared';

export default async () => {
    await describe('toDateOnly', async () => {
        await it('converts ISO datetime to YYYY-MM-DD', async () => {
            expect(toDateOnly('2024-03-15T12:30:00.000Z')).toBe('2024-03-15');
        });

        await it('passes through YYYY-MM-DD unchanged', async () => {
            expect(toDateOnly('2024-01-01')).toBe('2024-01-01');
        });

        await it('returns null for null/undefined/empty', async () => {
            expect(toDateOnly(null)).toBeNull();
            expect(toDateOnly(undefined)).toBeNull();
            expect(toDateOnly('')).toBeNull();
            expect(toDateOnly('   ')).toBeNull();
        });

        await it('returns null for invalid date strings', async () => {
            expect(toDateOnly('not-a-date')).toBeNull();
            expect(toDateOnly('abc')).toBeNull();
        });

        await it('handles date strings with whitespace', async () => {
            expect(toDateOnly('  2024-06-01  ')).toBe('2024-06-01');
        });
    });

    await describe('normalizeDateValue', async () => {
        await it('normalizes string dates', async () => {
            expect(normalizeDateValue('2024-03-15T10:00:00Z')).toBe('2024-03-15');
        });

        await it('returns null for non-string types', async () => {
            expect(normalizeDateValue(42)).toBeNull();
            expect(normalizeDateValue(null)).toBeNull();
            expect(normalizeDateValue(undefined)).toBeNull();
            expect(normalizeDateValue({})).toBeNull();
        });
    });

    await describe('isDateInRange', async () => {
        await it('returns true when date is within range', async () => {
            expect(isDateInRange('2024-03-15', '2024-03-01', '2024-03-31')).toBe(true);
        });

        await it('returns true for dates on the boundaries (inclusive)', async () => {
            expect(isDateInRange('2024-03-01', '2024-03-01', '2024-03-31')).toBe(true);
            expect(isDateInRange('2024-03-31', '2024-03-01', '2024-03-31')).toBe(true);
        });

        await it('returns false when date is outside range', async () => {
            expect(isDateInRange('2024-02-28', '2024-03-01', '2024-03-31')).toBe(false);
            expect(isDateInRange('2024-04-01', '2024-03-01', '2024-03-31')).toBe(false);
        });

        await it('returns true when no bounds specified', async () => {
            expect(isDateInRange('2024-03-15')).toBe(true);
            expect(isDateInRange('2024-03-15', undefined, undefined)).toBe(true);
        });

        await it('handles only lower bound', async () => {
            expect(isDateInRange('2024-03-15', '2024-03-01')).toBe(true);
            expect(isDateInRange('2024-02-15', '2024-03-01')).toBe(false);
        });

        await it('handles only upper bound', async () => {
            expect(isDateInRange('2024-03-15', undefined, '2024-03-31')).toBe(true);
            expect(isDateInRange('2024-04-15', undefined, '2024-03-31')).toBe(false);
        });

        await it('returns true for null/empty dates (lenient)', async () => {
            expect(isDateInRange(null, '2024-03-01', '2024-03-31')).toBe(true);
            expect(isDateInRange('', '2024-03-01', '2024-03-31')).toBe(true);
            expect(isDateInRange(undefined, '2024-03-01', '2024-03-31')).toBe(true);
        });
    });

    await describe('isDateInRangeStrict', async () => {
        await it('returns true when date is within range', async () => {
            expect(isDateInRangeStrict('2024-03-15', '2024-03-01', '2024-03-31')).toBe(true);
        });

        await it('returns false for null/empty dates (strict)', async () => {
            expect(isDateInRangeStrict(null, '2024-03-01', '2024-03-31')).toBe(false);
            expect(isDateInRangeStrict('', '2024-03-01', '2024-03-31')).toBe(false);
        });

        await it('returns false when outside range', async () => {
            expect(isDateInRangeStrict('2024-02-28', '2024-03-01', '2024-03-31')).toBe(false);
        });
    });

    await describe('shiftDate', async () => {
        await it('shifts forward and backward (UTC-safe)', async () => {
            expect(shiftDate('2025-03-10', 5)).toBe('2025-03-15');
            expect(shiftDate('2025-03-10', -5)).toBe('2025-03-05');
            expect(shiftDate('2025-03-10', 0)).toBe('2025-03-10');
        });
        await it('crosses month and year boundaries', async () => {
            expect(shiftDate('2025-01-31', 1)).toBe('2025-02-01');
            expect(shiftDate('2025-03-01', -1)).toBe('2025-02-28');
            expect(shiftDate('2025-01-01', -1)).toBe('2024-12-31');
            expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01');
        });
        await it('handles leap years', async () => {
            expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
            expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29');
        });
        await it('throws on an unparseable date', async () => {
            expect(() => shiftDate('not-a-date', 1)).toThrow();
        });
    });

    await describe('fiscalYearRange', async () => {
        await it('returns the calendar-year span', async () => {
            expect(fiscalYearRange(2025)).toStrictEqual({ from: '2025-01-01', to: '2025-12-31' });
        });
    });
};
