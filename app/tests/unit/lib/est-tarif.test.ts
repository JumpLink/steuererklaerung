import { describe, it, expect } from '@gjsify/unit';
import { estTarif, estTarifSplitting, estTarifProgression, soliOnEst } from '../../../src/core/elster/est-tarif.ts';

// Tarif values verified against docs/references/tax-sources.md (§32a VZ 2025). The linear zones
// (4/5), the zero zone and the Splitting/Soli edges are exact by construction; the formula-zone
// checks assert zone-boundary CONTINUITY (which catches coefficient/boundary typos) rather than a
// hand-computed value. Cross-check mid-zone values against www.bmf-steuerrechner.de before relying
// on the estimate for a filing.
export default async () => {
    await describe('estTarif §32a 2025 — Grundtarif', async () => {
        await it('is 0 at and below the Grundfreibetrag (12.096)', async () => {
            expect(estTarif(0, 2025)).toBe(0);
            expect(estTarif(12096, 2025)).toBe(0);
            expect(estTarif(12097, 2025)).toBe(0); // formula yields ~0,14 → floored to 0
        });

        await it('is continuous across the zone 2/3 boundary (17.443 / 17.444)', async () => {
            const a = estTarif(17443, 2025);
            const b = estTarif(17444, 2025);
            expect(a).toBe(1015); // ≈ zone3E constant 1.015,13
            expect(b - a <= 1).toBeTruthy();
        });

        await it('is continuous across the zone 3/4 boundary (68.480 / 68.481)', async () => {
            const a = estTarif(68480, 2025);
            const b = estTarif(68481, 2025);
            expect(b).toBe(17850); // 0,42·68.481 − 10.911,92 = 17.850,10
            expect(b - a <= 1).toBeTruthy();
        });

        await it('applies the linear 42 % zone exactly (100.000 → 31.088)', async () => {
            // 0,42·100.000 − 10.911,92 = 31.088,08 → 31.088
            expect(estTarif(100000, 2025)).toBe(31088);
        });

        await it('applies the linear 45 % zone exactly (300.000 → 115.753)', async () => {
            // 0,45·300.000 − 19.246,67 = 115.753,33 → 115.753
            expect(estTarif(300000, 2025)).toBe(115753);
        });

        await it('floors the taxable income to whole euro', async () => {
            expect(estTarif(100000.99, 2025)).toBe(estTarif(100000, 2025));
        });
    });

    await describe('estTarifSplitting §32a 2025', async () => {
        await it('halves the zvE: a couple at 24.000 pays 0 (each half < Grundfreibetrag)', async () => {
            expect(estTarifSplitting(24000, 2025)).toBe(0);
            expect(estTarif(24000, 2025) > 0).toBeTruthy(); // a single at 24.000 does pay
        });

        await it('equals ~2× the Grundtarif on half the income', async () => {
            const split = estTarifSplitting(100000, 2025);
            const doubleHalf = 2 * estTarif(50000, 2025);
            expect(Math.abs(split - doubleHalf) <= 2).toBeTruthy();
        });
    });

    await describe('soliOnEst §3/§4 SolZG 2025', async () => {
        await it('is 0 below the Freigrenze (Einzel 19.950)', async () => {
            expect(soliOnEst(10000, 'einzel', 2025)).toBe(0);
            expect(soliOnEst(19950, 'einzel', 2025)).toBe(0);
        });

        await it('caps at the Milderungszone rate just above the Freigrenze', async () => {
            // (30.000 − 19.950)·11,9 % = 1.195,95  <  30.000·5,5 % = 1.650 → Milderung greift
            expect(soliOnEst(30000, 'einzel', 2025)).toBe(1195.95);
        });

        await it('reaches the full 5,5 % above the Milderungszone', async () => {
            // 100.000·5,5 % = 5.500  <  (100.000 − 19.950)·11,9 % → voller Satz greift
            expect(soliOnEst(100000, 'einzel', 2025)).toBe(5500);
        });
    });

    await describe('per-year keying', async () => {
        await it('uses the distinct 2026 Grundfreibetrag (12.348 vs 12.096)', async () => {
            // 12.200 is taxable in 2025 (GFB 12.096) but tax-free in 2026 (GFB 12.348)
            expect(estTarif(12200, 2025) > 0).toBeTruthy();
            expect(estTarif(12200, 2026)).toBe(0);
        });

        await it('throws for an unsourced year', async () => {
            expect(() => estTarif(50000, 2099)).toThrow();
        });
    });

    await describe('estTarifProgression §32b — besonderer Steuersatz', async () => {
        await it('equals the normal Tarif without Progressionsleistungen', async () => {
            expect(estTarifProgression(40000, 0, 'einzel', 2025)).toBe(estTarif(40000, 2025));
        });

        await it('raises the tax for positive Leistungen (Elterngeld erhöht den Satz)', async () => {
            // Satz aus Tarif(50.000)/50.000, angewandt auf 40.000 → mehr als Tarif(40.000).
            expect(estTarifProgression(40000, 10000, 'einzel', 2025) > estTarif(40000, 2025)).toBe(true);
        });

        await it('lowers the tax for a repayment (negativer Progressionsvorbehalt)', async () => {
            expect(estTarifProgression(42240, -538.53, 'einzel', 2025) < estTarif(42240, 2025)).toBe(true);
        });

        await it('is 0 when the rate base (zvE + Leistungen) is not positive', async () => {
            expect(estTarifProgression(5000, -6000, 'einzel', 2025)).toBe(0);
        });

        await it('applies the modified average rate to the unchanged zvE', async () => {
            const zvE = 40000;
            const pv = 8000;
            const satz = estTarif(zvE + pv, 2025) / (zvE + pv);
            expect(estTarifProgression(zvE, pv, 'einzel', 2025)).toBe(Math.floor(zvE * (Math.round(satz * 1e6) / 1e6)));
        });
    });
};
