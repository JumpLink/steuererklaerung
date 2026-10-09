import { describe, it, expect } from '@gjsify/unit';
import {
    buildFeststellungEds,
    feststellungDatenartVersion,
    mitunternehmerArt,
} from '../../../src/core/elster/feststellung-xml.ts';
import { computeFeststellung } from '../../../src/core/elster/feststellung.ts';
import type { EuerBetrieb } from '../../../src/core/elster/euer-xml.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

const betrieb: EuerBetrieb = {
    name: 'Muster GbR',
    strasse: 'Musterstraße 12',
    plz: '12345',
    ort: 'Musterstadt',
    art: 'Mediengestaltung',
};

// Fictional Muster-IdNrn only (never a real Steuer-IdNr in a committed test).
const makeConfig = (quotes: [number, number]): ElsterConfig =>
    ({
        tax_number: '9198011310010',
        schema_version: 2025,
        period: { year: 2025, quarter: 4 },
        output_directory: '/tmp',
        test_mode: true,
        taxation_basis: 'ist',
        ust_dauerfristverlaengerung: false,
        exclude_tags: [],
        include_tags: [],
        entity_id: 'artcode',
        account_labels: {},
        betrieb,
        business_end_date: '2025-10-31',
        gesellschafter: [
            { id: 'a', name: 'Erika Musterfrau', steuer_id: '11111111111', quote: quotes[0], anrede: 'Frau', geburtsdatum: '1970-01-01' },
            { id: 'b', name: 'Max Mustermann', steuer_id: '22222222222', quote: quotes[1], anrede: 'Herr', geburtsdatum: '1969-12-31' },
        ],
    }) as unknown as ElsterConfig;

/** All values of a leaf field, in document order. */
const fieldValues = (xml: string, field: string): string[] =>
    [...xml.matchAll(new RegExp(`<${field}>([^<]*)</${field}>`, 'g'))].map((m) => m[1]);
const deAmt = (s: string): number => Number.parseFloat(s.replace(',', '.'));
const round2 = (n: number): number => Math.round(n * 100) / 100;
// @gjsify/unit toEqual uses `==` (reference-compares arrays) → compare joined strings.
const eq = (actual: unknown[], expected: unknown[]): void => expect(actual.join('|')).toBe(expected.join('|'));

export default async () => {
    await describe('buildFeststellungEds — Anlage FE-G + per-Beteiligter Aufteilung', async () => {
        // The real GbR case: 50/50, per-head Sonderbetriebsausgaben 630 €, Betriebsaufgabe
        // with an odd-cent Aufgabeverlust → Prüfblatt Partner A −9,06 € / Partner B −9,05 €.
        const config = makeConfig([0.5, 0.5]);
        const result = computeFeststellung(
            2533.74,
            config.gesellschafter.map((g) => ({ id: g.id, name: g.name, steuerId: g.steuer_id, quote: g.quote })),
            2025,
            { a: 630, b: 630 },
            -1291.85,
        );
        const xml = buildFeststellungEds(result, config, betrieb);

        await it('targets the FEIN 2025 DatenArt + token + NO_BASE64 compression', async () => {
            expect(feststellungDatenartVersion(2025)).toBe('FEIN_90_2025');
            expect(xml).toContain('<DatenArt>FEIN</DatenArt>');
            expect(xml).toContain('<Kompression>NO_BASE64</Kompression>');
            expect(xml).toContain('<E90 xmlns="http://finkonsens.de/elster/elstererklaerung/fein/e90/v2025" version="2025">');
        });

        await it('uses Anlage FE-G (Gewerbebetrieb), NOT FE-L (Land- und Forstwirtschaft)', async () => {
            expect(xml).toContain('<FE_G>');
            expect(xml).not.toContain('<FE_L>');
            expect(xml).not.toContain('E9733101'); // FE-L laufende Einkünfte
            expect(xml).not.toContain('E9013150'); // FE-L Gewinnermittlungsart
        });

        await it('writes the Beteiligten-IdNr into Ordn_Krit (E9146070), not Nat_Pers', async () => {
            expect(xml).toContain('<Ordn_Krit>');
            eq(fieldValues(xml, 'E9146070'), ['11111111111', '22222222222']);
        });

        await it('sets the Mitunternehmer-Art E9145101 to "4" for a GbR (not "1"=OHG)', async () => {
            eq(fieldValues(xml, 'E9145101'), ['4', '4']);
        });

        await it('50/50 → Art_Auft "2" (nach Bruchteilen) with the quote-driven Bruchteil per FB', async () => {
            expect(xml).toContain('<E9011011>2</E9011011>');
            // Auft_Bruch: Zähler 1 / Nenner 2 for each partner (0.5 → 1/2).
            eq(fieldValues(xml, 'E9850013'), ['1', '1']);
            eq(fieldValues(xml, 'E9850014'), ['2', '2']);
        });

        await it('emits the Gesamthand rows: laufend nach Schlüssel, SBA-Saldo, Aufgabe + Zeitpunkt', async () => {
            expect(xml).toContain('<E9014100>2533,74</E9014100>'); // laufende Einkünfte nach Schlüssel
            expect(xml).not.toContain('E9014102'); // no "abweichend" row in Bruchteil mode
            expect(xml).toContain('<E9014113>-1260,00</E9014113>'); // Saldo SBE − SBA (Gesamthand)
            expect(xml).toContain('<E9014134>31.10.2025</E9014134>'); // Zeitpunkt der Aufgabe (ganzer Betrieb)
            expect(xml).toContain('<E9014130>-1291,85</E9014130>'); // Aufgabeverlust Gesamthand (§16)
        });

        await it('emits one <Bet> per Beteiligtem carrying only the partner-specific SBA saldo', async () => {
            expect((xml.match(/<Bet>/g) ?? []).length).toBe(2);
            // FB Beteiligter 1,2 then FE_G Bet Beteiligter 1,2 — same numbering.
            eq(fieldValues(xml, 'Beteiligter'), ['1', '2', '1', '2']);
            eq(fieldValues(xml, 'E9114113'), ['-630,00', '-630,00']); // −SBA per head
            expect(xml).not.toContain('E9114102'); // no explicit per-Bet laufend in Bruchteil mode
            expect(xml).not.toContain('E9114130'); // Aufgabe stays at Gesamthand in Bruchteil mode
        });

        await it('reconciles the XML decomposition to the Prüfblatt −9,06 / −9,05 per head', async () => {
            const lfdGes = deAmt(fieldValues(xml, 'E9014100')[0]); // 2533,74
            const aufgGes = deAmt(fieldValues(xml, 'E9014130')[0]); // −1291,85
            const sba = fieldValues(xml, 'E9114113').map(deAmt); // [−630, −630]
            // Per head: laufend×½ + Aufgabe×½ + SBA-Saldo = −9,055 → rounds to {−9,06, −9,05}.
            const rawPerHead = result.allocations.map(
                (a, i) => lfdGes * a.gesellschafter.quote + aufgGes * a.gesellschafter.quote + sba[i],
            );
            for (const r of rawPerHead) expect(Math.round(r * 1000) / 1000).toBe(-9.055);
            // The two heads together carry the full Gesamthand (no cent lost).
            expect(round2(rawPerHead[0] + rawPerHead[1])).toBe(result.einkuenfteGesamt); // −18,11
            // The computed allocation (what the Prüfblatt prints) is exactly Partner A −9,06 / Partner B −9,05.
            eq(result.allocations.map((a) => a.gesamtAnteil), [-9.06, -9.05]);
            expect(round2(result.allocations[0].gesamtAnteil + result.allocations[1].gesamtAnteil)).toBe(-18.11);
        });

        await it('omits the rejected Nat_Pers-IdNr and Kommanditisten-Kapitalkonten', async () => {
            expect(xml).not.toContain('Kapktn_Entw'); // Vollhafter-GbR: no handelsrechtliche Kapitalkonten
        });
    });

    await describe('buildFeststellungEds — andere Aufteilung (Art_Auft "0")', async () => {
        // Non-clean Bruchteile → explicit per-Beteiligter amounts.
        const config = makeConfig([1 / 3, 2 / 3]);
        const result = computeFeststellung(
            3000,
            config.gesellschafter.map((g) => ({ id: g.id, name: g.name, steuerId: g.steuer_id, quote: g.quote })),
            2025,
            { a: 300, b: 600 },
            -900,
        );
        const xml = buildFeststellungEds(result, config, betrieb);

        await it('falls back to Art_Auft "0" with no Auft_Bruch', async () => {
            expect(xml).toContain('<E9011011>0</E9011011>');
            expect(xml).not.toContain('E9850013');
            expect(xml).not.toContain('E9850014');
        });

        await it('assigns laufend / SBA / Aufgabe explicitly per <Bet> = the allocations', async () => {
            expect(xml).toContain('<E9014102>3000,00</E9014102>'); // Gesamthand "abweichend"
            const toDe = (n: number): string => n.toFixed(2).replace('.', ',');
            eq(fieldValues(xml, 'E9114102'), result.allocations.map((a) => toDe(a.laufenderAnteil)));
            eq(fieldValues(xml, 'E9114113'), result.allocations.map((a) => toDe(-a.sonderbetriebsausgaben)));
            eq(fieldValues(xml, 'E9114130'), result.allocations.map((a) => toDe(a.aufgabegewinnAnteil)));
        });

        await it('the explicit per-<Bet> amounts sum to each Gesamtanteil', async () => {
            const lfd = fieldValues(xml, 'E9114102').map(deAmt);
            const sba = fieldValues(xml, 'E9114113').map(deAmt);
            const aufg = fieldValues(xml, 'E9114130').map(deAmt);
            for (let i = 0; i < result.allocations.length; i++) {
                expect(round2(lfd[i] + sba[i] + aufg[i])).toBe(result.allocations[i].gesamtAnteil);
            }
        });
    });

    await describe('mitunternehmerArt (E9145101) from the Rechtsform (E6000602)', async () => {
        await it('GbR (default / 270 / 271) → "4" (sonstiger Mitunternehmer ohne Haftungsbeschränkung)', async () => {
            expect(mitunternehmerArt(undefined)).toBe('4');
            expect(mitunternehmerArt('270')).toBe('4');
            expect(mitunternehmerArt('271')).toBe('4');
        });
        await it('OHG (210) → "1" (persönlich haftender Gesellschafter einer OHG)', async () => {
            expect(mitunternehmerArt('210')).toBe('1');
        });
    });

    await describe('before 2025 (Anlage FE 1)', async () => {
        await it('refuses a year whose Einkünfte belong on the Anlage FE 1', async () => {
            const config = makeConfig([0.5, 0.5]);
            const gesellschafter = config.gesellschafter.map((g) => ({
                id: g.id,
                name: g.name,
                steuerId: g.steuer_id,
                quote: g.quote,
            }));
            const result = computeFeststellung(1000, gesellschafter, 2024, {}, 0);
            let message = '';
            try {
                buildFeststellungEds(result, config, betrieb);
            } catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            expect(message).toContain('Anlage FE 1');
        });
    });
};
