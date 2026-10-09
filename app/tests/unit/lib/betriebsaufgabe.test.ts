import { describe, it, expect } from '@gjsify/unit';
import { computeAufgabegewinn, type AfaAssetBookValue } from '../../../src/core/elster/betriebsaufgabe.ts';

const assets: AfaAssetBookValue[] = [
    { id: 'einbau', bezeichnung: 'Eingangstür', restbuchwertEnde: 354.09 },
    { id: 'moebel', bezeichnung: 'IKEA Regale', restbuchwertEnde: 218.71 },
];

export default async () => {
    await describe('computeAufgabegewinn', async () => {
        await it('is an Aufgabeverlust of the full Restbuchwert when gemeiner Wert = 0', async () => {
            const r = computeAufgabegewinn(assets, { einbau: 0, moebel: 0 }, 0, '2025-10-31');
            expect(r.assets[0].gewinn).toBe(-354.09);
            expect(r.assets[1].gewinn).toBe(-218.71);
            expect(r.aufgabegewinn).toBe(-572.8);
        });

        await it('defaults a missing gemeiner Wert to the Restbuchwert (0 gain)', async () => {
            const r = computeAufgabegewinn(assets, {}, 0, '2025-10-31');
            expect(r.assets.every((a) => a.gewinn === 0)).toBe(true);
            expect(r.aufgabegewinn).toBe(0);
        });

        await it('yields an Aufgabegewinn when gemeiner Wert exceeds the Restbuchwert', async () => {
            const r = computeAufgabegewinn([{ id: 'x', bezeichnung: 'X', restbuchwertEnde: 100 }], { x: 250 });
            expect(r.entnahmegewinn).toBe(150);
            expect(r.aufgabegewinn).toBe(150);
        });

        await it('subtracts Aufgabekosten', async () => {
            const r = computeAufgabegewinn([{ id: 'x', bezeichnung: 'X', restbuchwertEnde: 100 }], { x: 250 }, 40);
            expect(r.aufgabegewinn).toBe(110);
        });
    });
};
