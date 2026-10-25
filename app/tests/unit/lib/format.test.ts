import { describe, it, expect } from '@gjsify/unit';
import { eur, num2 } from '../../../src/core/lib/format.ts';

export default async () => {
    await describe('eur', async () => {
        await it('shows a negative zero without its sign', async () => {
            expect(eur(-0)).toBe(eur(0));
            expect(eur(-0.001)).toBe(eur(0));
        });

        await it('keeps the sign of an amount that shows', async () => {
            expect(eur(-0.01)).toContain('-0,01');
            expect(eur(-12.5)).toContain('-12,50');
        });

        await it('renders a missing amount as a dash', async () => {
            expect(eur(null)).toBe('—');
        });
    });

    await describe('num2', async () => {
        await it('shows a negative zero without its sign', async () => {
            expect(num2(-0)).toBe('0,00');
        });
    });
};
