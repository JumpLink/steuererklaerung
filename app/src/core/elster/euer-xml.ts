/**
 * Anlage-EÜR (EUER_77_2024 / _2025) XML builder for ELSTER/ERiC.
 *
 * Structure mirrors the shipped known-good example (`EUER_2025_ok.xml`) and the
 * E77-2025 schema: Nutzdaten root `<E77 …/euer/e77/v2025>` → `<EUER>` (Allg, BEin,
 * BAus, Ermittlung_Gewinn) + `<Vorsatz>`. Fields are `E6xxxxxx` codes wrapped in their
 * named containers; amounts use German decimals (`0,00`).
 *
 * EÜR Bruttomethode: net per-category lines + separate vereinnahmte USt (E6000601),
 * Vorsteuer (E6005001) and USt ans Finanzamt (E6005101). Setting E6005101 = the annual
 * USt-Zahllast makes the form Gewinn (Summe BEin − Summe BAus) reconcile exactly to the
 * net EÜR profit. Category → line/E-code is best-effort (verify before filing); ERiC
 * validateXml is the backstop and the local ERiC lib is the loop (`elster euer
 * validate-eric`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElsterConfig, ElsterAnlagegut } from '../config/index.ts';
import type { EuerTxAggregate } from './euer-transactions.ts';
import { computeAfa, afaGroupTotals, type Anlagegut } from './afa.ts';
import { buildEdsEnvelope } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';
import { pad, amtDe as amt, leaf, wrap, sumLine, schemaJahr } from './xml-format.ts';
import { round2 } from '../lib/money.ts';

const EUER_NS_PREFIX = 'http://finkonsens.de/elster/elstererklaerung/euer/e77/v';
/**
 * Schema years this builder writes. 2024 and 2025 use the same E-codes for every field emitted here
 * (2025 only adds fields) — checked against the ERiC 43.4.6.0 Schemadokumentation E77-2024/E77-2025
 * and validated by ERiC (app/elster/README.md, „ERiC-Prüfung der Demodaten").
 */
const EUER_SCHEMA_JAHRE = [2024, 2025] as const;
/** E6000017 „Art des Betriebs" is `String_MinL1_MaxL25` in E77-2024 and E77-2025. */
export const EUER_ART_MAX = 25;

/** Business identification for the EÜR Allg + Vorsatz blocks. PRIVATE — from config. */
export interface EuerBetrieb {
    /** Name der Gesellschaft (E6000016 / AbsName). */
    name: string;
    /** Straße und Hausnummer (E6000023 / AbsStr). */
    strasse: string;
    /** Postleitzahl (E6000024 / AbsPlz). */
    plz: string;
    /** Ort (E6000025 / AbsOrt). */
    ort: string;
    /** Art des Betriebs/der Tätigkeit (E6000017). */
    art: string;
    /** Hausnummer (split out for forms that require it separately, e.g. UStE). */
    hausnummer?: string;
    /** Wirtschafts-Identifikationsnummer (W-IdNr) — required by the UStE for 2025+. */
    widnr?: string;
    /** Rechtsform (E6000602); default 270 = Gesellschaft des bürgerlichen Rechts. */
    rechtsform?: string;
    /** Einkunftsart (E6000603); default 2 = Gewerbebetrieb. */
    einkunftsart?: string;
}

/** The EÜR line amounts (net, Bruttomethode), keyed by their E-code line. */
interface EuerLines {
    stPflichtig: number; // E6000401 umsatzsteuerpflichtige Betriebseinnahmen
    stFrei: number; // E6000501 steuerfrei/§13b
    vereinnahmtUst: number; // E6000601 vereinnahmte USt
    summeBEin: number; // E6001201
    fremdleistung: number; // E6001701
    personal: number; // E6001801
    afaGebaeude: number; // E6001901 AfA Gebäude/Grundstücke (Übertrag aus AVEÜR E6007071)
    afa: number; // E6002101 AfA bewegliche WG (Übertrag aus AVEÜR E6007372)
    gwg: number; // E6002301 GWG
    miete: number; // E6003201 Miete/Pacht Geschäftsräume
    raumSonst: number; // E6003301 sonstige Raumkosten
    uebrige: number; // E6004901 übrige unbeschränkt abziehbar
    bewirtungAbziehbar: number; // E6004102 Bewirtung, abziehbar (Zeile 63, Kz 175) — in Summe BAus
    bewirtungNichtAbziehbar: number; // E6004101 Bewirtung, nicht abziehbar (Zeile 63, Kz 165) — NOT in Summe BAus
    vorsteuer: number; // E6005001 gezahlte Vorsteuer
    ustAnFa: number; // E6005101 an das Finanzamt gezahlte USt
    summeBAus: number; // E6005301
    gewinn: number; // summeBEin − summeBAus (= net EÜR profit)
    entnahme: number; // E6006601 Entnahmen (Zeile 106, §4 Abs. 4a EStG — Einzelunternehmen)
    einlage: number; // E6006701 Einlagen (Zeile 107, §4 Abs. 4a EStG — Einzelunternehmen)
}

/**
 * Whether a Rechtsform code (E6000602) is a natural-person Einzelunternehmen (110–190) —
 * exactly the forms for which the EÜR requires the Zus_Angabe_EinzelUntern block with the
 * §4 Abs. 4a EStG Entnahmen/Einlagen (ERiC rule 600904). Personengesellschaften (200+) and
 * the default GbR (270) do NOT get the block (they file via the Feststellung).
 */
function isEinzelunternehmerRechtsform(code: string | undefined): boolean {
    const n = Number(code ?? '270');
    return Number.isFinite(n) && n >= 110 && n < 200;
}

/**
 * SKR03 expense category → EÜR line; anything unlisted falls into `uebrige`.
 * AfA on movable assets (E6002101) is supplied as a year-end adjustment from the
 * Anlageverzeichnis (config `adjustments.anlageverzeichnis` → {@link computeAfa}); the
 * aggregate injects it as the `4830 Abschreibungen (AfA)` category, mapped here to its
 * own line. GWG stays on its own line (no AVEÜR needed).
 */
const EXPENSE_LINE: Record<string, keyof EuerLines> = {
    '4946 Fremdleistungen': 'fremdleistung',
    '4100 Personalkosten (Löhne/Gehälter)': 'personal',
    '4138 Soziale Abgaben': 'personal',
    '4830 Abschreibungen (AfA)': 'afa',
    '0420 Büroeinrichtung/GWG': 'gwg',
    '4210 Miete/Raumkosten': 'miete',
    '4240 Gas/Strom/Wasser': 'raumSonst',
    // The 70 % of a Bewirtung (§ 4 Abs. 5 Satz 1 Nr. 2 EStG); the 30 % ride in agg.neutral as
    // '4654 Nicht abziehbare Bewirtungskosten'. Kennzahlen: docs/references/tax-sources.md, „Bewirtung".
    '4654 Bewirtungskosten': 'bewirtungAbziehbar',
};

const BEWIRTUNG_NICHT_ABZIEHBAR = '4654 Nicht abziehbare Bewirtungskosten';

/** Income categories that are tax-free / §13b reverse-charge (else umsatzsteuerpflichtig). */
const INCOME_STFREI = new Set(['8336 Erlöse Reverse Charge', '8125 Steuerfreie Auslandsumsätze']);

/** Derive the EÜR line amounts from the transaction-driven aggregate. */
export function euerLinesFromAggregate(agg: EuerTxAggregate): EuerLines {
    const l: EuerLines = {
        stPflichtig: 0,
        stFrei: 0,
        vereinnahmtUst: 0,
        summeBEin: 0,
        fremdleistung: 0,
        personal: 0,
        afaGebaeude: 0,
        afa: 0,
        gwg: 0,
        miete: 0,
        raumSonst: 0,
        uebrige: 0,
        bewirtungAbziehbar: 0,
        bewirtungNichtAbziehbar: 0,
        vorsteuer: 0,
        ustAnFa: 0,
        summeBAus: 0,
        gewinn: 0,
        entnahme: 0,
        einlage: 0,
    };
    for (const c of agg.income) {
        if (INCOME_STFREI.has(c.category)) l.stFrei += c.net;
        else l.stPflichtig += c.net;
    }
    for (const c of agg.expenses) {
        l[EXPENSE_LINE[c.category] ?? 'uebrige'] += c.net;
    }
    // §4 Abs. 4a EStG Entnahmen/Einlagen: the private capital movements the aggregate books
    // as GuV-neutral `1800 Privatentnahme` / `1810 Privateinlage` (gross = Σ|amount|). Genuine
    // account-to-account transfers (`1360 Interne Überweisung`) are NOT private draws and stay
    // out. Both stay 0 when there are no such rows — the block is still emitted (mandatory).
    for (const c of agg.neutral) {
        if (c.category.startsWith('1800')) l.entnahme += c.gross;
        else if (c.category.startsWith('1810')) l.einlage += c.gross;
        else if (c.category === BEWIRTUNG_NICHT_ABZIEHBAR) l.bewirtungNichtAbziehbar += c.net;
    }
    l.vereinnahmtUst = agg.totals.outputVat;
    l.vorsteuer = agg.totals.inputVat;
    // USt ans FA = annual Zahllast (positive). Makes the form Gewinn == net EÜR profit.
    l.ustAnFa = Math.max(0, agg.totals.vatPayable);

    for (const k of Object.keys(l) as (keyof EuerLines)[]) l[k] = round2(l[k]);

    // A refund linked to an expense of an EARLIER year (Idee 9) can leave a line negative. ERiC takes
    // a negative value wherever the schema type is signed (übrige, Bewirtung abziehbar, Vorsteuer, …);
    // the GWG line is `NichtNeg` and refuses it, so its negative rest moves to „übrige" — the Gewinn
    // stays the same. The nicht abziehbare Bewirtung never reduced the profit, so a refund of it changes
    // nothing either: it is shown as 0. Sources and the ERiC run: tax-sources.md, „Erstattungen".
    if (l.gwg < 0) {
        l.uebrige = round2(l.uebrige + l.gwg);
        l.gwg = 0;
    }
    l.bewirtungNichtAbziehbar = Math.max(0, l.bewirtungNichtAbziehbar);

    l.summeBEin = round2(l.stPflichtig + l.stFrei + l.vereinnahmtUst);
    l.summeBAus = round2(
        l.fremdleistung +
            l.personal +
            l.afaGebaeude +
            l.afa +
            l.gwg +
            l.miete +
            l.raumSonst +
            l.uebrige +
            l.bewirtungAbziehbar +
            l.vorsteuer +
            l.ustAnFa,
    );
    l.gewinn = round2(l.summeBEin - l.summeBAus);
    return l;
}

/** Build the inner `<E77>` Nutzdaten block (16-space base indent for the EDS envelope). */
export function buildEuerNutzdaten(
    lines: EuerLines,
    betrieb: EuerBetrieb,
    steuernr13: string,
    year: number,
    aveuer = '',
): string {
    // ERiC refuses a longer text outright; cutting it would put words in the return nobody wrote.
    if (betrieb.art.length > EUER_ART_MAX) {
        throw new Error(
            `Anlage EÜR: „Art des Betriebs" hat ${betrieb.art.length} Zeichen, ELSTER erlaubt höchstens ${EUER_ART_MAX} ` +
                `(Feld E6000017). Bitte in den Einstellungen unter Betrieb kürzen: „${betrieb.art}".`,
        );
    }
    const schema = schemaJahr(year, EUER_SCHEMA_JAHRE);
    // The (Betriebs-)Steuernummer E6000026 heads Allg in E77-2024 and follows the address in E77-2025.
    const stNr = leaf(28, 'E6000026', steuernr13);
    const allg =
        (schema === 2024 ? stNr : '') +
        leaf(28, 'E6000016', betrieb.name) +
        leaf(28, 'E6000023', betrieb.strasse) +
        leaf(28, 'E6000024', betrieb.plz) +
        leaf(28, 'E6000025', betrieb.ort) +
        (schema === 2024 ? '' : stNr) +
        leaf(28, 'E6000017', betrieb.art) +
        leaf(28, 'E6000602', betrieb.rechtsform ?? '270') +
        leaf(28, 'E6000603', betrieb.einkunftsart ?? '2') +
        leaf(28, 'E6000604', '1') +
        leaf(28, 'E6000019', '2');

    const bein =
        (lines.stPflichtig ? sumLine(28, 'USt_StPflicht', 'E6000401', lines.stPflichtig) : '') +
        (lines.stFrei ? sumLine(28, 'USt_StFrei', 'E6000501', lines.stFrei) : '') +
        (lines.vereinnahmtUst ? sumLine(28, 'USt_Vereinnahmt_Unentgeltl', 'E6000601', lines.vereinnahmtUst) : '') +
        wrap(28, 'GesamtSum', leaf(32, 'E6001201', amt(lines.summeBEin)));

    const afaInner =
        (lines.afaGebaeude ? leaf(32, 'E6001901', amt(lines.afaGebaeude)) : '') +
        (lines.afa ? leaf(32, 'E6002101', amt(lines.afa)) : '') +
        (lines.gwg
            ? wrap(32, 'Wirtschaftsgut_geringwertig', wrap(36, 'Sum', leaf(40, 'E6002301', amt(lines.gwg))))
            : '');
    const raumInner =
        (lines.miete ? sumLine(32, 'Miete_Pacht', 'E6003201', lines.miete) : '') +
        (lines.raumSonst ? sumLine(32, 'Sonst_Aufw_betr_Grund', 'E6003301', lines.raumSonst) : '');
    const sonstInner =
        (lines.vorsteuer ? sumLine(32, 'Vorsteuer', 'E6005001', lines.vorsteuer) : '') +
        (lines.ustAnFa ? sumLine(32, 'USt', 'E6005101', lines.ustAnFa) : '') +
        (lines.uebrige ? sumLine(32, 'Sonst_unbeschr_abziehbar', 'E6004901', lines.uebrige) : '');
    // Zeile 63: both columns of the Bewirtung, nicht abziehbar (informational) and abziehbar.
    const beschrInner =
        (lines.bewirtungNichtAbziehbar
            ? wrap(32, 'Nicht_abziehbar', sumLine(36, 'Bewirtung', 'E6004101', lines.bewirtungNichtAbziehbar))
            : '') +
        (lines.bewirtungAbziehbar
            ? wrap(32, 'Abziehbar', sumLine(36, 'Bewirtung', 'E6004102', lines.bewirtungAbziehbar))
            : '');

    const baus =
        (lines.fremdleistung ? sumLine(28, 'Fremdleistung', 'E6001701', lines.fremdleistung) : '') +
        (lines.personal ? sumLine(28, 'Personal', 'E6001801', lines.personal) : '') +
        (afaInner ? wrap(28, 'AfA', afaInner) : '') +
        (raumInner ? wrap(28, 'Raumkosten_u_sonst', raumInner) : '') +
        (sonstInner ? wrap(28, 'Sonst_unbeschraenkt', sonstInner) : '') +
        (beschrInner ? wrap(28, 'Beschr_abziehbar', beschrInner) : '') +
        wrap(28, 'Summe_BAus', leaf(32, 'E6005301', amt(lines.summeBAus)));

    const ermittlung = wrap(
        24,
        'Ermittlung_Gewinn',
        wrap(28, 'Uebertrag', leaf(32, 'E6005501', amt(lines.summeBEin)) + leaf(32, 'E6005601', amt(lines.summeBAus))) +
            wrap(28, 'Korrektur_GuV', leaf(32, 'E6006801', amt(lines.gewinn))) +
            wrap(28, 'Stpfl_GuV', leaf(32, 'E6007002', amt(lines.gewinn)) + leaf(32, 'E6007202', amt(lines.gewinn))),
    );

    // Einzelunternehmen (Rechtsform 110–190): the EÜR requires the Entnahmen (Zeile 106) and
    // Einlagen (Zeile 107) — §4 Abs. 4a EStG (ERiC rule 600904). ALWAYS emitted (even 0,00).
    const zusEinzel = isEinzelunternehmerRechtsform(betrieb.rechtsform)
        ? wrap(
              24,
              'Zus_Angabe_EinzelUntern',
              wrap(
                  28,
                  'Entnahme_Einlage',
                  sumLine(32, 'Entnahme', 'E6006601', lines.entnahme) +
                      sumLine(32, 'Einlage', 'E6006701', lines.einlage),
              ),
          )
        : '';

    const euer = wrap(
        20,
        'EUER',
        wrap(24, 'Allg', allg) + wrap(24, 'BEin', bein) + wrap(24, 'BAus', baus) + ermittlung + zusEinzel,
    );

    const vorsatz = wrap(
        20,
        'Vorsatz',
        leaf(24, 'Unterfallart', '77') +
            leaf(24, 'Vorgang', '01') +
            leaf(24, 'StNr', steuernr13) +
            leaf(24, 'Zeitraum', String(year)) +
            leaf(24, 'AbsName', betrieb.name) +
            leaf(24, 'AbsStr', betrieb.strasse) +
            leaf(24, 'AbsPlz', betrieb.plz) +
            leaf(24, 'AbsOrt', betrieb.ort) +
            leaf(24, 'Copyright', '(C) 2025 Bayerisches Landesamt für Steuern') +
            leaf(24, 'OrdNrArt', 'S') +
            wrap(24, 'Rueckuebermittlung', leaf(28, 'Bescheid', '2')),
    );

    // AVEÜR (Anlageverzeichnis) is a SIBLING of EUER under <E77>, between EUER and Vorsatz.
    return (
        `${pad(16)}<E77 xmlns="${EUER_NS_PREFIX}${schema}" version="${schema}">\n` +
        euer +
        aveuer +
        vorsatz +
        `${pad(16)}</E77>\n`
    );
}

/** config Anlagegut (snake_case) → the AfA engine's Anlagegut (camelCase + art). */
function toAnlagegut(a: ElsterAnlagegut): Anlagegut {
    return {
        id: a.id,
        bezeichnung: a.bezeichnung,
        anschaffung: a.anschaffung,
        ahk: a.ahk,
        nutzungsdauerJahre: a.nutzungsdauer_jahre,
        restbuchwertAnfang: a.restbuchwert_anfang,
        erinnerungswert: a.erinnerungswert,
        art: a.art,
    };
}

/**
 * Build the Anlage AVEÜR block from the config Anlageverzeichnis: per asset class
 * (Gebäude/Grundstücke + andere bewegliche WG) a group `Sum` (Buchwert Anfang, AfA,
 * Buchwert Ende) and a `GesamtSum` AfA rollup. The rollups MUST equal the EÜR AfA lines
 * (E6007071 == E6001901, E6007372 == E6002101) — ERiC rejects otherwise — so both are
 * derived from the same {@link computeAfa}. Returns the split AfA totals + the XML block.
 */
function buildAveuer(config: ElsterConfig, year: number): { afaGebaeude: number; afaBeweglich: number; xml: string } {
    const assets = (config.adjustments?.anlageverzeichnis ?? []).map(toAnlagegut);
    if (assets.length === 0) return { afaGebaeude: 0, afaBeweglich: 0, xml: '' };
    const afa = computeAfa(assets, year, config.business_end_date);
    const geb = afaGroupTotals(afa, 'gebaeude');
    const bew = afaGroupTotals(afa, 'beweglich');

    const grundstueck = geb.afa
        ? wrap(
              24,
              'Grundstueck',
              wrap(
                  28,
                  'Gebaeude',
                  wrap(
                      32,
                      'Sum',
                      leaf(36, 'E6007035', amt(geb.buchwertAnfang)) +
                          leaf(36, 'E6007039', amt(geb.afa)) +
                          leaf(36, 'E6007043', amt(geb.buchwertEnde)),
                  ),
              ) + wrap(28, 'GesamtSum', leaf(32, 'E6007071', amt(geb.afa))),
          )
        : '';
    const beweglich = bew.afa
        ? wrap(
              24,
              'Bewegliche_WG',
              wrap(
                  28,
                  'Andere',
                  wrap(
                      32,
                      'Sum',
                      leaf(36, 'E6007355', amt(bew.buchwertAnfang)) +
                          leaf(36, 'E6007361', amt(bew.afa)) +
                          leaf(36, 'E6007365', amt(bew.buchwertEnde)),
                  ),
              ) + wrap(28, 'GesamtSum', leaf(32, 'E6007372', amt(bew.afa))),
          )
        : '';

    const xml = grundstueck || beweglich ? wrap(20, 'AVEUER', grundstueck + beweglich) : '';
    return { afaGebaeude: geb.afa, afaBeweglich: bew.afa, xml };
}

/** ERiC datenartVersion token for the Anlage EÜR of a tax year (`EUER_<year>`). */
export function euerDatenartVersion(year: number): string {
    return `EUER_${year}`;
}

/** Build the complete EDS document for the Anlage EÜR. */
export function buildEuerEds(agg: EuerTxAggregate, config: ElsterConfig, betrieb: EuerBetrieb): string {
    const steuernr13 = toElsterSteuernummer(config.tax_number);
    const lines = euerLinesFromAggregate(agg);
    // Split the single aggregate AfA total into its Gebäude vs. bewegliche WG lines and
    // emit the matching Anlage AVEÜR (required by ERiC whenever AfA is declared). Both
    // come from the same computeAfa, so the AVEÜR rollups equal the EÜR AfA lines and the
    // sum (afaGebaeude + afa) is unchanged → summeBAus/Gewinn stay correct.
    const aveuer = buildAveuer(config, agg.year);
    if (aveuer.xml) {
        lines.afaGebaeude = aveuer.afaGebaeude;
        lines.afa = aveuer.afaBeweglich;
    }
    const nutzdaten = buildEuerNutzdaten(lines, betrieb, steuernr13, agg.year, aveuer.xml);
    return buildEdsEnvelope({
        verfahren: 'ElsterErklaerung',
        datenArt: 'EUER',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaFromElsterSteuernummer(steuernr13),
        produktName: 'steuererklaerung-cli',
        produktVersion: '0.1.0',
        nutzdatenLieferant: betrieb.name,
        nutzdaten,
    });
}

export function getEuerOutputFilename(entityId: string, year: number): string {
    return `euer-${entityId}-${year}.xml`;
}

/** Write the Anlage-EÜR EDS XML to the configured output directory. */
export function writeEuerXml(
    agg: EuerTxAggregate,
    config: ElsterConfig,
    betrieb: EuerBetrieb,
    outputPath?: string,
): string {
    const xml = buildEuerEds(agg, config, betrieb);
    const dir = config.output_directory;
    const filename = outputPath ?? join(dir, getEuerOutputFilename(config.entity_id, agg.year));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}
