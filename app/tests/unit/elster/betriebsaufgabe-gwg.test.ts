import { describe, it, expect } from '@gjsify/unit';
import { ElsterConfigRawSchema, normalizeElsterConfig } from '../../../src/core/config/index.ts';
import { buildAufgabegewinn } from '../../../src/core/actions/elster/euer.ts';
import { usteEntnahme } from '../../../src/core/actions/elster/uste.ts';

function config(gwg: unknown[], gemeineWerte: Record<string, unknown>[]) {
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

    await describe('Betriebsaufgabe — Realteilung', async () => {
        await it('carries a part taken into a partner business at Buchwert, with no gain', async () => {
            const r = buildAufgabegewinn(
                config(GWG, [
                    { anlagegut_id: 'monitor', gemeiner_wert: 50, uebernehmer: 'p', realteilung: true },
                    { anlagegut_id: 'privat', gemeiner_wert: 35 },
                ]),
                2025,
            )!;
            const monitor = r.assets.find((a) => a.id === 'monitor')!;
            expect(monitor.gewinn).toBe(0);
            expect(monitor.gemeinerWert).toBe(50);
            expect(monitor.realteilung).toBe(true);
            expect(r.aufgabegewinn).toBe(35);
        });

        await it('splits one asset into parts that share its Restbuchwert', async () => {
            const r = buildAufgabegewinn(
                config(
                    [],
                    [
                        { anlagegut_id: 'pc', gemeiner_wert: 400, anteil: 0.7, bezeichnung: 'PC', realteilung: true },
                        { anlagegut_id: 'pc', gemeiner_wert: 100, anteil: 0.3, bezeichnung: 'Grafikkarte' },
                    ],
                ),
                2025,
            )!;
            const ganz = buildAufgabegewinn(config([], [{ anlagegut_id: 'pc', gemeiner_wert: 0 }]), 2025)!;
            const rbw = ganz.assets[0].restbuchwert;
            const teile = r.assets.filter((a) => a.id === 'pc');
            expect(teile.map((a) => a.bezeichnung).join()).toBe('PC,Grafikkarte');
            expect(Math.round((teile[0].restbuchwert + teile[1].restbuchwert) * 100)).toBe(Math.round(rbw * 100));
            expect(r.aufgabegewinn).toBe(Math.round((100 - teile[1].restbuchwert) * 100) / 100);
        });

        await it('refuses parts whose shares do not sum to 1', async () => {
            let fehler = '';
            try {
                buildAufgabegewinn(
                    config(
                        [],
                        [
                            { anlagegut_id: 'pc', gemeiner_wert: 400, anteil: 0.5 },
                            { anlagegut_id: 'pc', gemeiner_wert: 100, anteil: 0.3 },
                        ],
                    ),
                    2025,
                );
            } catch (e) {
                fehler = String(e);
            }
            expect(fehler.includes('pc')).toBe(true);
        });

        await it('books a Realteilung as a Lieferung, not as a §3 Abs. 1b Entnahme', async () => {
            const e = usteEntnahme(
                config(GWG, [
                    { anlagegut_id: 'monitor', gemeiner_wert: 50, realteilung: true },
                    { anlagegut_id: 'privat', gemeiner_wert: 35 },
                ]),
                2025,
            )!;
            expect(e.assets.some((a) => a.bezeichnung === 'Monitor')).toBe(false);
            expect(e.lieferungen?.map((a) => a.bezeichnung).join()).toBe('Monitor');
        });
    });
};
