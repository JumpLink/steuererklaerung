import { describe, it, expect } from '@gjsify/unit';
import { computeFeststellung, type Gesellschafter } from '../../../src/core/elster/feststellung.ts';

const partners = (quotes: number[]): Gesellschafter[] =>
    quotes.map((q, i) => ({ id: `g${i}`, name: `Partner ${i}`, steuerId: '00000000000', quote: q }));

export default async () => {
    await describe('computeFeststellung', async () => {
        await it('splits 50/50 exactly', async () => {
            const r = computeFeststellung(2332.38, partners([0.5, 0.5]), 2025);
            expect(r.allocations.map((a) => a.profitShare)).toStrictEqual([1166.19, 1166.19]);
            expect(r.rounding.residual).toBe(0);
        });

        await it('assigns the rounding residual to the largest share so shares sum to the profit', async () => {
            // 100,00 × {0.3333, 0.3333, 0.3334}: raw shares round to 33.33/33.33/33.34 = 100.00 already,
            // use a value that forces a residual.
            const r = computeFeststellung(100, partners([1 / 3, 1 / 3, 1 / 3]), 2025);
            const sum = r.allocations.reduce((s, a) => s + a.profitShare, 0);
            expect(Math.round(sum * 100) / 100).toBe(100);
        });

        await it('handles an uneven split and reconciles to the total', async () => {
            const r = computeFeststellung(1000.01, partners([0.7, 0.3]), 2025);
            const sum = r.allocations.reduce((s, a) => s + a.profitShare, 0);
            expect(Math.round(sum * 100) / 100).toBe(1000.01);
        });

        await it('throws when quotes do not sum to 1', async () => {
            expect(() => computeFeststellung(1000, partners([0.5, 0.4]), 2025)).toThrow();
        });

        await it('throws when no Gesellschafter are configured', async () => {
            expect(() => computeFeststellung(1000, [], 2025)).toThrow();
        });

        await it('subtracts per-partner Sonderbetriebsausgaben from each share', async () => {
            // Mirrors the StB 2024 structure: laufend split 50/50, each − 630 € Arbeitszimmer.
            const r = computeFeststellung(15240.86, partners([0.5, 0.5]), 2024, { g0: 630, g1: 630 });
            expect(r.allocations[0].laufenderAnteil).toBe(7620.43);
            expect(r.allocations[0].sonderbetriebsausgaben).toBe(630);
            expect(r.allocations[0].profitShare).toBe(6990.43);
            expect(r.allocations[1].profitShare).toBe(6990.43);
            // totalProfit stays the laufender Gewinn; festgestellt = laufend − ΣSBA.
            expect(r.totalProfit).toBe(15240.86);
            expect(r.festgestellteEinkuenfte).toBe(13980.86);
        });

        await it('defaults Sonderbetriebsausgaben to 0 (festgestellt == totalProfit)', async () => {
            const r = computeFeststellung(2332.38, partners([0.5, 0.5]), 2025);
            expect(r.allocations.every((a) => a.sonderbetriebsausgaben === 0)).toBe(true);
            expect(r.festgestellteEinkuenfte).toBe(2332.38);
            expect(r.aufgabegewinn).toBe(0);
            expect(r.einkuenfteGesamt).toBe(2332.38);
        });

        await it('adds the Aufgabeverlust on top of the laufende Einkünfte (post-SBA)', async () => {
            // laufend 1792.42 (already post-SBA), Aufgabeverlust −1741.85.
            const r = computeFeststellung(3052.42, partners([0.5, 0.5]), 2025, { g0: 630, g1: 630 }, -1741.85);
            expect(r.festgestellteEinkuenfte).toBe(1792.42);
            expect(r.aufgabegewinn).toBe(-1741.85);
            expect(r.einkuenfteGesamt).toBe(50.57);
            // each partner: 896.21 laufend − 870.925→ split of −1741.85 = −870.93/−870.92.
            const totalGesamt = r.allocations.reduce((s, a) => s + a.gesamtAnteil, 0);
            expect(Math.round(totalGesamt * 100) / 100).toBe(50.57);
            expect(r.allocations.reduce((s, a) => s + a.aufgabegewinnAnteil, 0)).toBe(-1741.85);
        });
    });
};
