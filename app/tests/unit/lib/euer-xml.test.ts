import { describe, it, expect } from '@gjsify/unit';
import { buildEuerEds, euerLinesFromAggregate, euerDatenartVersion, type EuerBetrieb } from '../../../src/core/elster/euer-xml.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

const betrieb: EuerBetrieb = {
    name: 'Musterbetrieb GbR',
    strasse: 'Musterstraße 1',
    plz: '12345',
    ort: 'Musterstadt',
    art: 'Softwareentwicklung',
};

// Fictitious ELSTER test Steuernummer (BuFa 9198 = test Finanzamt) — no real data.
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

const cat = (category: string, net: number, vat: number, kind: 'income' | 'expense') => ({
    category,
    bucket: category,
    kz: '',
    kind,
    count: 1,
    net,
    vat,
    gross: net + vat,
});

const agg: EuerTxAggregate = {
    year: 2025,
    basis: 'cash-transactions',
    adjustmentsApplied: true,
    income: [cat('8400 Erlöse 19% USt', 10000, 1900, 'income')],
    expenses: [
        cat('4946 Fremdleistungen', 2000, 380, 'expense'),
        cat('4806 Hosting/Cloud', 500, 95, 'expense'),
        cat('4830 Abschreibungen (AfA)', 300, 0, 'expense'),
    ],
    neutral: [],
    totals: { incomeNet: 10000, outputVat: 1900, expenseNet: 2800, inputVat: 475, profit: 7200, vatPayable: 1425, nachtraeglichNet: 0 },
    coverage: { transactions: 0, classifiedByDocument: 0, classifiedByRule: 0, classifiedByManual: 0, unclassified: [], activeFrom: '2025-01-01', activeTo: '2025-12-31', outsidePeriod: [] },
};

export default async () => {
    await describe('euerLinesFromAggregate', async () => {
        await it('splits income, puts AfA on its own line, misc into übrige, and reconciles the Gewinn', async () => {
            const l = euerLinesFromAggregate(agg);
            expect(l.stPflichtig).toBe(10000);
            expect(l.vereinnahmtUst).toBe(1900);
            expect(l.summeBEin).toBe(11900);
            expect(l.fremdleistung).toBe(2000);
            // AfA (300) maps to its own movable-asset line E6002101; only Hosting (500) is übrige.
            expect(l.afa).toBe(300);
            expect(l.uebrige).toBe(500);
            expect(l.vorsteuer).toBe(475);
            // USt ans FA = annual Zahllast, makes the form Gewinn == net profit
            expect(l.ustAnFa).toBe(1425);
            expect(l.summeBAus).toBe(4700); // 2000 + 300 (AfA) + 500 + 475 + 1425
            expect(l.gewinn).toBe(7200); // == totals.profit
            expect(l.summeBEin - l.summeBAus).toBe(l.gewinn);
        });
    });

    await describe('buildEuerEds', async () => {
        const xml = buildEuerEds(agg, config, betrieb);
        await it('targets the EUER 2025 DatenArt + namespace', async () => {
            expect(euerDatenartVersion(2025)).toBe('EUER_2025');
            expect(xml).toContain('<DatenArt>EUER</DatenArt>');
            expect(xml).toContain('<E77 xmlns="http://finkonsens.de/elster/elstererklaerung/euer/e77/v2025" version="2025">');
            expect(xml).toContain('<Empfaenger id="F">9198</Empfaenger>');
        });
        await it('emits the reconciling Brutto lines + the mandatory Gewinn chain', async () => {
            expect(xml).toContain('<E6000401>10000,00</E6000401>'); // umsatzsteuerpflichtig
            expect(xml).toContain('<E6002101>300,00</E6002101>'); // AfA bewegliche WG
            expect(xml).toContain('<E6001201>11900,00</E6001201>'); // Summe BEin
            expect(xml).toContain('<E6005301>4700,00</E6005301>'); // Summe BAus
            expect(xml).toContain('<E6006801>7200,00</E6006801>'); // korrigierter Gewinn
            expect(xml).toContain('<E6007202>7200,00</E6007202>'); // steuerpflichtiger Gewinn
            expect(xml).toContain('<Copyright>'); // mandatory Vorsatz field
        });
    });

    await describe('Zus_Angabe_EinzelUntern (§4 Abs. 4a EStG Entnahmen/Einlagen)', async () => {
        const einzelBetrieb: EuerBetrieb = { ...betrieb, name: 'Max Mustermann', rechtsform: '120', einkunftsart: '2' };
        const neutralCat = (category: string, gross: number) => ({
            category,
            bucket: category,
            kz: '',
            kind: 'neutral' as const,
            count: 1,
            net: 0,
            vat: 0,
            gross,
        });
        await it('omits the block for a Personengesellschaft/GbR (Rechtsform default 270)', async () => {
            expect(buildEuerEds(agg, config, betrieb).includes('Zus_Angabe_EinzelUntern')).toBe(false);
        });
        await it('emits Entnahmen/Einlagen (0,00) for an Einzelunternehmen even without private draws', async () => {
            const xml = buildEuerEds(agg, config, einzelBetrieb);
            expect(xml).toContain('<Zus_Angabe_EinzelUntern>');
            expect(xml).toContain('<E6006601>0,00</E6006601>');
            expect(xml).toContain('<E6006701>0,00</E6006701>');
        });
        await it('sums 1800 Privatentnahme / 1810 Privateinlage into E6006601 / E6006701 (1360 stays out)', async () => {
            const withDraws: EuerTxAggregate = {
                ...agg,
                neutral: [
                    neutralCat('1800 Privatentnahme', 500),
                    neutralCat('1810 Privateinlage', 250),
                    neutralCat('1360 Interne Überweisung', 999),
                ],
            };
            const l = euerLinesFromAggregate(withDraws);
            expect(l.entnahme).toBe(500);
            expect(l.einlage).toBe(250);
            const xml = buildEuerEds(withDraws, config, einzelBetrieb);
            expect(xml).toContain('<E6006601>500,00</E6006601>');
            expect(xml).toContain('<E6006701>250,00</E6006701>');
        });
    });

    await describe('Anlage AVEÜR (asset register) — required whenever AfA is declared', async () => {
        // EÜR with the same 300 € AfA, but now an Anlageverzeichnis splits it into a
        // Gebäude asset (full-year AfA 120) and a bewegliche WG (full-year AfA 200) → 320.
        const aggAfa: EuerTxAggregate = {
            ...agg,
            expenses: [cat('4830 Abschreibungen (AfA)', 320, 0, 'expense')],
            totals: { ...agg.totals, expenseNet: 320 },
        };
        const cfg: ElsterConfig = {
            ...config,
            adjustments: {
                anlageverzeichnis: [
                    { id: 'g', bezeichnung: 'Einbau', anschaffung: '2020-01-01', ahk: 1200, nutzungsdauer_jahre: 10, restbuchwert_anfang: 600, erinnerungswert: 0, art: 'gebaeude' },
                    { id: 'b', bezeichnung: 'Möbel', anschaffung: '2022-01-01', ahk: 1000, nutzungsdauer_jahre: 5, restbuchwert_anfang: 400, erinnerungswert: 0, art: 'beweglich' },
                ],
                privatanteile: [],
                sonderbetriebsausgaben: [],
                nachtraegliche_posten: [],
                nachtraeglich_gbr_ausgaben_gegenseiten: [],
                doppelzahlungen: [],
                zahlungen_geprueft: [],
            },
        };
        const xml = buildEuerEds(aggAfa, cfg, betrieb);
        await it('splits the AfA into the Gebäude (E6001901) and bewegliche (E6002101) lines', async () => {
            expect(xml).toContain('<E6001901>120,00</E6001901>');
            expect(xml).toContain('<E6002101>200,00</E6002101>');
        });
        await it('emits the AVEÜR block whose rollups EQUAL the EÜR AfA lines (ERiC cross-check)', async () => {
            expect(xml).toContain('<AVEUER>');
            expect(xml).toContain('<E6007071>120,00</E6007071>'); // == E6001901
            expect(xml).toContain('<E6007372>200,00</E6007372>'); // == E6002101
            // Buchwerte: Beginn 600/400, Ende 480/200.
            expect(xml).toContain('<E6007035>600,00</E6007035>');
            expect(xml).toContain('<E6007043>480,00</E6007043>');
            expect(xml).toContain('<E6007355>400,00</E6007355>');
            expect(xml).toContain('<E6007365>200,00</E6007365>');
        });
    });

    await describe('Bewirtung (Anlage EÜR Zeile 63: Kz 165 nicht abziehbar, Kz 175 abziehbar)', async () => {
        const neutral = (category: string, net: number, vat: number) => ({ ...cat(category, net, vat, 'expense'), kind: 'neutral' as const });
        const mitBewirtung: EuerTxAggregate = {
            ...agg,
            expenses: [...agg.expenses, cat('4654 Bewirtungskosten', 70, 13.3, 'expense')],
            neutral: [neutral('4654 Nicht abziehbare Bewirtungskosten', 30, 5.7)],
            totals: { ...agg.totals, expenseNet: 2870, inputVat: 494, profit: 7130, vatPayable: 1406 },
        };
        const l = euerLinesFromAggregate(mitBewirtung);
        await it('puts the 70 % on the abziehbar column and only it into Summe BAus', async () => {
            expect(l.bewirtungAbziehbar).toBe(70);
            expect(l.bewirtungNichtAbziehbar).toBe(30);
            expect(l.uebrige).toBe(500); // Bewirtung no longer hides in „übrige"
            expect(l.gewinn).toBe(7130); // == totals.profit: the 30 % never reduce it
        });
        await it('emits both columns inside Beschr_abziehbar', async () => {
            const xml = buildEuerEds(mitBewirtung, config, betrieb);
            expect(xml).toContain('<E6004101>30,00</E6004101>');
            expect(xml).toContain('<E6004102>70,00</E6004102>');
            expect(xml.indexOf('<Beschr_abziehbar>') > xml.indexOf('<Sonst_unbeschraenkt>')).toBe(true);
            expect(xml.indexOf('<Beschr_abziehbar>') < xml.indexOf('<Summe_BAus>')).toBe(true);
        });
    });

    await describe('negative lines after a refund of an earlier year (Idee 9)', async () => {
        await it('keeps a negative übrige line as it is (ERiC takes it)', async () => {
            const l = euerLinesFromAggregate({ ...agg, expenses: [cat('4930 Bürobedarf', -80, -15.2, 'expense')] });
            expect(l.uebrige).toBe(-80);
        });
        await it('moves a negative GWG line to übrige — its schema type is NichtNeg', async () => {
            const l = euerLinesFromAggregate({
                ...agg,
                expenses: [cat('0420 Büroeinrichtung/GWG', -300, -57, 'expense'), cat('4806 Hosting/Cloud', 500, 95, 'expense')],
            });
            expect(l.gwg).toBe(0);
            expect(l.uebrige).toBe(200);
        });
        await it('shows a negative nicht abziehbare Bewirtung as 0 — it never reduced the profit', async () => {
            const l = euerLinesFromAggregate({
                ...agg,
                neutral: [{ ...cat('4654 Nicht abziehbare Bewirtungskosten', -30, -5.7, 'expense'), kind: 'neutral' as const }],
            });
            expect(l.bewirtungNichtAbziehbar).toBe(0);
            expect(buildEuerEds({ ...agg }, config, betrieb)).not.toContain('<E6004101>');
        });
    });

    await describe('schema year and Art des Betriebs', async () => {
        await it('writes the E77 of 2024 for 2024, with the Steuernummer heading Allg', async () => {
            const xml = buildEuerEds({ ...agg, year: 2024 }, config, betrieb);
            expect(xml).toContain('<E77 xmlns="http://finkonsens.de/elster/elstererklaerung/euer/e77/v2024" version="2024">');
            expect(xml.indexOf('<E6000026>') < xml.indexOf('<E6000016>')).toBe(true);
            const x25 = buildEuerEds(agg, config, betrieb);
            expect(x25.indexOf('<E6000026>') > x25.indexOf('<E6000025>')).toBe(true);
        });
        await it('refuses an Art des Betriebs longer than ELSTER takes (25 characters)', async () => {
            let message = '';
            try {
                buildEuerEds(agg, config, { ...betrieb, art: 'Webdesign und Softwareentwicklung' });
            } catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            expect(message).toContain('höchstens 25');
        });
    });
};
