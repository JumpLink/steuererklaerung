import { describe, it, expect } from '@gjsify/unit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKontoabfrageEds } from '../../../src/core/elster/kontoabfrage-xml.ts';
import {
    parseKontoabfrage,
    fehlendeAnmeldungen,
    parseGermanAmount,
} from '../../../src/core/elster/kontoabfrage-parse.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

/**
 * The Steuerkontoabfrage asks the Finanzamt what IT has on record — the one thing this codebase
 * otherwise has to infer. The parser is exercised against the VENDOR's own example answer
 * (shipped with ERiC 43.4.6.0), not a hand-written one: an answer we invented would only prove
 * that the parser reads what we imagined the schema to be.
 */

// Fictitious Steuernummer (Niedersachsen FF/BBB/UUUUP) — no real data.
const config: ElsterConfig = {
    tax_number: '18/815/08152',
    schema_version: 2025,
    period: { year: 2025, quarter: 1 },
    output_directory: '/tmp',
    test_mode: true,
    taxation_basis: 'ist',
    ust_dauerfristverlaengerung: false,
    exclude_tags: [],
    include_tags: [],
    entity_id: 'artcode',
    account_labels: {},
    gesellschafter: [],
    hersteller_id: '39542',
    datenlieferant: 'Meier & Schulz GbR',
};

// Anchored on cwd like the other fixture readers here (see tests/unit/config/*): the test bundle
// lives in dist/, so a path relative to this module resolves against the bundle, not the source.
const VENDOR_ANSWER = readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'kontoabfrage', 'antwort-hersteller-beispiel.xml'),
    'utf8',
);

export default async () => {
    await describe('buildKontoabfrageEds', async () => {
        await it('asks for the Sollstellungen of one Steuerart and year (ZS)', async () => {
            const xml = buildKontoabfrageEds(config, { art: 'ZS', steuerart: 'USt', zeitraum: 2025 });
            expect(xml).toContain('<Verfahren>ElsterKontoabfrage</Verfahren>');
            expect(xml).toContain('<DatenArt>Kontoabfrage</DatenArt>');
            expect(xml).toContain('<zs:kontoabfrage-art>ZS</zs:kontoabfrage-art>');
            expect(xml).toContain('<zs:steuerart>USt</zs:steuerart>');
            expect(xml).toContain('<zs:zeitraum>2025</zs:zeitraum>');
            // The Steuernummer goes in the 13-digit ELSTER form, as everywhere else —
            // 18/815/08152 becomes 2318081508152 (BuFa 2318 + the local part).
            expect(xml).toContain('<zs:steuernummer>2318081508152</zs:steuernummer>');
        });

        await it('asks for the offene Posten with nothing but the Steuernummer (O)', async () => {
            const xml = buildKontoabfrageEds(config, { art: 'O' });
            expect(xml).toContain('<o:kontoabfrage-art>O</o:kontoabfrage-art>');
            // The discriminator: an O query must NOT narrow by Steuerart or period — doing so
            // would silently answer a different question than the caller asked.
            expect(xml).not.toContain('steuerart>');
            expect(xml).not.toContain('zeitraum>');
        });

        await it('routes to the clearing destination, not to a Bundesland', async () => {
            // A query is not a filing: the declarations send `<Ziel>NI</Ziel>`, this one CS.
            const xml = buildKontoabfrageEds(config, { art: 'O' });
            expect(xml).toContain('<Ziel>CS</Ziel>');
            expect(xml).not.toContain('<Ziel>NI</Ziel>');
        });

        await it('escapes the Datenlieferant like every other builder', async () => {
            // Same defect class that made ERiC reject every filing of a GbR whose name has an `&`.
            const xml = buildKontoabfrageEds(config, { art: 'O' });
            expect(xml).toContain('Meier &amp; Schulz GbR');
            expect(xml).not.toContain('<DatenLieferant>Meier & Schulz GbR</DatenLieferant>');
        });
    });

    await describe('parseKontoabfrage — gegen die Hersteller-Beispielantwort', async () => {
        const result = parseKontoabfrage(VENDOR_ANSWER);

        await it('reads the header the Finanzamt stamps on its answer', async () => {
            expect(result.steuernummer).toBe('199/262/11407');
            expect(result.tagesdatum?.startsWith('09.05.2023')).toBe(true);
        });

        await it('groups the entries by Steuerart', async () => {
            expect(result.steuerarten.length).toBeGreaterThan(0);
            expect(result.steuerarten.some((g) => g.steuerart === 'Lohnsteuer')).toBe(true);
            // Every group carries its periods — an empty one would mean the block nesting was lost.
            expect(result.steuerarten.every((g) => Array.isArray(g.teilbetraege))).toBe(true);
        });

        await it('surfaces the periods the Finanzamt marks as never filed', async () => {
            // This is the whole point: "Anmeldung fehlt" is the Finanzamt's own answer to the
            // question the filing register cannot answer, because the register only records what
            // WE told it — a return filed by a former Steuerberater leaves no trace there.
            const fehlend = fehlendeAnmeldungen(result);
            expect(fehlend.length).toBeGreaterThan(0);
        });

        await it('finds nothing missing for a Steuerart the answer does not mention', async () => {
            // The discriminator: the filter must be able to come back empty, or "nothing missing"
            // would be indistinguishable from "did not look".
            expect(fehlendeAnmeldungen(result, 'Kaffeesteuer').length).toBe(0);
        });
    });

    await describe('parseGermanAmount', async () => {
        await it('reads the German decimal form', async () => {
            expect(parseGermanAmount('1.234,56')).toBe(1234.56);
            expect(parseGermanAmount('-440,57')).toBe(-440.57);
            expect(parseGermanAmount('0,00')).toBe(0);
        });

        await it('answers undefined instead of NaN for anything unparseable', async () => {
            // A NaN poisons every sum it reaches; a missing amount is a normal case here.
            expect(parseGermanAmount(undefined)).toBe(undefined);
            expect(parseGermanAmount('Anmeldung fehlt')).toBe(undefined);
            expect(parseGermanAmount('')).toBe(undefined);
        });
    });
};
