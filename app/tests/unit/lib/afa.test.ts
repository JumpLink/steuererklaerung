import { describe, it, expect } from '@gjsify/unit';
import { computeAfa, afaGroupTotals, type Anlagegut } from '../../../src/core/elster/afa.ts';

const asset = (over: Partial<Anlagegut>): Anlagegut => ({
    id: 'a',
    bezeichnung: 'Asset',
    anschaffung: '2021-01-01',
    ahk: 1200,
    nutzungsdauerJahre: 5,
    restbuchwertAnfang: 600,
    erinnerungswert: 0,
    art: 'beweglich',
    ...over,
});

export default async () => {
    await describe('computeAfa', async () => {
        await it('charges a full linear year when the business runs all year', async () => {
            const r = computeAfa([asset({})], 2025);
            // 1200 / 5 = 240 full-year AfA; RBW 600 → 360.
            expect(r.assets[0].afa).toBe(240);
            expect(r.assets[0].restbuchwertEnde).toBe(360);
            expect(r.totalAfa).toBe(240);
            expect(r.restbuchwertEnde).toBe(360);
        });

        await it('pro-rates AfA to the month of a Betriebsaufgabe', async () => {
            // Business ceased 31.10. → 10/12 of the 240 annual AfA = 200.
            const r = computeAfa([asset({})], 2025, '2025-10-31');
            expect(r.assets[0].months).toBe(10);
            expect(r.assets[0].afa).toBe(200);
            expect(r.assets[0].restbuchwertEnde).toBe(400);
        });

        await it('never depreciates below the Erinnerungswert', async () => {
            // Already at the 1 € memo value → no further AfA.
            const r = computeAfa([asset({ restbuchwertAnfang: 1, erinnerungswert: 1 })], 2025);
            expect(r.assets[0].afa).toBe(0);
            expect(r.assets[0].restbuchwertEnde).toBe(1);
        });

        await it('caps AfA at the remaining depreciable book value', async () => {
            // Annual AfA 240, but only 100 left above the floor → AfA capped at 100.
            const r = computeAfa([asset({ restbuchwertAnfang: 100 })], 2025);
            expect(r.assets[0].afa).toBe(100);
            expect(r.assets[0].restbuchwertEnde).toBe(0);
        });

        await it('matches the 2024 Anlageverzeichnis projected into 2025 (10-month Aufgabe)', async () => {
            const assets: Anlagegut[] = [
                { id: '178001', bezeichnung: 'Eingangstür', anschaffung: '2019-07-01', ahk: 1698.3, nutzungsdauerJahre: 8, restbuchwertAnfang: 531, erinnerungswert: 0, art: 'gebaeude' },
                { id: '178002', bezeichnung: 'Fußboden', anschaffung: '2020-09-30', ahk: 2253.38, nutzungsdauerJahre: 10, restbuchwertAnfang: 1276, erinnerungswert: 0, art: 'gebaeude' },
                { id: '410002', bezeichnung: 'PC i9', anschaffung: '2021-06-23', ahk: 1379.54, nutzungsdauerJahre: 3, restbuchwertAnfang: 1, erinnerungswert: 1, art: 'beweglich' },
                { id: '420001', bezeichnung: 'IKEA Regale', anschaffung: '2021-10-12', ahk: 1195.77, nutzungsdauerJahre: 5, restbuchwertAnfang: 418, erinnerungswert: 0, art: 'beweglich' },
                { id: '420002', bezeichnung: 'IKEA Schränke', anschaffung: '2021-05-05', ahk: 787.03, nutzungsdauerJahre: 5, restbuchwertAnfang: 210, erinnerungswert: 0, art: 'beweglich' },
            ];
            const r = computeAfa(assets, 2025, '2025-10-31');
            // 176.91 + 187.78 + 0 + 199.29 + 131.17 = 695.15
            expect(r.totalAfa).toBe(695.15);
            // remaining book value at Aufgabe (the Betriebsaufgabe-Entnahme basis)
            expect(r.restbuchwertEnde).toBe(1740.85);
            // AVEÜR group split: Gebäude (Einbauten) 364.69, bewegliche WG 330.46.
            expect(afaGroupTotals(r, 'gebaeude').afa).toBe(364.69);
            expect(afaGroupTotals(r, 'beweglich').afa).toBe(330.46);
            expect(afaGroupTotals(r, 'gebaeude').buchwertEnde).toBe(1442.31);
        });

        await it('returns zero AfA after the business-end year', async () => {
            const r = computeAfa([asset({})], 2026, '2025-10-31');
            expect(r.totalAfa).toBe(0);
            expect(r.assets[0].months).toBe(0);
        });
    });
};
