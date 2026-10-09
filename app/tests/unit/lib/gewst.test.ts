import { describe, it, expect } from '@gjsify/unit';
import { computeGewst } from '../../../src/core/elster/gewst.ts';

export default async () => {
    await describe('computeGewst', async () => {
        await it('yields a €0 Messbetrag when profit is below the €24.500 Freibetrag (artcode case)', async () => {
            const r = computeGewst({ profit: 2332.38, hebesatz: 480, gemeinde: 'Musterstadt', year: 2025 });
            expect(r.gewerbeertrag).toBe(2332.38);
            expect(r.gewerbeertragRounded).toBe(2300); // §11 abrunden auf volle 100 €
            expect(r.bemessungsgrundlage).toBe(0);
            expect(r.messbetrag).toBe(0);
            expect(r.gewerbesteuer).toBe(0);
        });

        await it('computes Messbetrag above the Freibetrag with §11 rounding', async () => {
            // 50.000 → −24.500 = 25.500 → ×3,5 % = 892,50
            const r = computeGewst({ profit: 50_049, hebesatz: 400, gemeinde: 'X', year: 2025 });
            expect(r.gewerbeertragRounded).toBe(50_000);
            expect(r.bemessungsgrundlage).toBe(25_500);
            expect(r.messbetrag).toBe(892.5);
            expect(r.gewerbesteuer).toBe(3570); // 892,50 × 400 %
        });

        await it('applies §8 Nr.1 only on the financing sum above €200.000', async () => {
            // 240.000 financing → 25 % of 40.000 = 10.000 add-back
            const r = computeGewst({
                profit: 100_000,
                hinzurechnungen: { finanzierungsanteile: 240_000 },
                hebesatz: 400,
                gemeinde: 'X',
                year: 2025,
            });
            expect(r.sumHinzurechnungen).toBe(10_000);
            expect(r.gewerbeertrag).toBe(110_000);
        });

        await it('subtracts §9 Kürzungen', async () => {
            const r = computeGewst({
                profit: 30_000,
                kuerzungen: { spenden: 500, grundbesitz: 100 },
                hebesatz: 400,
                gemeinde: 'X',
                year: 2025,
            });
            expect(r.sumKuerzungen).toBe(600);
            expect(r.gewerbeertrag).toBe(29_400);
        });
    });
};
