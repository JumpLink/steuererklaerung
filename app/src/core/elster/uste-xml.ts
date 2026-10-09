/**
 * USt-Jahreserklärung (USt_50_2025) XML builder for ELSTER/ERiC.
 *
 * Structure from the E50-2025 schema + shipped example: Nutzdaten root
 * `<E50 …/ust/e50/v2025>` → `<USt2A>` (Allg, Umsaetze, Abz_VoSt, Berech_USt) +
 * `<Vorsatz>`. The annual USt is computed from the declared net revenue at the
 * standard rates and reconciled against the prepaid Voranmeldungen; ERiC validateXml
 * is the backstop (`elster uste validate-eric`). DatenArt `USt`, token `USt_<year>`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElsterConfig } from '../config/index.ts';
import type { UsteAggregate } from './uste-aggregate.ts';
import type { EuerBetrieb } from './euer-xml.ts';
import { buildEdsEnvelope } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';
import { hasReverseCharge } from './reverse-charge.ts';
import { leaf, wrap, amtDe, pad, schemaJahr } from './xml-format.ts';
import { round2 } from '../lib/money.ts';

const USTE_NS_PREFIX = 'http://finkonsens.de/elster/elstererklaerung/ust/e50/v';
/**
 * Schema years this builder writes (ERiC 43.4.6.0 ships E50-2024 to E50-2026). Every E-code emitted
 * here exists in all three, except the W-IdNr E3000401, which E50-2024 does not know.
 */
const USTE_SCHEMA_JAHRE = [2024, 2025, 2026] as const;

/** ERiC datenartVersion token for the USt-Jahreserklärung (`USt_<year>`). */
export function usteDatenartVersion(year: number): string {
    return `USt_${year}`;
}

/** Integer-euro string (the UStE Bemessungsgrundlagen are full euros, no decimals). */
const eur = (n: number): string => String(Math.round(n));

/** Split "Musterstraße 1a" → { street, nr }; falls back to the whole string as street. */
function splitStrasse(s: string, hausnummer?: string): { street: string; nr: string } {
    if (hausnummer) return { street: s, nr: hausnummer };
    const m = s.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
    return m ? { street: m[1], nr: m[2].trim() } : { street: s, nr: '' };
}

/**
 * `Dauer_Unt_Eig` (E3001401, format `TT.MM-TT.MM`) — ONLY emitted when the
 * Unternehmereigenschaft did NOT span the whole calendar year (e.g. the business
 * ceased mid-year). Returns undefined for a full year (ERiC rejects a full-year entry).
 */
export function dauerUnternehmereigenschaft(year: number, startDate?: string, endDate?: string): string | undefined {
    const jan1 = `${year}-01-01`;
    const dec31 = `${year}-12-31`;
    const start = startDate && startDate > jan1 && startDate <= dec31 ? startDate : jan1;
    const end = endDate && endDate >= jan1 && endDate < dec31 ? endDate : dec31;
    if (start === jan1 && end === dec31) return undefined;
    const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
    return `${dm(start)}-${dm(end)}`;
}

/** Build the inner `<E50>` Nutzdaten block (16-space base indent for the EDS envelope). */
export function buildUsteNutzdaten(
    agg: UsteAggregate,
    betrieb: EuerBetrieb,
    steuernr13: string,
    dauer?: string,
): string {
    const schema = schemaJahr(agg.year, USTE_SCHEMA_JAHRE);
    // Each Vordruckzeile carries its OWN base + tax, so the tax is derived per line from the
    // (whole-euro) base — summing them is what the Vordruck's Ums_Sum must equal.
    const output19 = round2(Math.trunc(agg.lieferungenSonstLeistungen_19) * 0.19);
    const wertabgabeLieferungTax = round2(Math.trunc(agg.wertabgabeLieferung_19) * 0.19);
    const wertabgabeSonstigeTax = round2(Math.trunc(agg.wertabgabeSonstige_19) * 0.19);
    const output7 = round2(Math.trunc(agg.net_7) * 0.07);
    const totalOutput = round2(output19 + wertabgabeLieferungTax + wertabgabeSonstigeTax + output7);
    const vorsteuer = round2(agg.vat_in);
    // §13b: the owed reverse-charge tax adds to the USt AND (equally) to the Vorsteuer, so the
    // verbleibende USt is unchanged — but both must be declared (Ums_13b + E3006502 + E3009502).
    const rc = agg.reverseCharge;
    const showRc = rc != null && hasReverseCharge(rc);
    const rcOwed = showRc ? round2(rc.abs1Tax + rc.abs2Tax) : 0;
    const rcVorsteuer = showRc ? round2(rc.deductibleVat) : 0;
    const totalUst = round2(totalOutput + rcOwed);
    const totalVorsteuer = round2(vorsteuer + rcVorsteuer);
    const verbleibend = round2(totalUst - totalVorsteuer);
    const vorauszahlungssoll = round2(agg.prepaidVat);
    const abschluss = round2(verbleibend - vorauszahlungssoll);

    const { street, nr } = splitStrasse(betrieb.strasse, betrieb.hausnummer);
    const allg = wrap(
        24,
        'Allg',
        wrap(
            28,
            'Unternehmen',
            (betrieb.widnr && schema >= 2025 ? leaf(32, 'E3000401', betrieb.widnr) : '') +
                leaf(32, 'E3000901', betrieb.name) +
                wrap(
                    32,
                    'Adr',
                    leaf(36, 'E3001101', street) +
                        (nr ? leaf(36, 'E3001203', nr) : '') +
                        leaf(36, 'E3001206', betrieb.plz) +
                        leaf(36, 'E3001207', betrieb.ort),
                ),
        ) +
            // Dauer_Unt_Eig only for a PARTIAL-year Unternehmereigenschaft (e.g. Betriebsaufgabe).
            (dauer ? wrap(28, 'Dauer_Unt_Eig', leaf(32, 'E3001401', dauer)) : '') +
            wrap(28, 'Best_Art', leaf(32, 'E3002203', '1')),
    );

    const umsaetze = wrap(
        24,
        'Umsaetze',
        wrap(
            28,
            'Tabelle',
            // Bemessungsgrundlagen (net) are full euros; the USt amount stays decimal.
            // Ums_allg = Zeile 22 (plain revenue) and NESTS the unentgeltliche Wertabgaben:
            // E3003405/06 = Lieferungen §3 Abs. 1b (Zeile 23, the Betriebsaufgabe-Entnahme),
            // E3003505/06 = sonstige Leistungen §3 Abs. 9a (Zeile 24, the Privatanteile).
            (agg.net_19
                ? wrap(
                      32,
                      'Ums_allg',
                      leaf(36, 'E3003303', eur(agg.lieferungenSonstLeistungen_19)) +
                          leaf(36, 'E3003304', amtDe(output19)) +
                          (agg.wertabgabeLieferung_19 || agg.wertabgabeSonstige_19
                              ? wrap(
                                    36,
                                    'Unent_Wertabgaben',
                                    (agg.wertabgabeLieferung_19
                                        ? leaf(40, 'E3003405', eur(agg.wertabgabeLieferung_19)) +
                                          leaf(40, 'E3003406', amtDe(wertabgabeLieferungTax))
                                        : '') +
                                        (agg.wertabgabeSonstige_19
                                            ? leaf(40, 'E3003505', eur(agg.wertabgabeSonstige_19)) +
                                              leaf(40, 'E3003506', amtDe(wertabgabeSonstigeTax))
                                            : ''),
                                )
                              : ''),
                  )
                : '') +
                (agg.net_7
                    ? wrap(32, 'Ums_erm', leaf(36, 'E3004401', eur(agg.net_7)) + leaf(36, 'E3004402', amtDe(output7)))
                    : '') +
                wrap(32, 'Ums_Sum', leaf(36, 'E3006001', amtDe(totalOutput))),
        ),
    );

    // §13b: steuerpflichtige sonstige Leistungen for which the Leistungsempfänger owes the tax
    // (Ums_13b: E3102205/06 Abs. 1 EU, E3102503/04 Abs. 2 Drittland; E3102601 = Summe der Steuer).
    const ums13b =
        showRc && rc
            ? wrap(
                  24,
                  'Ums_13b',
                  wrap(
                      28,
                      'Tabelle',
                      (rc.abs1Base
                          ? leaf(32, 'E3102205', eur(rc.abs1Base)) + leaf(32, 'E3102206', amtDe(rc.abs1Tax))
                          : '') +
                          (rc.abs2Base
                              ? leaf(32, 'E3102503', eur(rc.abs2Base)) + leaf(32, 'E3102504', amtDe(rc.abs2Tax))
                              : '') +
                          wrap(32, 'Ums_13b_Sum', leaf(36, 'E3102601', amtDe(rcOwed))),
                  ),
              )
            : '';

    const abzVoSt = totalVorsteuer
        ? wrap(
              24,
              'Abz_VoSt',
              wrap(
                  28,
                  'Tabelle',
                  (vorsteuer ? leaf(32, 'E3006201', amtDe(vorsteuer)) : '') +
                      // E3006502: Vorsteuer from §13b-Leistungen (§15 Abs. 1 S. 1 Nr. 4 UStG).
                      (rcVorsteuer ? leaf(32, 'E3006502', amtDe(rcVorsteuer)) : '') +
                      wrap(32, 'Abz_VoSt_Sum', leaf(36, 'E3006901', amtDe(totalVorsteuer))),
              ),
          )
        : '';

    const berech = wrap(
        24,
        'Berech_USt',
        wrap(
            28,
            'Tabelle',
            leaf(32, 'E3009201', amtDe(totalOutput)) + // USt on steuerpflichtige Leistungen (19/7 %)
                (showRc ? leaf(32, 'E3009502', amtDe(rcOwed)) : '') + // USt owed by the Leistungsempfänger under §13b
                leaf(32, 'E3009801', amtDe(totalUst)) + // subtotal (incl. §13b)
                (totalVorsteuer ? leaf(32, 'E3009901', amtDe(totalVorsteuer)) : '') + // abziehbare Vorsteuer
                leaf(32, 'E3010201', amtDe(verbleibend)) + // verbleibender Betrag
                leaf(32, 'E3010601', amtDe(verbleibend)) + // Übertrag
                wrap(
                    32,
                    'Verbl_USt',
                    // E3011301 (Vorauszahlungssoll) is mandatory — always emit, "0,00" if none.
                    leaf(36, 'E3011101', amtDe(verbleibend)) + leaf(36, 'E3011301', amtDe(vorauszahlungssoll)),
                ) +
                wrap(32, 'Zahl_Erstatt', leaf(36, 'E3011401', amtDe(abschluss))),
        ),
    );

    const ust2a = wrap(20, 'USt2A', allg + umsaetze + ums13b + abzVoSt + berech);

    const vorsatz = wrap(
        20,
        'Vorsatz',
        leaf(24, 'Unterfallart', '50') +
            leaf(24, 'Vorgang', '01') +
            leaf(24, 'StNr', steuernr13) +
            leaf(24, 'Zeitraum', String(agg.year)) +
            leaf(24, 'AbsName', betrieb.name) +
            leaf(24, 'AbsStr', betrieb.strasse) +
            leaf(24, 'AbsPlz', betrieb.plz) +
            leaf(24, 'AbsOrt', betrieb.ort) +
            leaf(24, 'Copyright', '(C) 2025 Bayerisches Landesamt für Steuern') +
            leaf(24, 'OrdNrArt', 'S') +
            wrap(24, 'Rueckuebermittlung', leaf(28, 'Bescheid', '2')),
    );

    return (
        `${pad(16)}<E50 xmlns="${USTE_NS_PREFIX}${schema}" version="${schema}">\n` +
        ust2a +
        vorsatz +
        `${pad(16)}</E50>\n`
    );
}

/** Build the complete EDS document for the USt-Jahreserklärung. */
export function buildUsteEds(agg: UsteAggregate, config: ElsterConfig, betrieb: EuerBetrieb): string {
    const steuernr13 = toElsterSteuernummer(config.tax_number);
    const dauer = dauerUnternehmereigenschaft(agg.year, config.business_start_date, config.business_end_date);
    return buildEdsEnvelope({
        verfahren: 'ElsterErklaerung',
        datenArt: 'USt',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaFromElsterSteuernummer(steuernr13),
        nutzdaten: buildUsteNutzdaten(agg, betrieb, steuernr13, dauer),
    });
}

export function getUsteOutputFilename(entityId: string, year: number): string {
    return `uste-${entityId}-${year}.xml`;
}

/** Write the USt-Jahreserklärung EDS XML to the configured output directory. */
export function writeUsteXml(
    agg: UsteAggregate,
    config: ElsterConfig,
    betrieb: EuerBetrieb,
    outputPath?: string,
): string {
    const xml = buildUsteEds(agg, config, betrieb);
    const dir = config.output_directory;
    const filename = outputPath ?? join(dir, getUsteOutputFilename(config.entity_id, agg.year));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}
