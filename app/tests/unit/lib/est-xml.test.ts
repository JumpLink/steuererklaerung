import { describe, it, expect } from '@gjsify/unit';
import {
    buildEstEds,
    buildEstNutzdaten,
    bundeslandZiel,
    estDatenartVersion,
    freitext,
    kindZeitraum,
} from '../../../src/core/elster/est-xml.ts';
import { buildEstInputs } from '../../../src/core/actions/elster/est.ts';
import type { EstConfig } from '../../../src/core/config/index.ts';
import type { EstTxAggregate, EstTxDetailRow } from '../../../src/core/elster/est-aggregate.ts';

// Fictional Muster values only (never a real IdNr/Steuernummer/figure in a committed test).
const makeConfig = (): EstConfig =>
    ({
        entity_id: 'privat',
        veranlagung: 'einzel',
        output_directory: '/tmp',
        test_mode: true,
        person: {
            name: 'Erika Musterfrau',
            vorname: 'Erika',
            nachname: 'Musterfrau',
            steuer_id: '11111111111',
            steuernummer: '9198011310010',
            finanzamt: 'Finanzamt Musterstadt',
            bundesland: 'Niedersachsen',
            geburtsdatum: '1970-01-01',
            beruf: 'Musterberuf',
            strasse: 'Musterstraße',
            hausnummer: '12',
            plz: '12345',
            ort: 'Musterstadt',
            iban: 'DE91100000000123456789',
            kirchensteuersatz: 0,
            kinder: 2,
        },
        // Fictional Muster children (never real IdNr/Geburtsdaten in a committed test).
        kinder: [
            {
                vorname: 'Kim',
                nachname: 'Beispiel',
                idnr: '22222222222',
                geburtsdatum: '2015-03-02',
                familienkasse: 'Familienkasse Musterland',
                kindschaftsverhaeltnis: '1',
                anderer_elternteil: {
                    name: 'Beispiel, Erna',
                    geburtsdatum: '1985-06-01',
                    adresse: 'Musterweg 1, 12345 Musterstadt',
                    kindschaftsverhaeltnis: '1',
                    wohnsitz_unbekannt: false,
                },
                jahre: [
                    {
                        jahr: 2025,
                        kindergeld_anspruch: 1530,
                        schulgeld: { schule: 'Freie Musterschule e.V.', gezahlt: 2680, von_mir: 2680 },
                        kinderbetreuung: [],
                    },
                ],
            },
            {
                vorname: 'Toni',
                idnr: '33333333333',
                geburtsdatum: '2025-04-20',
                kindschaftsverhaeltnis: '1',
                anderer_elternteil: {
                    name: 'Frau Unbekannt',
                    kindschaftsverhaeltnis: '1',
                    wohnsitz_unbekannt: true,
                },
                jahre: [
                    {
                        jahr: 2025,
                        kindergeld_anspruch: 2295,
                        haushalt: { gemeinsam_zeitraum: '20.04-31.12', gemeinsam_kind_zeitraum: '20.04-31.12' },
                        kinderbetreuung: [
                            {
                                bezeichnung: 'Kinderhort Musterstadt, Musterweg 5, 12345 Musterstadt',
                                zeitraum_von: '01.06',
                                zeitraum_bis: '31.12',
                                betrag: 1200.5,
                                erstattet: 200,
                            },
                        ],
                    },
                ],
            },
        ],
        jahre: [
            {
                jahr: 2025,
                bruttoarbeitslohn: 40000,
                steuerklasse: 1,
                lohnsteuer: 5000.5,
                soli: 0,
                kirchensteuer: 0,
                est_vorauszahlung: 0,
                einkuenfte_gewerbe: 500.53,
                gewerbe_bezeichnung: 'Mustergewerbe',
                gewerbe_beteiligungen: [],
                spenden: 50,
                krankheitskosten: 100,
                schulgeld: 0,
                kinderbetreuung: 0,
                parteibeitrag: 0,
                vorsorge: {
                    rv_arbeitnehmer: 3000.4,
                    rv_arbeitgeber_steuerfrei: 3000.4,
                    kv_basis: 2800.6,
                    pv_basis: 500.2,
                    av_arbeitnehmer: 400.3,
                    sonstige: 0,
                    ag_zuschuss: true,
                },
                werbungskosten: {
                    homeoffice_tage: 100,
                    homeoffice_anderer_arbeitsplatz: false,
                    posten: [{ bezeichnung: 'Fachliteratur', betrag: 120 }],
                },
                par35a_manuell: { handwerker: 0, haushaltsnah: 0, minijob: 0 },
            },
        ],
        par35a_arbeitskosten: [],
        reklassifizierungen: [],
    }) as unknown as EstConfig;

const detailRows: EstTxDetailRow[] = [
    {
        id: 't1',
        accountKey: 'fints:muster',
        bookingDate: '2025-03-01',
        counterparty: 'Zahnarztpraxis Muster',
        amount: -85.8,
        bucket: 'gesundheit',
        source: 'rule',
        betrag: 85.8,
    },
    {
        id: 't2',
        accountKey: 'fints:muster',
        bookingDate: '2025-05-10',
        counterparty: 'Musterverein e.V.',
        purpose: 'Spende',
        amount: -50,
        bucket: 'spenden',
        source: 'rule',
        betrag: 50,
    },
    {
        id: 't3',
        accountKey: 'fints:muster',
        bookingDate: '2025-08-20',
        counterparty: 'Malermeister Muster',
        amount: -450.99,
        bucket: 'handwerker',
        source: 'rule',
        betrag: 450.99,
        arbeitskostenOverride: 200.49,
    },
];

const makeAggregate = (): EstTxAggregate => ({
    year: 2025,
    werbungskostenPosten: [],
    handwerkerArbeitskosten: 200.49,
    handwerkerBrutto: 450.99,
    haushaltsnahArbeitskosten: 0,
    haushaltsnahBrutto: 0,
    par35aOhneArbeitskosten: 0,
    spenden: 50,
    krankheitskosten: 85.8,
    vorsorgeKandidat: 0,
    kapitalertraege: 0,
    gehaltNettoSumme: 0,
    buckets: [],
    coverage: { transactions: 3, classifiedByRule: 3, unclassified: [] },
    detail: detailRows,
});

const build = (mutate?: (config: EstConfig) => void): string => {
    const config = makeConfig();
    mutate?.(config);
    const aggregate = makeAggregate();
    return buildEstEds(config, buildEstInputs(config, aggregate, 2025), aggregate);
};

const fieldValue = (xml: string, field: string): string | undefined =>
    xml.match(new RegExp(`<${field}>([^<]*)</${field}>`))?.[1];

export default async () => {
    await describe('buildEstEds — Einkommensteuer E10-2025 (envelope + Anlagen order)', async () => {
        const xml = build();

        await it('targets DatenArt ESt / ESt_2025 / GZIP with the E10-2025 Nutzdaten root', async () => {
            expect(estDatenartVersion(2025)).toBe('ESt_2025');
            expect(xml).toContain('<DatenArt>ESt</DatenArt>');
            expect(xml).toContain('<Kompression>GZIP</Kompression>');
            expect(xml).toContain(
                '<E10 xmlns="http://finkonsens.de/elster/elstererklaerung/est/e10/v2025" version="2025">',
            );
            expect(xml).toContain('<Unterfallart>10</Unterfallart>');
        });

        await it('carries the Land-Ziel Empfänger (id="L") like the official ESt example', async () => {
            expect(xml).toContain('<Empfaenger id="L">');
            expect(xml).toContain('<Ziel>NI</Ziel>');
            expect(bundeslandZiel('Niedersachsen')).toBe('NI');
            expect(bundeslandZiel('BY')).toBe('BY');
            expect(bundeslandZiel('Atlantis')).toBe(undefined);
        });

        await it('emits the Anlagen in the binding E10 sequence order (Kind zwischen HA_35a und G)', async () => {
            const order = ['<ESt1A>', '<SA>', '<AgB>', '<HA_35a>', '<Kind>', '<G>', '<N>', '<VOR>', '<Vorsatz>'];
            const idx = order.map((tag) => xml.indexOf(tag));
            for (const i of idx) expect(i > -1).toBe(true);
            for (let i = 1; i < idx.length; i++) expect(idx[i] > idx[i - 1]).toBe(true);
        });

        await it('ESt1A: Art_Erkl X, Religion 11 — and NO Vlg_Art for an unmarried person', async () => {
            expect(xml).toContain('<E0100001>X</E0100001>');
            // E0100081 is a SYSTEM-inserted field — ERiC rejects user XML carrying it;
            // the IdNr goes into the Vorsatz <ID> only.
            expect(xml).not.toContain('<E0100081>');
            expect(fieldValue(xml, 'E0100402')).toBe('11'); // kirchensteuersatz 0 → not liable for Kirchensteuer
            expect(xml).not.toContain('<Vlg_Art>');
            expect(xml).not.toContain('E0102602'); // Einzelveranlagung von EHEGATTEN — never for singles
        });

        await it('Anlage N: Steuerklasse + Brutto ohne Cent, Lohnsteuer MIT Cent, keine 0-Abzüge', async () => {
            expect(fieldValue(xml, 'E0200002')).toBe('1');
            expect(fieldValue(xml, 'E0200201')).toBe('40000'); // GeldBetragOhneCent
            expect(fieldValue(xml, 'E0200301')).toBe('5000,50'); // GeldBetragMitCent
            expect(xml).not.toContain('<E0200401>'); // Soli 0 → omitted
            expect(xml).not.toContain('<E0200501>'); // KiSt 0 → omitted
        });

        await it('Homeoffice: flag=false → E0206206 (dauerhaft kein anderer Arbeitsplatz)', async () => {
            expect(fieldValue(xml, 'E0206206')).toBe('100');
            expect(xml).not.toContain('<E0204507>');
            const other = build((c) => {
                (c.jahre[0].werbungskosten as { homeoffice_anderer_arbeitsplatz?: boolean }).homeoffice_anderer_arbeitsplatz = true;
            });
            expect(fieldValue(other, 'E0204507')).toBe('100');
            expect(other).not.toContain('<E0206206>');
        });

        await it('Entfernungspauschale names the erste Tätigkeitsstätte (E0203501, ERiC requires it)', async () => {
            const mitWeg = build((c) => {
                (c.jahre[0].werbungskosten as { pendel?: unknown }).pendel = {
                    arbeitstage: 40,
                    km_einfach: 12,
                    ziel: '12345 Musterstadt, Am Deich 1',
                };
            });
            expect(fieldValue(mitWeg, 'E0203501')).toBe('12345 Musterstadt, Am Deich 1');
            expect(mitWeg.indexOf('<E0203501>') < mitWeg.indexOf('<E0203503>')).toBe(true);
        });

        await it('Werbungskosten-Posten land in Weitere_Wk/Sonst with a matching Sum', async () => {
            expect(fieldValue(xml, 'E0205405')).toBe('Fachliteratur');
            expect(fieldValue(xml, 'E0205406')).toBe('120');
            expect(fieldValue(xml, 'E0204803')).toBe('120');
        });

        await it('VOR: RV-AN und RV-AG erscheinen GEMEINSAM (Plausi 950020), kaufmännisch gerundet', async () => {
            expect(fieldValue(xml, 'E2000401')).toBe('3000');
            expect(fieldValue(xml, 'E2000801')).toBe('3000');
            expect(fieldValue(xml, 'E2001203')).toBe('2801'); // KV 2800,60 → 2801
            expect(fieldValue(xml, 'E2001505')).toBe('500'); // PV 500,20 → 500
            expect(fieldValue(xml, 'E2004403')).toBe('400'); // AV Nr. 27 → its own line
        });

        await it('SA Spenden: tx-Einzelaufstellung + Sum_Best incl. manuellem Config-Anteil', async () => {
            expect(xml).toContain('Musterverein e.V.');
            expect(fieldValue(xml, 'E0108103')).toBe('50');
            expect(fieldValue(xml, 'E0108105')).toBe('100'); // 50 (tx) + 50 (config)
        });

        await it('AgB Krankheitskosten: Einzelaufstellung (aufgerundet) + Summe + Erstattung 0', async () => {
            expect(xml).toContain('Zahnarztpraxis Muster');
            expect(fieldValue(xml, 'E0161302')).toBe('86'); // 85,80 rounded up
            expect(fieldValue(xml, 'E0161304')).toBe('186'); // 86 + 100 (manual)
            expect(fieldValue(xml, 'E0161303')).toBe('0');
            expect(fieldValue(xml, 'E0161305')).toBe('0');
        });

        await it('§35a Handwerker: Rechnungsbetrag + Lohnanteil je Posten, Summe = Lohnanteile', async () => {
            expect(fieldValue(xml, 'E0170601')).toBe('451'); // Rechnungsbetrag 450,99 →
            expect(fieldValue(xml, 'E0111214')).toBe('201'); // Lohnanteil 200,49 →
            expect(fieldValue(xml, 'E0111215')).toBe('201'); // Sum = Lohnanteile, NOT Rechnungsbeträge
        });

        await it('Anlage G: Bezeichnung + Gewinn in vollen Euro (abgerundet)', async () => {
            expect(fieldValue(xml, 'E0800301')).toBe('Mustergewerbe');
            expect(fieldValue(xml, 'E0800302')).toBe('500'); // 500,53 → full euro in the taxpayer's favour
        });

        await it('Ges_Fest: Beteiligungen aus der Config mit Finanzamt + Summe', async () => {
            const withBet = build((c) => {
                c.jahre[0].gewerbe_beteiligungen = [
                    { bezeichnung: 'Muster GbR', finanzamt: '9198', betrag: -9.06 },
                ];
            });
            expect(fieldValue(withBet, 'E0800501')).toBe('Muster GbR');
            expect(fieldValue(withBet, 'E0800704')).toBe('9198');
            expect(fieldValue(withBet, 'E0800504')).toBe('-10'); // Verlust rounded down (in the taxpayer's favour)
            expect(fieldValue(withBet, 'E0800502')).toBe('-10');
        });

        await it('Anlage Kind: ein Block je Kind mit IdNr, Namen, Geburtsdatum, Kindergeld-Anspruch', async () => {
            const kinds = xml.match(/<Kind>/g) ?? [];
            expect(kinds.length).toBe(2);
            expect(fieldValue(xml, 'E0500406')).toBe('22222222222');
            expect(fieldValue(xml, 'E0500107')).toBe('Kim');
            expect(fieldValue(xml, 'E0500108')).toBe('Beispiel'); // abweichender Familienname
            expect(fieldValue(xml, 'E0500701')).toBe('02.03.2015');
            expect(fieldValue(xml, 'E0500702')).toBe('1530'); // half the yearly Anspruch, full €
            expect(fieldValue(xml, 'E0500706')).toBe('Familienkasse Musterland');
            expect(fieldValue(xml, 'E0500703')).toBe('01.01-31.12'); // Wohnsitz Inland, whole year
        });

        await it('Anlage Kind: unterjährig geborenes Kind → Zeiträume ab Geburtsdatum', async () => {
            const toni = xml.slice(xml.indexOf('33333333333'));
            expect(fieldValue(toni, 'E0500701')).toBe('20.04.2025');
            expect(fieldValue(toni, 'E0500703')).toBe('20.04-31.12'); // Wohnsitz from birth
            expect(fieldValue(toni, 'E0500601')).toBe('20.04-31.12'); // Kindschaftsverhältnis from birth
            expect(toni.includes('<E0500108>')).toBe(false); // no abweichender Familienname
            expect(kindZeitraum('2025-04-20', 2025)).toBe('20.04-31.12');
            expect(kindZeitraum('2015-03-02', 2025)).toBe('01.01-31.12');
        });

        await it('K_Verh: Verhältnis zur erklärenden Person + der andere Elternteil (K_Verh_and_P)', async () => {
            expect(fieldValue(xml, 'E0500807')).toBe('1'); // biological child
            expect(fieldValue(xml, 'E0501103')).toBe('Beispiel, Erna');
            expect(fieldValue(xml, 'E0501104')).toBe('01.06.1985');
            expect(fieldValue(xml, 'E0501105')).toBe('Musterweg 1, 12345 Musterstadt');
            expect(fieldValue(xml, 'E0501106')).toBe('1');
            // E0501513 (Wohnsitz nicht zu ermitteln → full Kinderfreibetrag) only on the 2nd child:
            const kim = xml.slice(xml.indexOf('22222222222'), xml.indexOf('33333333333'));
            expect(kim.includes('<E0501513>')).toBe(false);
            const toni = xml.slice(xml.indexOf('33333333333'));
            expect(fieldValue(toni, 'E0501513')).toBe('1');
        });

        await it('Schulgeld: gezahlter Betrag (nicht die 30 %) + Sum + Elt_k_ZV "von mir übernommen"', async () => {
            expect(fieldValue(xml, 'E0505606')).toBe('Freie Musterschule e.V.');
            expect(fieldValue(xml, 'E0504405')).toBe('2680'); // Gesamtaufwendungen der Eltern
            expect(fieldValue(xml, 'E0505607')).toBe('2680');
            expect(fieldValue(xml, 'E0504505')).toBe('2680'); // von mir übernommen
        });

        await it('KBK: gezahlte Beträge je Dienstleister + steuerfreier Ersatz + Eigenanteil', async () => {
            expect(fieldValue(xml, 'E0506101')).toBe('Kinderhort Musterstadt, Musterweg 5, 12345 Musterstadt');
            expect(fieldValue(xml, 'E0506103')).toBe('01.06-31.12');
            expect(fieldValue(xml, 'E0506104')).toBe('1201'); // 1.200,50 rounded up (in the taxpayer's favour)
            expect(fieldValue(xml, 'E0506105')).toBe('1201'); // Sum of the rounded individual amounts
            expect(fieldValue(xml, 'E0506505')).toBe('200'); // steuerfreier Ersatz
            expect(fieldValue(xml, 'E0506504')).toBe('200');
            expect(fieldValue(xml, 'E0506605')).toBe('1001'); // Eigenanteil 1.200,50 − 200, rounded up
            expect(fieldValue(xml, 'E0506604')).toBe('1001');
        });

        await it('KBK: Ang_HH (Haushalt) wird zwischen Ersatz und Elt_k_ZV emittiert (Regel 10514160)', async () => {
            expect(fieldValue(xml, 'E0504807')).toBe('20.04-31.12'); // the parents' joint household
            expect(fieldValue(xml, 'E0504808')).toBe('20.04-31.12'); // the child belonged to the household
            const kbk = xml.slice(xml.indexOf('<KBK>'), xml.indexOf('</KBK>'));
            const order = ['<Art>', '<Ersatz_Erstatt>', '<Ang_HH>', '<Elt_k_ZV>'];
            const idx = order.map((tag) => kbk.indexOf(tag));
            for (const i of idx) expect(i > -1).toBe(true);
            for (let i = 1; i < idx.length; i++) expect(idx[i] > idx[i - 1]).toBe(true);
        });

        await it('BV: IBAN + Kontoinhaber (Person A) — Plausi 1016 verlangt eine Bankverbindung', async () => {
            expect(fieldValue(xml, 'E0102102')).toBe('DE91100000000123456789');
            expect(fieldValue(xml, 'E0101601')).toBe('X');
        });

        await it('freitext: ELSTER-Zeichensatz — ·/– transliteriert, Fremdzeichen ersetzt, gekappt', async () => {
            expect(freitext('Apotheke · Kauf 09.–12.12. — „ok“')).toBe('Apotheke - Kauf 09.-12.12. - "ok"');
            expect(freitext('a™b')).toBe('a b'); // ™ is not in Standard_E_V2
            expect(freitext('Ärztin & Söhne (ß)')).toBe('Ärztin & Söhne (ß)'); // Latin-1 stays
            expect(freitext('x'.repeat(1200)).length).toBe(999);
        });

        await it('Vorsatz: StNr + IdNr + Absender + OrdNrArt S', async () => {
            expect(fieldValue(xml, 'StNr')).toBe('9198011310010');
            expect(fieldValue(xml, 'ID')).toBe('11111111111');
            expect(fieldValue(xml, 'Zeitraum')).toBe('2025');
            expect(fieldValue(xml, 'AbsName')).toBe('Musterfrau Erika');
            expect(fieldValue(xml, 'AbsStr')).toBe('Musterstraße 12');
            expect(fieldValue(xml, 'OrdNrArt')).toBe('S');
        });
    });

    await describe('buildEstNutzdaten — fail loud instead of guessing tax facts', async () => {
        const failing = (mutate: (config: EstConfig) => void): string => {
            const config = makeConfig();
            mutate(config);
            const aggregate = makeAggregate();
            try {
                buildEstNutzdaten(config, buildEstInputs(config, aggregate, 2025), aggregate);
                return '';
            } catch (err) {
                return err instanceof Error ? err.message : String(err);
            }
        };

        await it('missing Steuerklasse blocks generation (Plausi: Pflicht bei Arbeitslohn)', async () => {
            expect(failing((c) => (c.jahre[0].steuerklasse = undefined)).includes('steuerklasse')).toBe(true);
        });

        await it('Homeoffice ohne Zeilenwahl (E0204507 vs E0206206) blocks generation', async () => {
            const msg = failing((c) => {
                (c.jahre[0].werbungskosten as { homeoffice_anderer_arbeitsplatz?: boolean }).homeoffice_anderer_arbeitsplatz = undefined;
            });
            expect(msg.includes('homeoffice_anderer_arbeitsplatz')).toBe(true);
        });

        await it('Entfernungspauschale without the erste Tätigkeitsstätte blocks generation', async () => {
            const msg = failing((c) => {
                (c.jahre[0].werbungskosten as { pendel?: unknown }).pendel = { arbeitstage: 40, km_einfach: 12 };
            });
            expect(msg.includes('pendel.ziel')).toBe(true);
        });

        await it('Zusammenveranlagung is rejected (no Person-B model yet)', async () => {
            expect(failing((c) => ((c as { veranlagung: string }).veranlagung = 'splitting')).includes('splitting')).toBe(true);
        });

        await it('Jahres-Schulgeld ohne Kind-Zuordnung wird abgelehnt (E10 braucht die Anlage Kind je Kind)', async () => {
            expect(failing((c) => (c.jahre[0].schulgeld = 1000)).includes('Kind-Zuordnung')).toBe(true);
        });

        await it('ein Kind ohne IdNr oder ohne Jahres-Kindergeld-Anspruch blockiert die Generierung', async () => {
            expect(failing((c) => (c.kinder[0].idnr = undefined)).includes('idnr')).toBe(true);
            expect(failing((c) => (c.kinder[0].jahre = [])).includes('kindergeld_anspruch')).toBe(true);
        });

        await it('Kinderbetreuung ohne Haushalts-Angaben wird abgelehnt (ERiC-Regel 10514160)', async () => {
            expect(failing((c) => (c.kinder[1].jahre[0].haushalt = undefined)).includes('10514160')).toBe(true);
        });

        await it('person.kinder muss zur kinder-Liste passen (zumutbare Belastung vs. Anlagen Kind)', async () => {
            expect(failing((c) => (c.person.kinder = 5)).includes('widerspricht')).toBe(true);
        });

        await it('sonstige Vorsorge ohne AV-Zuordnung wird abgelehnt (Zeilen-Aufteilung nötig)', async () => {
            const msg = failing((c) => {
                (c.jahre[0].vorsorge as { sonstige: number }).sonstige = 99;
            });
            expect(msg.includes('vorsorge.sonstige')).toBe(true);
        });

        await it('missing IBAN blocks generation (ERiC Regel 1016: Bankverbindung Pflicht)', async () => {
            expect(failing((c) => (c.person.iban = undefined)).includes('person.iban')).toBe(true);
        });

        await it('collects ALL misses in one error', async () => {
            const msg = failing((c) => {
                c.person.steuer_id = undefined;
                c.person.geburtsdatum = undefined;
            });
            expect(msg.includes('steuer_id')).toBe(true);
            expect(msg.includes('geburtsdatum')).toBe(true);
        });
    });
};
