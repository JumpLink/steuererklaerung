import { describe, it, expect } from '@gjsify/unit';
import { ElsterConfigRawSchema, normalizeElsterConfig } from '../../../src/core/config/index.ts';
import { buildAufgabegewinn } from '../../../src/core/actions/elster/euer.ts';
import { usteEntnahme } from '../../../src/core/actions/elster/uste.ts';

function config(gwg: unknown[], gemeineWerte: { anlagegut_id: string; gemeiner_wert: number }[]) {
    return normalizeElsterConfig(
        ElsterConfigRawSchema.parse({
            tax_number: '',
            period: { year: 2025, quarter: 1 },
            entity_id: 'test',
            business_end_date: '2025-10-31',
            gesellschafter: [],
            adjustments: {
                anlageverzeichnis: [
                    {
                        id: 'pc',
                        bezeichnung: 'PC',
                        anschaffung: '2020-03-03',
                        ahk: 1000,
                        nutzungsdauer_jahre: 3,
                        restbuchwert_anfang: 0,
                    },
                ],
                gwg,
                betriebsaufgabe: { gemeine_werte: gemeineWerte },
            },
            account_labels: {},
        }),
    );
}

const GWG = [
    { id: 'monitor', bezeichnung: 'Monitor', anschaffung: '2020-06-30', ahk: 234.45 },
    { id: 'privat', bezeichnung: 'Ohne Vorsteuer', anschaffung: '2021-01-03', ahk: 68.55, vorsteuerabzug: false },
    { id: 'spaeter', bezeichnung: 'Nach der Aufgabe', anschaffung: '2025-11-15', ahk: 100 },
];

export default async () => {
    await describe('Betriebsaufgabe — GWG', async () => {
        await it('withdraws a GWG at its gemeiner Wert against a Buchwert of 0', async () => {
            const r = buildAufgabegewinn(
                config(GWG, [
                    { anlagegut_id: 'pc', gemeiner_wert: 300 },
                    { anlagegut_id: 'monitor', gemeiner_wert: 70 },
                    { anlagegut_id: 'privat', gemeiner_wert: 35 },
                ]),
                2025,
            )!;
            const monitor = r.assets.find((a) => a.id === 'monitor')!;
            expect(monitor.restbuchwert).toBe(0);
            expect(monitor.gewinn).toBe(70);
            expect(r.aufgabegewinn).toBe(405);
        });

        await it('leaves out a GWG bought after the Aufgabe', async () => {
            const r = buildAufgabegewinn(config(GWG, [{ anlagegut_id: 'spaeter', gemeiner_wert: 80 }]), 2025)!;
            expect(r.assets.some((a) => a.id === 'spaeter')).toBe(false);
            expect(r.aufgabegewinn).toBe(0);
        });

        await it('taxes a GWG Entnahme unless it was bought without Vorsteuer', async () => {
            const e = usteEntnahme(
                config(GWG, [
                    { anlagegut_id: 'monitor', gemeiner_wert: 70 },
                    { anlagegut_id: 'privat', gemeiner_wert: 35 },
                ]),
                2025,
            )!;
            const namen = e.assets.map((a) => a.bezeichnung);
            expect(namen.includes('Monitor')).toBe(true);
            expect(namen.includes('Ohne Vorsteuer')).toBe(false);
        });
    });
};
