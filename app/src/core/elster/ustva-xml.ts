/**
 * Build ELSTER USt-VA XML and write to file (ISO-8859-15).
 * Structure based on ELSTER help: Anmeldungssteuern / Steuerfall; kz66, kz81, kz86.
 * May need adjustment when official XML/ML specs are available.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElsterConfig } from '../config/index.ts';
import type { UstvaAggregate } from './ustva-aggregate.ts';
import { hasReverseCharge } from './reverse-charge.ts';
import { buildEdsEnvelope, escapeXml, PLACEHOLDER_HERSTELLER_ID } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';

const USTVA_NS_PREFIX = 'http://finkonsens.de/elster/elsteranmeldung/ustva/v';

/** One USt-VA Kennzahl: the element name (`Kz81`) and its already-formatted value string. */
interface UstvaKz {
    kz: string;
    value: string;
}

/**
 * The USt-VA Kennzahlen for an aggregate, in numeric order, ONLY the non-zero ones (a declared
 * `0` triggers an ELSTER "Nullwert" hint). Shared by the plain XML (Mein-ELSTER import) and the
 * EDS (ERiC) builders so they never drift:
 *   - Kz 46/47 §13b Abs. 1 (EU), Kz 84/85 §13b Abs. 2 (third country), Kz 67 deductible §13b-Vorsteuer
 *   - Kz 66 Vorsteuer, Kz 81/86 Bemessungsgrundlagen (full euros, integer — ERiC rejects "1000.00"),
 *     Kz 83 Zahllast (= 19 % of net_19 + 7 % of net_7 − Vorsteuer).
 * §13b is zahllastneutral (Kz 47+85 owed nets against the deductible Kz 67) → Kz 83 is unchanged.
 */
function computeUstvaKennzahlen(aggregate: UstvaAggregate): UstvaKz[] {
    const vat19 = Math.round(aggregate.net_19 * 19) / 100;
    const vat7 = Math.round(aggregate.net_7 * 7) / 100;
    const kz83 = (vat19 + vat7 - aggregate.vat_in).toFixed(2);
    const rc = aggregate.reverseCharge;
    const showRc = rc != null && hasReverseCharge(rc);

    const out: UstvaKz[] = [];
    if (showRc && rc.abs1Base !== 0) {
        out.push({ kz: 'Kz46', value: String(Math.round(rc.abs1Base)) });
        out.push({ kz: 'Kz47', value: rc.abs1Tax.toFixed(2) });
    }
    if (aggregate.vat_in !== 0) out.push({ kz: 'Kz66', value: aggregate.vat_in.toFixed(2) });
    if (showRc && rc.deductibleVat !== 0) out.push({ kz: 'Kz67', value: rc.deductibleVat.toFixed(2) });
    if (Math.round(aggregate.net_19) !== 0) out.push({ kz: 'Kz81', value: String(Math.round(aggregate.net_19)) });
    if (kz83 !== '0.00') out.push({ kz: 'Kz83', value: kz83 });
    if (showRc && rc.abs2Base !== 0) {
        out.push({ kz: 'Kz84', value: String(Math.round(rc.abs2Base)) });
        out.push({ kz: 'Kz85', value: rc.abs2Tax.toFixed(2) });
    }
    if (Math.round(aggregate.net_7) !== 0) out.push({ kz: 'Kz86', value: String(Math.round(aggregate.net_7)) });
    return out;
}

/**
 * Build USt-VA XML string (content suitable for ISO-8859-15; use only ASCII to avoid encoding issues).
 */
export function buildUstvaXml(aggregate: UstvaAggregate, config: ElsterConfig): string {
    const version = String(config.schema_version);
    const ns = USTVA_NS_PREFIX + version;
    const zeitraum = getZeitraum(config.period);
    const year = String(config.period.year);

    // Kennzahlen (numeric order, non-zero only) at the plain-XML 6-space indent; escapeXml is a
    // no-op on the numeric values but kept for safety. Kz66/83 decimal, Kz81/86 integer euros.
    const kzLines = computeUstvaKennzahlen(aggregate).map((k) => `      <${k.kz}>${escapeXml(k.value)}</${k.kz}>`);

    return (
        '<?xml version="1.0" encoding="ISO-8859-15" standalone="no"?>\n' +
        `<Anmeldungssteuern xmlns="${ns}" version="${version}">\n` +
        '  <Steuerfall>\n' +
        '    <Umsatzsteuervoranmeldung>\n' +
        `      <Jahr>${escapeXml(year)}</Jahr>\n` +
        `      <Zeitraum>${escapeXml(zeitraum)}</Zeitraum>\n` +
        `      <Steuernummer>${escapeXml(toElsterSteuernummer(config.tax_number))}</Steuernummer>\n` +
        `      <Kz09>${PLACEHOLDER_HERSTELLER_ID}</Kz09>\n` +
        (kzLines.length > 0 ? kzLines.join('\n') + '\n' : '') +
        '    </Umsatzsteuervoranmeldung>\n' +
        '  </Steuerfall>\n' +
        '</Anmeldungssteuern>\n'
    );
}

/**
 * Compute the ELSTER Zeitraum code for a period.
 * Monthly: "01"–"12"; Quarterly: "41"–"44".
 */
function getZeitraum(period: ElsterConfig['period']): string {
    if (period.month != null) return String(period.month).padStart(2, '0');
    if (period.quarter != null) return String(40 + period.quarter);
    return '01';
}

/**
 * Build a complete EDS (ELSTER DatenSatz) XML suitable for ERiC's EricBearbeiteVorgang.
 * Wraps the inner Anmeldungssteuern content in the required TransferHeader + NutzdatenHeader envelope.
 */
export function buildUstvaEds(aggregate: UstvaAggregate, config: ElsterConfig): string {
    const version = String(config.schema_version);
    const ns = USTVA_NS_PREFIX + version;
    const zeitraum = getZeitraum(config.period);
    const year = String(config.period.year);

    // Empfaenger (BuFa) = the first 4 digits of the CONVERTED 13-digit Steuernummer — same as the
    // EUER/UStE builders. Deriving it from the raw regional FF/BBB/UUUUP form yielded an invalid
    // "18/2" that failed ERiC's Empfaenger union check for GbR tax numbers.
    const bufaNr = bufaFromElsterSteuernummer(toElsterSteuernummer(config.tax_number));

    // Same Kennzahlen as the plain XML (numeric order, non-zero only), rendered at the EDS 28-space
    // indent. §13b (Kz 46/47/67/84/85) is included only when present → a plain UStVA stays identical.
    const ind = '                            ';
    const kzBlock = computeUstvaKennzahlen(aggregate).map((k) => `${ind}<${k.kz}>${k.value}</${k.kz}>`);

    // ONE source for the Hersteller-ID, used twice below: Kz09 in the Nutzdaten and HerstellerID in
    // the TransferHeader. ERiC compares them and rejects a mismatch outright — Fehler 89, "Die
    // angegebenen Identifikationsnummern des Softwareherstellers in Vorsatz und Kz 09 (Satz2)
    // unterscheiden sich". Kz09 used to be the literal '00000' while the envelope carried the real
    // id, so validate-eric failed for every entity that configures one. It stayed hidden while the
    // returns went out through the Mein-ELSTER XML import, where the portal supplies the id and the
    // plain builder's '00000' is correct — which is why buildUstvaXml keeps it.
    const herstellerId = config.hersteller_id ?? PLACEHOLDER_HERSTELLER_ID;

    // ERiC requires the Erstellungsdatum + DatenLieferant address inside the Anmeldungssteuern
    // Nutzdaten. The PLAIN buildUstvaXml (for the Mein-ELSTER XML-Import) omits them — Mein ELSTER
    // fills them from the profile — so this lives only in the EDS. Gated on config.betrieb (the
    // byte-exact test fixture has none → unchanged).
    const b = config.betrieb;
    const datenLieferant = b
        ? `                    <Erstellungsdatum>${erstellungsdatumYyyymmdd()}</Erstellungsdatum>\n` +
          '                    <DatenLieferant>\n' +
          `                        <Name>${escapeXml(b.name)}</Name>\n` +
          `                        <Strasse>${escapeXml(b.strasse)}</Strasse>\n` +
          `                        <PLZ>${escapeXml(b.plz)}</PLZ>\n` +
          `                        <Ort>${escapeXml(b.ort)}</Ort>\n` +
          '                    </DatenLieferant>\n'
        : '';

    const nutzdaten =
        `                <Anmeldungssteuern xmlns="${ns}" version="${version}">\n` +
        datenLieferant +
        '                    <Steuerfall>\n' +
        '                        <Umsatzsteuervoranmeldung>\n' +
        `                            <Jahr>${escapeXml(year)}</Jahr>\n` +
        `                            <Zeitraum>${escapeXml(zeitraum)}</Zeitraum>\n` +
        `                            <Steuernummer>${escapeXml(toElsterSteuernummer(config.tax_number))}</Steuernummer>\n` +
        `                            <Kz09>${escapeXml(herstellerId)}</Kz09>\n` +
        `${kzBlock.join('\n')}\n` +
        '                        </Umsatzsteuervoranmeldung>\n' +
        '                    </Steuerfall>\n' +
        '                </Anmeldungssteuern>\n';

    return buildEdsEnvelope({
        verfahren: 'ElsterAnmeldung',
        datenArt: 'UStVA',
        // 'send-Auth' like every other return builder — ERiC rejects 'send-NoSig' for UStVA_2025
        // ("Versandart nicht erlaubt"), which blocked validate-eric for any UStVA.
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaNr,
        nutzdaten,
    });
}

/** Today as YYYYMMDD for the DatenLieferant Erstellungsdatum (EDS validation/transmission). */
function erstellungsdatumYyyymmdd(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Generate output filename for the period (e.g. ustva-2025-1.xml for Q1, ustva-2025-3.xml for March).
 */
export function getUstvaOutputFilename(period: ElsterConfig['period']): string {
    const { year, quarter, month } = period;
    if (quarter != null) {
        return `ustva-${year}-Q${quarter}.xml`;
    }
    if (month != null) {
        return `ustva-${year}-${String(month).padStart(2, '0')}.xml`;
    }
    return `ustva-${year}.xml`;
}

/**
 * Write USt-VA XML to the configured output directory. Creates directory if needed.
 * Uses Latin-1 byte output so that ISO-8859-15 compatible readers accept it (ASCII subset).
 */
export function writeUstvaXml(aggregate: UstvaAggregate, config: ElsterConfig, outputPath?: string): string {
    const xml = buildUstvaXml(aggregate, config);
    const dir = config.output_directory;
    const filename = outputPath ?? join(dir, getUstvaOutputFilename(config.period));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}

/**
 * The USt-VA "Mein ELSTER XML-Import" artifact for a GUI export or web download: the plain
 * `<Anmeldungssteuern>` XML (buildUstvaXml — NOT the ERiC `<Elster>` envelope), a suggested
 * filename, and the ISO-8859-15 bytes. This is the file a user WITHOUT a Hersteller-ID uploads
 * under "Umsatzsteuer-Voranmeldung → XML-Import" in Mein ELSTER (the only form that portal
 * accepts as XML — the annual returns are typed into the web forms).
 *
 * The config is scoped to `year`/`quarter` HERE (not by each caller) so the correctness-critical
 * invariant — `schema_version` MUST equal the filing year, or the `ustva/v<year>` namespace +
 * `<Anmeldungssteuern version>` silently point at the wrong schema — lives in one place. USt-VA
 * content is pure numeric ASCII (a subset of ISO-8859-15), so the per-code-unit byte mapping is
 * exact and honours the charset the XML header declares.
 */
export function buildUstvaPortalUpload(
    aggregate: UstvaAggregate,
    baseConfig: ElsterConfig,
    year: number,
    quarter: number,
): { filename: string; xml: string; bytes: Uint8Array } {
    const config: ElsterConfig = { ...baseConfig, schema_version: year, period: { year, quarter } };
    const xml = buildUstvaXml(aggregate, config);
    const filename = getUstvaOutputFilename(config.period);
    const bytes = Uint8Array.from(xml, (ch) => ch.charCodeAt(0));
    return { filename, xml, bytes };
}
