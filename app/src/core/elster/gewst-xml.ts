/**
 * Gewerbesteuererklärung GewSt 1 A (GewSt_20_2025) XML builder for ELSTER/ERiC.
 *
 * Structure from the E20-2025 schema + shipped example: Nutzdaten root
 * `<E20 …/gewst/e20/v2025>` → `<GewSt1A>` (Allgemein, Rechtsform, Gewinn) + `<Vorsatz>`.
 * The taxpayer declares the Gewinn aus Gewerbebetrieb (= the EÜR profit); the Finanzamt
 * applies the §11 Abrundung, the €24.500 Freibetrag and the 3,5 % Messzahl to compute
 * the Steuermessbetrag (€0 for the dissolved GbR). DatenArt `GewSt`, token `GewSt_<year>`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElsterConfig } from '../config/index.ts';
import type { GewstResult } from './gewst.ts';
import type { EuerBetrieb } from './euer-xml.ts';
import { buildEdsEnvelope } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';
import { leaf, wrap, pad, schemaJahr } from './xml-format.ts';

const GEWST_NS_PREFIX = 'http://finkonsens.de/elster/elstererklaerung/gewst/e20/v';
/** Schema years this builder writes; E20-2024 and E20-2025 know every E-code emitted here. */
const GEWST_SCHEMA_JAHRE = [2024, 2025] as const;

/** ERiC datenartVersion token for the Gewerbesteuererklärung (`GewSt_<year>`). */
export function gewstDatenartVersion(year: number): string {
    return `GewSt_${year}`;
}

/** The Gewinn aus Gewerbebetrieb before §8/§9 (= EÜR profit) from the GewSt result. */
function gewinnVorHinzurechnungen(result: GewstResult): number {
    return result.gewerbeertrag - result.sumHinzurechnungen + result.sumKuerzungen;
}

/**
 * `Betr_Eroeff/E4002205` — "Die werbende Tätigkeit wurde in <Jahr> beendet am (TT.MM)". Emitted
 * only when the Betriebsaufgabe falls in the declared year; it tells the Gemeinde/Finanzamt the
 * Gewerbebetrieb ended (so no further Erhebungszeiträume are expected). Format is TT.MM — no year.
 *
 * @param businessEndDate ISO `YYYY-MM-DD` from the ELSTER config, or undefined for a going concern.
 */
export function werbendeTaetigkeitBeendet(year: number, businessEndDate?: string): string | undefined {
    if (!businessEndDate?.startsWith(`${year}-`)) return undefined;
    return `${businessEndDate.slice(8, 10)}.${businessEndDate.slice(5, 7)}`;
}

/** Build the inner `<E20>` Nutzdaten block (16-space base indent for the EDS envelope). */
export function buildGewstNutzdaten(
    result: GewstResult,
    betrieb: EuerBetrieb,
    steuernr13: string,
    year: number,
    businessEndDate?: string,
): string {
    const beendet = werbendeTaetigkeitBeendet(year, businessEndDate);
    const gewst1a = wrap(
        20,
        'GewSt1A',
        wrap(24, 'Allgemein', leaf(28, 'E4000101', betrieb.name) + leaf(28, 'E4000201', betrieb.art)) +
            wrap(24, 'Rechtsform', leaf(28, 'E4000501', betrieb.rechtsform ?? '270')) +
            // Single Betriebsstätte in one Gemeinde, not relocated (JaNein 2 = nein), + its PLZ/Ort.
            wrap(
                24,
                'Ang_Gew_Betr',
                wrap(
                    28,
                    'Betr_St',
                    leaf(32, 'E4001506', '2') +
                        leaf(32, 'E4001507', '2') +
                        leaf(32, 'E4001102', '2') +
                        leaf(32, 'E4001110', betrieb.plz) +
                        leaf(32, 'E4001111', betrieb.ort),
                ) +
                    // Betr_Eroeff follows Betr_St in the schema sequence (Betr_St, Heb_Nr,
                    // Betr_Eroeff, OG) and carries the end of the werbende Tätigkeit.
                    (beendet ? wrap(28, 'Betr_Eroeff', leaf(32, 'E4002205', beendet)) : ''),
            ) +
            wrap(24, 'Gewinn', leaf(28, 'E4001703', String(Math.round(gewinnVorHinzurechnungen(result))))),
    );

    const vorsatz = wrap(
        20,
        'Vorsatz',
        leaf(24, 'Unterfallart', '20') +
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

    const schema = schemaJahr(year, GEWST_SCHEMA_JAHRE);
    return (
        `${pad(16)}<E20 xmlns="${GEWST_NS_PREFIX}${schema}" version="${schema}">\n` +
        gewst1a +
        vorsatz +
        `${pad(16)}</E20>\n`
    );
}

/** Build the complete EDS document for the Gewerbesteuererklärung. */
export function buildGewstEds(result: GewstResult, config: ElsterConfig, betrieb: EuerBetrieb, year: number): string {
    const steuernr13 = toElsterSteuernummer(config.tax_number);
    return buildEdsEnvelope({
        verfahren: 'ElsterErklaerung',
        datenArt: 'GewSt',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaFromElsterSteuernummer(steuernr13),
        nutzdaten: buildGewstNutzdaten(result, betrieb, steuernr13, year, config.business_end_date),
    });
}

export function getGewstOutputFilename(entityId: string, year: number): string {
    return `gewst-${entityId}-${year}.xml`;
}

/** Write the Gewerbesteuererklärung EDS XML to the configured output directory. */
export function writeGewstXml(
    result: GewstResult,
    config: ElsterConfig,
    betrieb: EuerBetrieb,
    year: number,
    outputPath?: string,
): string {
    const xml = buildGewstEds(result, config, betrieb, year);
    const dir = config.output_directory;
    const filename = outputPath ?? join(dir, getGewstOutputFilename(config.entity_id, year));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}
