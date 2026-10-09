import { describe, it, expect } from '@gjsify/unit';
import {
    usteVordruckLine,
    buildUsteVordruckRows,
    buildUsteAnpassungen,
} from '../../../src/core/elster/vordruck-lines.ts';
import { computeUsteFormFigures, type UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';

// Muster aggregate exercising every line (19 %, §3 Abs. 1b/9a Wertabgaben, §13b, prepaid).
const muster: UsteAggregate = {
    year: 2025,
    net_19: 10_650.9,
    lieferungenSonstLeistungen_19: 10_000.9,
    wertabgabeLieferung_19: 450,
    wertabgabeSonstige_19: 200,
    entnahmeAssets: [{ bezeichnung: 'Muster-PC', gemeinerWert: 450 }],
    net_7: 0,
    net_0: 0,
    vat_out: 2058.62,
    vat_in: 475.33,
    vatPayable: 1583.29,
    prepaidVat: 1000,
    closingBalance: 583.29,
    prepaidVatSource: 'register',
    reverseCharge: { abs1Base: 558.4, abs1Tax: 106.1, abs2Base: 100.7, abs2Tax: 19.13, deductibleVat: 125.23, count: 3 },
};

export default async () => {
    // The line numbers come from the LOCAL ERiC Jahresdokumentation_50_2025.xml ("USt2A - Felder",
    // column "Vordruckzeile"); pin the known anchors so a wrong-year/wrong-figure mapping is caught.
    await describe('usteVordruckLine — amtliche Vordruckzeilen (UStE 2025)', async () => {
        await it('maps Zeile 22 = Lieferungen/sonstige Leistungen 19 %', async () => {
            const l = usteVordruckLine(2025, 'lieferungen19');
            expect(l?.zeile).toBe(22);
            expect(l?.kennzahl).toBe('E3003303');
        });

        await it('maps Zeile 24 = unentgeltliche Wertabgabe § 3 Abs. 9a (Privatanteil)', async () => {
            const l = usteVordruckLine(2025, 'wertabgabeSonstige19');
            expect(l?.zeile).toBe(24);
            expect(l?.kennzahl).toBe('E3003505');
        });

        await it('maps Zeile 67 = §13b Abs. 2 (Drittland / andere Leistungen)', async () => {
            const l = usteVordruckLine(2025, 'reverseChargeAbs2');
            expect(l?.zeile).toBe(67);
            expect(l?.kennzahl).toBe('E3102503');
        });

        await it('maps Zeile 119 = Vorauszahlungssoll', async () => {
            const l = usteVordruckLine(2025, 'vorauszahlungssoll');
            expect(l?.zeile).toBe(119);
            expect(l?.kennzahl).toBe('E3011301');
        });

        await it('returns undefined for an unknown year (never guesses)', async () => {
            expect(usteVordruckLine(2099, 'lieferungen19')).toBeUndefined();
        });
    });

    await describe('buildUsteVordruckRows — figures placed on their lines', async () => {
        await it('emits BMG lines as whole euro and the closing chain as steuer, in Vordruck order', async () => {
            const rows = buildUsteVordruckRows(computeUsteFormFigures(muster), 2025);
            const byKey = new Map(rows.map((r) => [r.figureKey, r]));
            // BMG line: Zeile 22 with the whole-euro base.
            expect(byKey.get('lieferungen19')?.zeile).toBe(22);
            expect(byKey.get('lieferungen19')?.art).toBe('bmg');
            expect(byKey.get('lieferungen19')?.betrag).toBe(10_000);
            // §13b base line 65 present.
            expect(byKey.get('reverseChargeAbs1')?.zeile).toBe(65);
            // Closing line 120 is a steuer amount.
            expect(byKey.get('abschluss')?.zeile).toBe(120);
            expect(byKey.get('abschluss')?.art).toBe('steuer');
            // Ordered by appearance (22 before 120).
            expect(rows[0].figureKey).toBe('lieferungen19');
        });

        await it('omits absent lines (no §13b, no 7 %) without warning', async () => {
            const warnings: string[] = [];
            const rows = buildUsteVordruckRows(
                computeUsteFormFigures({ ...muster, net_7: 0, reverseCharge: undefined }),
                2025,
                (m) => warnings.push(m),
            );
            expect(rows.find((r) => r.figureKey === 'reverseChargeAbs1')).toBeUndefined();
            expect(rows.find((r) => r.figureKey === 'ermaessigt7')).toBeUndefined();
            expect(warnings.length).toBe(0);
        });

        await it('warns (does not guess) when the year has no mapping', async () => {
            const warnings: string[] = [];
            const rows = buildUsteVordruckRows(computeUsteFormFigures(muster), 2099, (m) => warnings.push(m));
            expect(rows.length).toBe(0);
            expect(warnings.length > 0).toBe(true);
        });
    });

    await describe('buildUsteAnpassungen — stille Anpassungen sichtbar', async () => {
        await it('places the Telefon-Privatanteil on Zeile 24 (§ 3 Abs. 9a UStG)', async () => {
            const rows = buildUsteAnpassungen(
                { privatanteile: [{ bezeichnung: 'Telefon', netto: 200, ust_satz: 0.19 }] },
                2025,
            );
            expect(rows.length).toBe(1);
            expect(rows[0].bezeichnung).toBe('Telefon');
            expect(rows[0].betrag).toBe(200);
            expect(rows[0].zeile).toBe(24);
            expect(rows[0].rechtsgrund.includes('§ 3 Abs. 9a')).toBe(true);
            expect(rows[0].ustWirksam).toBe(true);
        });

        await it('places the Betriebsaufgabe-Entnahme on Zeile 23 (§ 3 Abs. 1b UStG), skips gemeiner Wert 0', async () => {
            const rows = buildUsteAnpassungen(
                {
                    entnahmeAssets: [
                        { bezeichnung: 'CSL PC', gemeinerWert: 150 },
                        { bezeichnung: 'IKEA Regal', gemeinerWert: 0 },
                    ],
                },
                2025,
            );
            expect(rows.length).toBe(1);
            expect(rows[0].zeile).toBe(23);
            expect(rows[0].rechtsgrund.includes('§ 3 Abs. 1b')).toBe(true);
        });

        await it('marks Sonderbetriebsausgaben as a Feststellung matter with no USt line', async () => {
            const rows = buildUsteAnpassungen(
                { sonderbetriebsausgaben: [{ gesellschafter_id: 'partner2', bezeichnung: 'Häusliches Arbeitszimmer', betrag: 630 }] },
                2025,
            );
            expect(rows.length).toBe(1);
            expect(rows[0].zeile).toBeUndefined();
            expect(rows[0].ustWirksam).toBe(false);
            expect(rows[0].ziel.includes('Feststellung')).toBe(true);
        });
    });
};
