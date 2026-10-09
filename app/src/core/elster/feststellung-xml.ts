/**
 * Feststellungserklärung (FEIN_90_2025) XML builder for ELSTER/ERiC — the full
 * "gesonderte und einheitliche Feststellung" for the GbR.
 *
 * Structure from the E90-2025 schema (`elster/ERiC-<ver>/…/FEIN_90_2025/Schema/E90-2025.xsd`):
 * Nutzdaten root `<E90 …/fein/e90/v2025>` → `<ESt1B>` (Hauptvordruck: Gesellschaft +
 * Rechtsform) + repeated `<FB>` (one Anlage FB per Beteiligten: Stammdaten) + `<FE_G>`
 * (Anlage FE-G "Einkünfte aus Gewerbebetrieb": Gesamthand-Beträge in `<Ges>` + the
 * per-Beteiligter Aufteilung in one `<Bet>` per Beteiligten) + `<Vorsatz>`.
 * DatenArt `FEIN`, token `FEIN_90_<year>`, Datei-Kompression NO_BASE64. Reuses
 * {@link computeFeststellung} for the allocation.
 *
 * Since VZ 2025 the Anlage FE is split by Einkunftsart: XML `FE_L` = Anlage FE-L
 * (Land- und Forstwirtschaft, fields E9013xxx/E9113xxx/E9733xxx), XML `FE_G` = Anlage
 * FE-G (Gewerbebetrieb, fields E9014xxx/E9114xxx) — see the 2025 Vordrucke PDFs under
 * `elster/Vordrucke_2025_ERiC-<ver>/…/FEIN/Grafiken_und_Erweiterungen_E90/`. A gewerbliche
 * GbR therefore MUST use `FE_G` (an earlier revision wrongly used `FE_L`, copying the
 * shipped `fein_e90_2025_ok.xml`, which is a LuF example).
 *
 * Aufteilung — data-driven. If every Beteiligungsquote is a clean small Bruchteil
 * (e.g. 50/50 → 1/2), the allgemeiner Schlüssel is "nach Bruchteilen": ESt1B `Art_Auft`
 * E9011011 = '2' + per Beteiligtem the Bruchteil in Anlage FB (`Ang_Auft → Auft_Bruch`,
 * E9850013 Zähler / E9850014 Nenner), and the Gesamthand rows are split by the FA over
 * that key — laufende Einkünfte "nach Schlüssel zu verteilen" (Ges E9014100) and the
 * Aufgabegewinn/-verlust §16 in Veraeu_Gew (Zeitpunkt E9014134 "des ganzen Betriebs" +
 * E9014130 "aus dem Gesamthandsvermögen"); the per-Beteiligter `<Bet>` then carries ONLY
 * the genuinely partner-specific Saldo aus Sonderbetriebseinnahmen und
 * Sonderbetriebsausgaben (Bet E9114113 = −SBA, Ges total in E9014113). If a quote is not
 * a clean Bruchteil, `Art_Auft` = '0' ("andere Aufteilung") and every amount is assigned
 * explicitly per Beteiligtem via the "abweichend vom allgemeinen Schlüssel" rows (Ges
 * E9014102 + Bet E9114102 laufend, Bet E9114130 Aufgabe-Anteil) alongside the SBA.
 *
 * Beteiligten-Identifikation: the IdNr goes into `FB → Allg → Ordn_Krit → E9146070`
 * (its only slot in the E90-2025 XSD; inside Nat_Pers it would be schema-invalid) — plus
 * name, Geburtsdatum and Anschrift in Nat_Pers. Adding it clears ERiC Regel_9952075
 * ("Bitte ergänzen Sie … die Identifikationsnummer"). No `Kapktn_Entw` (a Vollhafter-GbR
 * has no handelsrechtliche Kapitalkontenentwicklung).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElsterConfig, ElsterGesellschafter } from '../config/index.ts';
import type { FeststellungResult } from './feststellung.ts';
import type { EuerBetrieb } from './euer-xml.ts';
import { buildEdsEnvelope } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';
import { leaf, wrap, amtDe, pad, schemaJahr } from './xml-format.ts';

const FEIN_NS_PREFIX = 'http://finkonsens.de/elster/elstererklaerung/fein/e90/v';
/**
 * Schema years this builder writes. Only 2025: the Anlage FE-G it fills exists since VZ 2025 —
 * before that the Einkünfte went on the Anlage FE 1, and ERiC rejects E9014100 for 2024 („wird im
 * angegebenen Veranlagungszeitraum … nicht unterstützt").
 */
const FEIN_SCHEMA_JAHRE = [2025] as const;

/** ERiC datenartVersion token for the Feststellungserklärung (`FEIN_90_<year>`). */
export function feststellungDatenartVersion(year: number): string {
    return `FEIN_90_${year}`;
}

/** "YYYY-MM-DD" → "DD.MM.YYYY" (ELSTER date format). */
function deDate(iso: string): string {
    return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** Split "Musterstraße 12" → { street, nr }; falls back to the whole string. */
function splitStrasse(s: string): { street: string; nr: string } {
    const m = s.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
    return m ? { street: m[1], nr: m[2].trim() } : { street: s, nr: '' };
}

/** Vorname/Nachname from a full name (Nachname = last word) unless explicitly set. */
function splitName(g: ElsterGesellschafter): { vorname: string; nachname: string } {
    if (g.vorname && g.nachname) return { vorname: g.vorname, nachname: g.nachname };
    const parts = g.name.trim().split(/\s+/);
    const nachname = g.nachname ?? parts[parts.length - 1];
    const vorname = g.vorname ?? parts.slice(0, -1).join(' ');
    return { vorname, nachname };
}

/**
 * Beteiligungsquote (fraction) → Bruchteil Zähler/Nenner for `Auft_Bruch`
 * (E9850013/E9850014): scale to 10^6 and reduce by the gcd, so exactly representable
 * quotes come out minimal (0.5 → 1/2, 0.25 → 1/4).
 */
export function quoteToBruch(quote: number): { zaehler: number; nenner: number } {
    const SCALE = 1_000_000;
    const zaehler = Math.round(quote * SCALE);
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(zaehler, SCALE) || 1;
    return { zaehler: zaehler / g, nenner: SCALE / g };
}

/**
 * Whether every quote is a clean small Bruchteil (denominator ≤ 1000 and exactly
 * reconstructs the quote) → allgemeiner Schlüssel "nach Bruchteilen" (Art_Auft '2').
 * Otherwise the amounts are distributed explicitly per Beteiligtem (Art_Auft '0').
 */
export function quotesAreCleanBruchteile(gesellschafter: ElsterGesellschafter[]): boolean {
    return gesellschafter.every((g) => {
        const { zaehler, nenner } = quoteToBruch(g.quote);
        return nenner <= 1000 && Math.abs(zaehler / nenner - g.quote) < 1e-9;
    });
}

/**
 * Art der Beteiligung (FB `Art_Bet_gung`, E9145101) derived from the Rechtsform
 * (E6000602) — NOT hardcoded, because the Mitunternehmer-Art must match the Rechtsform:
 * - OHG (E6000602 '210') → '1' (persönlich haftender Gesellschafter einer OHG)
 * - GbR ('270'/'271', the default) and other Personengesellschaften with only Vollhaftern
 *   → '4' (sonstiger Mitunternehmer ohne Haftungsbeschränkung).
 *
 * A GbR partner is a "sonstiger Mitunternehmer ohne Haftungsbeschränkung" ('4'), NOT an
 * "OHG-Gesellschafter" ('1', the previous hardcoded value which is factually wrong for a
 * GbR). Note this does NOT change ERiC's advisory Kapitalkontenentwicklung-Hinweise
 * (Regel_9952135/9952139/9952143/9952146, Zeile 191/192/195/196 der Anlage FE-G): those
 * are emitted for ANY declared Mitunternehmer ('1'..'5' alike, verified against ERiC
 * 43.4.6.0) as a reminder to optionally fill Entnahmen/Einlagen aus der Gesamthands- bzw.
 * Sonderbilanz "ggf. mit 0,00" — they are Hinweise (validation stays green), not errors.
 *
 * KG-Kommanditisten ('2' Komplementär / '3' Kommanditist) would need a per-Beteiligter
 * Haftungs-Flag, which is not modelled — such Rechtsformen currently fall back to '4'.
 */
export function mitunternehmerArt(rechtsform: string | undefined): string {
    return rechtsform === '210' ? '1' : '4';
}

/** One `<FB>` block (Anlage FB) for a Beteiligten. */
function buildFB(index: number, g: ElsterGesellschafter, betrieb: EuerBetrieb, useBruch: boolean): string {
    const { vorname, nachname } = splitName(g);
    const addr = splitStrasse(g.strasse ?? betrieb.strasse);
    const plz = g.plz ?? betrieb.plz;
    const ort = g.ort ?? betrieb.ort;
    // Nat_Pers: name + Geburtsdatum + Anschrift. The IdNr does NOT belong here (the
    // E90-2025 XSD has no IdNr element inside Nat_Pers) — it goes into Ordn_Krit below.
    const natPers =
        (g.anrede ? leaf(32, 'E9146010', g.anrede) : '') +
        leaf(32, 'E9146013', vorname) +
        leaf(32, 'E9146011', nachname) +
        (g.geburtsdatum ? leaf(32, 'E9146072', deDate(g.geburtsdatum)) : '') +
        wrap(
            32,
            'Adr',
            wrap(
                36,
                'Str_Adr',
                leaf(40, 'E9846024', addr.street) +
                    (addr.nr ? leaf(40, 'E9846025', addr.nr) : '') +
                    leaf(40, 'E9846027', plz) +
                    leaf(40, 'E9846028', ort),
            ),
        );
    // Ordn_Krit: the Beteiligten-IdNr (E9146070) — its only slot in the E90-2025 schema.
    const ordnKrit = wrap(28, 'Ordn_Krit', leaf(32, 'E9146070', g.steuer_id));
    // Ang_Auft: the Bruchteil of this Beteiligter for the allgemeiner Aufteilungsschlüssel
    // "nach Bruchteilen" (only when ESt1B Art_Auft E9011011 = '2'; for '0' the amounts are
    // given explicitly per Beteiligtem instead).
    const bruch = quoteToBruch(g.quote);
    const angAuft = useBruch
        ? wrap(
              24,
              'Ang_Auft',
              wrap(
                  28,
                  'Auft_Bruch',
                  leaf(32, 'E9850013', String(bruch.zaehler)) + leaf(32, 'E9850014', String(bruch.nenner)),
              ),
          )
        : '';
    return wrap(
        20,
        'FB',
        leaf(24, 'Beteiligter', String(index)) +
            wrap(24, 'Allg', wrap(28, 'Nat_Pers', natPers) + ordnKrit) +
            wrap(
                24,
                'Art_Bet_gung',
                wrap(28, 'Bet_gung_Beg_WJ', leaf(32, 'E9145101', mitunternehmerArt(betrieb.rechtsform))),
            ) +
            wrap(24, 'Art_Bet_ter', wrap(28, 'Bet_ter_Beg_WJ', leaf(32, 'E9145770', '0'))) +
            angAuft,
    );
}

/**
 * `<FE_G>` (Anlage FE-G, Einkünfte aus Gewerbebetrieb): the Gesamthand amounts in `<Ges>`
 * plus one `<Bet>` per Beteiligtem for the Aufteilung of the Besteuerungsgrundlagen.
 *
 * With `useBruch` (Art_Auft '2'): the Gesamthand laufende Einkünfte go into "nach
 * Schlüssel zu verteilen" (E9014100) and the Aufgabegewinn/-verlust §16 into Veraeu_Gew
 * (Zeitpunkt E9014134 + Betrag E9014130); the FA splits both over the Bruchteils-Schlüssel
 * from Anlage FB, so `<Bet>` carries only the partner-specific Saldo aus
 * Sonderbetriebseinnahmen/-ausgaben (E9114113 = −SBA; Ges total E9014113).
 *
 * Without it (Art_Auft '0', andere Aufteilung): laufende Einkünfte and Aufgabe-Anteil are
 * assigned explicitly per Beteiligtem — Ges "abweichend" laufend E9014102, and per `<Bet>`
 * the laufender Anteil E9114102, the Aufgabe-Anteil E9114130 and the SBA-Saldo E9114113.
 *
 * Beteiligten-Nummer = FB numbering (config order, 1-based), looked up by Gesellschafter
 * id — fail loud rather than misattribute a tax figure. Either way the per-Beteiligter
 * Gesamtanteil reconciles to the Prüfblatt: laufend×Quote − SBA + Aufgabe×Quote.
 */
function buildFEG(result: FeststellungResult, config: ElsterConfig, useBruch: boolean): string {
    const sbaSum = result.allocations.reduce((s, a) => s + a.sonderbetriebsausgaben, 0);
    const hasAufgabe = result.aufgabegewinn !== 0;
    // Same resolution as buildAufgabegewinn(): explicit Aufgabe date, else business end.
    const aufgabeDatum = config.adjustments?.betriebsaufgabe?.datum ?? config.business_end_date;
    // E9014100 = laufende Einkünfte "nach Schlüssel zu verteilen" (Bruchteile in FB);
    // E9014102 = "abweichend vom allgemeinen Schlüssel" for an explicit distribution.
    const lfdField = useBruch ? 'E9014100' : 'E9014102';

    const ges = wrap(
        24,
        'Ges',
        wrap(28, 'Lfd_Eink', leaf(32, lfdField, amtDe(result.totalProfit))) +
            // E9014113 = Saldo aus Sonderbetriebseinnahmen und Sonderbetriebsausgaben (SBE − SBA),
            // Gesamthand column; the per-Beteiligter split follows in the <Bet> blocks.
            (sbaSum !== 0 ? wrap(28, 'Weit_Eink', leaf(32, 'E9014113', amtDe(-sbaSum))) : '') +
            // E9014134 = Zeitpunkt der Aufgabe "des ganzen Betriebs"; E9014130 = Veräußerungs-/
            // Aufgabegewinn aus dem Gesamthandsvermögen (§16, negative = Aufgabeverlust).
            (hasAufgabe
                ? wrap(
                      28,
                      'Veraeu_Gew',
                      (aufgabeDatum ? wrap(32, 'Ztp_Vaeu_Aufg', leaf(36, 'E9014134', deDate(aufgabeDatum))) : '') +
                          wrap(32, 'Weit_Ang_Vaeu', leaf(36, 'E9014130', amtDe(result.aufgabegewinn))),
                  )
                : ''),
    );

    const bets = config.gesellschafter
        .map((g, i) => {
            const a = result.allocations.find((x) => x.gesellschafter.id === g.id);
            if (!a) throw new Error(`Feststellung: no allocation for Gesellschafter '${g.id}'.`);
            // In Bruchteil mode a <Bet> is only needed for the partner-specific SBA; in
            // "andere Aufteilung" mode every amount is explicit, so always emit one.
            const needsBet = !useBruch || a.sonderbetriebsausgaben !== 0;
            if (!needsBet) return '';
            const lfd =
                !useBruch && a.laufenderAnteil !== 0
                    ? wrap(28, 'Lfd_Eink', leaf(32, 'E9114102', amtDe(a.laufenderAnteil)))
                    : '';
            const sba =
                a.sonderbetriebsausgaben !== 0
                    ? wrap(28, 'Weit_Eink', leaf(32, 'E9114113', amtDe(-a.sonderbetriebsausgaben)))
                    : '';
            const aufg =
                !useBruch && a.aufgabegewinnAnteil !== 0
                    ? wrap(
                          28,
                          'Veraeu_Gew',
                          wrap(32, 'Weit_Ang_Vaeu', leaf(36, 'E9114130', amtDe(a.aufgabegewinnAnteil))),
                      )
                    : '';
            return wrap(24, 'Bet', leaf(28, 'Beteiligter', String(i + 1)) + lfd + sba + aufg);
        })
        .join('');

    return wrap(20, 'FE_G', ges + bets);
}

/** Build the inner `<E90>` Nutzdaten block (16-space base indent for the EDS envelope). */
export function buildFeststellungNutzdaten(
    result: FeststellungResult,
    config: ElsterConfig,
    betrieb: EuerBetrieb,
    steuernr13: string,
): string {
    if (result.year < FEIN_SCHEMA_JAHRE[0]) {
        throw new Error(
            `Feststellungserklärung ${result.year}: vor ${FEIN_SCHEMA_JAHRE[0]} gehören die Einkünfte auf die Anlage FE 1, ` +
                'die diese App nicht erzeugt. Bitte in Mein ELSTER ausfüllen.',
        );
    }
    const schema = schemaJahr(result.year, FEIN_SCHEMA_JAHRE);
    const a = splitStrasse(betrieb.strasse);
    // Art der Aufteilung: '2' (nach Bruchteilen) when every quote is a clean Bruchteil,
    // else '0' (andere Aufteilung, explicit per-Beteiligter amounts).
    const useBruch = quotesAreCleanBruchteile(config.gesellschafter);
    const artAuft = useBruch ? '2' : '0';
    const estB = wrap(
        20,
        'ESt1B',
        wrap(
            24,
            'Allg',
            wrap(
                28,
                'Gesellsch',
                leaf(32, 'E9750005', betrieb.name) +
                    wrap(
                        32,
                        'Str_Adr',
                        leaf(36, 'E9750021', a.street) +
                            (a.nr ? leaf(36, 'E9750022', a.nr) : '') +
                            leaf(36, 'E9750007', betrieb.plz) +
                            leaf(36, 'E9750008', betrieb.ort),
                    ),
            ) +
                // Rechtsform 1 = rechtsfähige Personenvereinigung (GbR post-MoPeG).
                wrap(28, 'Ang_Rechtsf', leaf(32, 'E9711022', '1')),
        ) +
            wrap(24, 'Art_Auft', leaf(28, 'E9011011', artAuft)) +
            wrap(24, 'Grund_Bes', leaf(28, 'E9011040', '2')),
    );

    const fbBlocks = config.gesellschafter.map((g, i) => buildFB(i + 1, g, betrieb, useBruch)).join('');
    const feG = buildFEG(result, config, useBruch);

    const vorsatz = wrap(
        20,
        'Vorsatz',
        leaf(24, 'Unterfallart', '90') +
            leaf(24, 'Vorgang', '01') +
            leaf(24, 'StNr', steuernr13) +
            leaf(24, 'Zeitraum', String(result.year)) +
            leaf(24, 'AbsName', betrieb.name) +
            leaf(24, 'AbsStr', betrieb.strasse) +
            leaf(24, 'AbsOrt', betrieb.ort) +
            leaf(24, 'Copyright', '(C) 2025 Bayerisches Landesamt für Steuern') +
            leaf(24, 'OrdNrArt', 'S') +
            wrap(24, 'Rueckuebermittlung', leaf(28, 'Bescheid', '2')),
    );

    return (
        `${pad(16)}<E90 xmlns="${FEIN_NS_PREFIX}${schema}" version="${schema}">\n` +
        estB +
        fbBlocks +
        feG +
        vorsatz +
        `${pad(16)}</E90>\n`
    );
}

/** Build the complete EDS document for the Feststellungserklärung. */
export function buildFeststellungEds(result: FeststellungResult, config: ElsterConfig, betrieb: EuerBetrieb): string {
    const steuernr13 = toElsterSteuernummer(config.tax_number);
    return buildEdsEnvelope({
        verfahren: 'ElsterErklaerung',
        datenArt: 'FEIN',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        kompression: 'NO_BASE64',
        empfaenger: bufaFromElsterSteuernummer(steuernr13),
        nutzdaten: buildFeststellungNutzdaten(result, config, betrieb, steuernr13),
    });
}

export function getFeststellungOutputFilename(entityId: string, year: number): string {
    return `feststellung-${entityId}-${year}.xml`;
}

/** Write the Feststellungserklärung EDS XML to the configured output directory. */
export function writeFeststellungXml(
    result: FeststellungResult,
    config: ElsterConfig,
    betrieb: EuerBetrieb,
    outputPath?: string,
): string {
    const xml = buildFeststellungEds(result, config, betrieb);
    const dir = config.output_directory;
    const filename = outputPath ?? join(dir, getFeststellungOutputFilename(config.entity_id, result.year));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}
