import { describe, it, expect } from '@gjsify/unit';
import { buildUsteEds, usteDatenartVersion, dauerUnternehmereigenschaft } from '../../../src/core/elster/uste-xml.ts';
import type { EuerBetrieb } from '../../../src/core/elster/euer-xml.ts';
import type { UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

const betrieb: EuerBetrieb = {
    name: 'Musterbetrieb GbR',
    strasse: 'Musterstraße 1',
    plz: '12345',
    ort: 'Musterstadt',
    art: 'Softwareentwicklung',
    widnr: 'DE123456788',
};

const config: ElsterConfig = {
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
    gesellschafter: [],
};

const agg: UsteAggregate = {
    year: 2025,
    net_19: 10000,
    lieferungenSonstLeistungen_19: 10000,
    wertabgabeLieferung_19: 0,
    wertabgabeSonstige_19: 0,
    net_7: 0,
    net_0: 0,
    vat_out: 1900,
    vat_in: 475,
    vatPayable: 1425,
    prepaidVat: 1000,
    closingBalance: 425,
};

export default async () => {
    await describe('dauerUnternehmereigenschaft', async () => {
        await it('omits the Dauer for a full calendar year', async () => {
            expect(dauerUnternehmereigenschaft(2025)).toBeUndefined();
            expect(dauerUnternehmereigenschaft(2025, '2025-01-01', '2025-12-31')).toBeUndefined();
        });
        await it('emits TT.MM-TT.MM for a mid-year Betriebsaufgabe', async () => {
            expect(dauerUnternehmereigenschaft(2025, undefined, '2025-10-31')).toBe('01.01-31.10');
            expect(dauerUnternehmereigenschaft(2025, '2025-03-15', '2025-10-31')).toBe('15.03-31.10');
        });
    });

    await describe('buildUsteEds', async () => {
        const xml = buildUsteEds(agg, config, betrieb);
        await it('targets the USt 2025 DatenArt + namespace', async () => {
            expect(usteDatenartVersion(2025)).toBe('USt_2025');
            expect(xml).toContain('<DatenArt>USt</DatenArt>');
            expect(xml).toContain('<E50 xmlns="http://finkonsens.de/elster/elstererklaerung/ust/e50/v2025" version="2025">');
        });
        await it('emits integer net + decimal tax, W-IdNr, split address, and the Berech chain', async () => {
            expect(xml).toContain('<E3000401>DE123456788</E3000401>'); // W-IdNr
            expect(xml).toContain('<E3001101>Musterstraße</E3001101>'); // street
            expect(xml).toContain('<E3001203>1</E3001203>'); // Hausnummer split from strasse
            expect(xml).toContain('<E3003303>10000</E3003303>'); // net = full euros (no comma)
            expect(xml).toContain('<E3003304>1900,00</E3003304>'); // USt = decimal
            expect(xml).toContain('<E3009901>475,00</E3009901>'); // Vorsteuer
            expect(xml).toContain('<E3011101>1425,00</E3011101>'); // verbleibende USt
            expect(xml).toContain('<E3011301>1000,00</E3011301>'); // Vorauszahlungssoll
            expect(xml).toContain('<E3011401>425,00</E3011401>'); // Abschlusszahlung
        });

        await it('emits §13b (Ums_13b + E3006502 + E3009502), zahllastneutral', async () => {
            const agg13b: UsteAggregate = {
                ...agg,
                reverseCharge: { abs1Base: 558, abs1Tax: 106.1, abs2Base: 100, abs2Tax: 19, deductibleVat: 125.1, count: 4 },
            };
            const x = buildUsteEds(agg13b, config, betrieb);
            expect(x).toContain('<Ums_13b>');
            expect(x).toContain('<E3102205>558</E3102205>'); // Abs. 1 EU base (integer euro)
            expect(x).toContain('<E3102206>106,10</E3102206>'); // Abs. 1 tax
            expect(x).toContain('<E3102503>100</E3102503>'); // Abs. 2 base
            expect(x).toContain('<E3102504>19,00</E3102504>'); // Abs. 2 tax
            expect(x).toContain('<E3102601>125,10</E3102601>'); // Summe der Steuer
            expect(x).toContain('<E3006502>125,10</E3006502>'); // Vorsteuer aus §13b
            expect(x).toContain('<E3009502>125,10</E3009502>'); // geschuldete §13b USt
            expect(x).toContain('<E3009801>2025,10</E3009801>'); // Zwischensumme = 1900 + 125,10
            expect(x).toContain('<E3009901>600,10</E3009901>'); // Vorsteuer = 475 + 125,10
            expect(x).toContain('<E3011101>1425,00</E3011101>'); // verbleibende USt UNCHANGED (nets)
            // Ums_13b sits after Umsaetze, before Abz_VoSt
            expect(x.indexOf('<Ums_13b>')).toBeLessThan(x.indexOf('<Abz_VoSt>'));
        });

        // The annual Vordruck splits Kz 81 over Zeile 22 / 23 / 24 — the USt-VA does not. The
        // Wertabgaben NEST inside Ums_allg (E3003405/06 = §3 Abs. 1b, E3003505/06 = §3 Abs. 9a).
        await it('nests the unentgeltliche Wertabgaben inside Ums_allg, each with its own tax', async () => {
            const x = buildUsteEds(
                {
                    ...agg,
                    net_19: 10_650,
                    lieferungenSonstLeistungen_19: 10_000,
                    wertabgabeLieferung_19: 450, // Betriebsaufgabe-Entnahme §3 Abs. 1b
                    wertabgabeSonstige_19: 200, // Telefon-Privatanteil §3 Abs. 9a
                },
                config,
                betrieb,
            );
            expect(x).toContain('<E3003303>10000</E3003303>'); // Zeile 22 ohne die Wertabgaben
            expect(x).toContain('<E3003405>450</E3003405>');
            expect(x).toContain('<E3003406>85,50</E3003406>'); // 450 × 19 %
            expect(x).toContain('<E3003505>200</E3003505>');
            expect(x).toContain('<E3003506>38,00</E3003506>'); // 200 × 19 %
            // Ums_Sum must equal the three per-line taxes: 1900,00 + 85,50 + 38,00
            expect(x).toContain('<E3006001>2023,50</E3006001>');
            expect(x.indexOf('<Unent_Wertabgaben>')).toBeGreaterThan(x.indexOf('<Ums_allg>'));
        });

        await it('omits Unent_Wertabgaben entirely when there are none', async () => {
            expect(buildUsteEds(agg, config, betrieb)).not.toContain('<Unent_Wertabgaben>');
        });
    });

    await describe('schema year', async () => {
        await it('writes the E50 of 2024 and 2026 for those years, 2024 without the W-IdNr', async () => {
            const x24 = buildUsteEds({ ...agg, year: 2024 }, config, betrieb);
            expect(x24).toContain('<E50 xmlns="http://finkonsens.de/elster/elstererklaerung/ust/e50/v2024" version="2024">');
            expect(x24).not.toContain('<E3000401>');
            const x26 = buildUsteEds({ ...agg, year: 2026 }, config, betrieb);
            expect(x26).toContain('/ust/e50/v2026" version="2026">');
            expect(x26).toContain('<E3000401>DE123456788</E3000401>');
        });
    });
};
