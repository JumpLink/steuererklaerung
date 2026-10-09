/**
 * Amtliche Vordruckzeilen (annual-form line numbers) for the ELSTER Jahreserklärungen.
 *
 * DISPLAY-ONLY: this maps each computed figure to the LINE it goes into on the paper/web form in
 * Mein ELSTER, so a value from the Prüfblatt can be typed into the right field. It touches NO
 * emitted XML and NO computed figure — the XML builders (uste-xml.ts …) keep their own E-Kennzahlen
 * and stay byte-identical.
 *
 * Every line number below is EXTRACTED from the local ERiC distribution, never guessed. Source per
 * form/year is cited at the table. If a figure has no line in the source, it is OMITTED here (and
 * {@link buildUsteVordruckRows} logs it as unmapped) rather than invented.
 *
 * Keyed by year so a future year whose lines shifted can be added without disturbing 2025.
 */

import type { UsteFormFigures } from './uste-aggregate.ts';

/** One annual-form line: its number, the amtlicher Zeilentext, and the ELSTER Kennzahl behind it. */
export interface VordruckLine {
    /** Vordruckzeile on the annual form (the number printed on the ELSTER web form). */
    zeile: number;
    /** Amtlicher Zeilentext (from the Jahresdokumentation "Vordruckzeile"/"Beschreibung" column). */
    label: string;
    /** The ELSTER Kennzahl (E-code) that carries this figure — for traceability to the XML/XSD. */
    kennzahl: string;
}

/**
 * USt-Jahreserklärung 2025 — figure-key (a {@link UsteFormFigures} property) → its Vordruckzeile.
 *
 * SOURCE (local ERiC 43.4.6.0, gitignored under `app/elster/`), verified 2026-07-15:
 *   `ERiC-43.4.6.0-Dokumentation/ERiC-43.4.6.0/Dokumentation/Plausipruefungen/Erklaerungssteuern/`
 *   `USt/Jahresdokumentation_50_2025.xml` — worksheet "USt2A - Felder", column "Vordruckzeile"
 *   (each Kennzahl row's "Vordruckzeile" + "Beschreibung"). Cross-checked against the E50-2025 XSD
 *   (`…/Schnittstellenbeschreibungen/Erklaerungssteuern/USt_50_2025/Schema/E50-2025-Nutzdaten.xsd`)
 *   and the E-codes emitted by uste-xml.ts.
 */
const USTE_2025: Record<string, VordruckLine> = {
    // Felder row E3003303 → Vordruckzeile 22.
    lieferungen19: { zeile: 22, kennzahl: 'E3003303', label: 'Lieferungen und sonstige Leistungen zu 19 %' },
    // Felder row E3003405 → Vordruckzeile 23 (unentgeltliche Wertabgaben, context Unent_Wertabgaben).
    wertabgabeLieferung19: {
        zeile: 23,
        kennzahl: 'E3003405',
        label: 'Unentgeltliche Wertabgaben – Lieferungen nach § 3 Abs. 1b UStG zu 19 %',
    },
    // Felder row E3003505 → Vordruckzeile 24 (unentgeltliche Wertabgaben, context Unent_Wertabgaben).
    wertabgabeSonstige19: {
        zeile: 24,
        kennzahl: 'E3003505',
        label: 'Unentgeltliche Wertabgaben – sonstige Leistungen nach § 3 Abs. 9a UStG zu 19 %',
    },
    // Felder row E3004401 → Vordruckzeile 25.
    ermaessigt7: { zeile: 25, kennzahl: 'E3004401', label: 'Lieferungen und sonstige Leistungen zu 7 %' },
    // Felder row E3006001 (Ums_Sum) → Vordruckzeile 37: „Summe der Steuer (zu übertragen in Zeile 103)".
    steuerUmsaetze: { zeile: 37, kennzahl: 'E3006001', label: 'Summe der Steuer (steuerpflichtige Umsätze 19/7 %)' },
    // Felder row E3102205 (Ums_13b) → Vordruckzeile 65.
    reverseChargeAbs1: {
        zeile: 65,
        kennzahl: 'E3102205',
        label: 'Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 13b Abs. 1 UStG)',
    },
    // Felder row E3102503 (Ums_13b) → Vordruckzeile 67.
    reverseChargeAbs2: {
        zeile: 67,
        kennzahl: 'E3102503',
        label: 'Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 12 UStG)',
    },
    // Felder row E3102601 (Ums_13b_Sum) → Vordruckzeile 68: „Summe der Steuer (zu übertragen in Zeile 107)".
    steuer13b: { zeile: 68, kennzahl: 'E3102601', label: 'Summe der nach § 13b UStG geschuldeten Steuer' },
    // Felder row E3006201 (Abz_VoSt) → Vordruckzeile 79.
    vorsteuer: {
        zeile: 79,
        kennzahl: 'E3006201',
        label: 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern (§ 15 Abs. 1 Satz 1 Nr. 1 UStG)',
    },
    // Felder row E3006502 (Abz_VoSt) → Vordruckzeile 83.
    vorsteuer13b: {
        zeile: 83,
        kennzahl: 'E3006502',
        label: 'Vorsteuerbeträge aus Leistungen im Sinne des § 13b UStG (§ 15 Abs. 1 Satz 1 Nr. 4 UStG)',
    },
    // Felder row E3006901 (Abz_VoSt_Sum) → Vordruckzeile 87.
    vorsteuerSumme: { zeile: 87, kennzahl: 'E3006901', label: 'Summe der Vorsteuerbeträge' },
    // Felder row E3011101 (Verbl_USt) → Vordruckzeile 118.
    verbleibend: { zeile: 118, kennzahl: 'E3011101', label: 'Verbleibende Umsatzsteuer (Jahres-Zahllast)' },
    // Felder row E3011301 (Verbl_USt) → Vordruckzeile 119.
    vorauszahlungssoll: {
        zeile: 119,
        kennzahl: 'E3011301',
        label: 'Vorauszahlungssoll (einschl. Sondervorauszahlung)',
    },
    // Felder row E3011401 (Zahl_Erstatt) → Vordruckzeile 120.
    abschluss: { zeile: 120, kennzahl: 'E3011401', label: 'Abschlusszahlung / Erstattungsanspruch' },
};

/** Year-keyed UStE Vordruckzeilen. Add a new year's table when its line numbers are verified. */
export const USTE_VORDRUCK_LINES: Record<number, Record<string, VordruckLine>> = {
    2025: USTE_2025,
};

/**
 * The Vordruckzeile for a UStE figure-key in `year`, or undefined when the year/figure is not in
 * the extracted ERiC mapping. Callers must treat undefined as "unmapped" (skip + log), NEVER guess.
 */
export function usteVordruckLine(year: number, figureKey: string): VordruckLine | undefined {
    return USTE_VORDRUCK_LINES[year]?.[figureKey];
}

/** One rendered mapping row: a computed figure placed on its annual-form line. */
export interface UsteVordruckRow {
    /** The {@link UsteFormFigures} key this row came from. */
    figureKey: string;
    zeile: number;
    kennzahl: string;
    label: string;
    /** The value that is typed into this line. */
    betrag: number;
    /** 'bmg' = Bemessungsgrundlage (whole euro), 'steuer' = a tax/sum amount (with cents). */
    art: 'bmg' | 'steuer';
}

/**
 * How to read each figure's value + kind out of {@link UsteFormFigures}, in Vordruck order.
 * A `value` of undefined means the line is not present for this case (e.g. no §13b, no 7 %) and is
 * silently skipped; a present value with no mapped {@link usteVordruckLine} is logged as unmapped.
 */
const USTE_FIGURE_ACCESSORS: Array<{
    key: string;
    art: 'bmg' | 'steuer';
    value: (f: UsteFormFigures) => number | undefined;
}> = [
    { key: 'lieferungen19', art: 'bmg', value: (f) => f.lieferungen19.bmg },
    { key: 'wertabgabeLieferung19', art: 'bmg', value: (f) => f.wertabgabeLieferung19?.bmg },
    { key: 'wertabgabeSonstige19', art: 'bmg', value: (f) => f.wertabgabeSonstige19?.bmg },
    { key: 'ermaessigt7', art: 'bmg', value: (f) => f.ermaessigt7?.bmg },
    { key: 'steuerUmsaetze', art: 'steuer', value: (f) => f.steuerUmsaetze },
    { key: 'reverseChargeAbs1', art: 'bmg', value: (f) => f.reverseChargeAbs1?.bmg },
    { key: 'reverseChargeAbs2', art: 'bmg', value: (f) => f.reverseChargeAbs2?.bmg },
    { key: 'steuer13b', art: 'steuer', value: (f) => f.steuer13b || undefined },
    { key: 'vorsteuer', art: 'steuer', value: (f) => f.vorsteuer },
    { key: 'vorsteuer13b', art: 'steuer', value: (f) => f.vorsteuer13b || undefined },
    { key: 'vorsteuerSumme', art: 'steuer', value: (f) => f.vorsteuerSumme },
    { key: 'verbleibend', art: 'steuer', value: (f) => f.verbleibend },
    { key: 'vorauszahlungssoll', art: 'steuer', value: (f) => f.vorauszahlungssoll },
    { key: 'abschluss', art: 'steuer', value: (f) => f.abschluss },
];

/**
 * Turn the computed UStE form figures into per-line mapping rows for `year`, in Vordruck order.
 * Figures whose line is not in the extracted ERiC mapping are OMITTED and reported via `warn`
 * (never guessed). Pure; used by the CLI `--vordruck` renderer and the JSON output.
 */
export function buildUsteVordruckRows(
    f: UsteFormFigures,
    year: number,
    warn: (msg: string) => void = () => {},
): UsteVordruckRow[] {
    const rows: UsteVordruckRow[] = [];
    for (const acc of USTE_FIGURE_ACCESSORS) {
        const betrag = acc.value(f);
        if (betrag === undefined) continue; // line not present for this case (no §13b / no 7 % …)
        const line = usteVordruckLine(year, acc.key);
        if (!line) {
            warn(`Keine Vordruckzeile für '${acc.key}' (Jahr ${year}) im ERiC-Mapping gefunden — übersprungen.`);
            continue;
        }
        rows.push({
            figureKey: acc.key,
            zeile: line.zeile,
            kennzahl: line.kennzahl,
            label: line.label,
            betrag,
            art: acc.art,
        });
    }
    return rows;
}

/** One "stille Anpassung": a config value that drives a form line but shows in no other report. */
export interface UsteAnpassung {
    /** Human label (config bezeichnung, possibly with the Gesellschafter). */
    bezeichnung: string;
    /** Net amount / Bemessungsgrundlage the adjustment carries. */
    betrag: number;
    /** The Vordruckzeile it drives — undefined when it is NOT a USt line (e.g. a Sonderbetriebsausgabe). */
    zeile?: number;
    /** Where the value belongs (a USt line description, or a note for non-USt adjustments). */
    ziel: string;
    /** The legal basis (§) that classifies the adjustment. */
    rechtsgrund: string;
    /** true ⇒ already folded into the computed USt (advisory only); false ⇒ no USt effect. */
    ustWirksam: boolean;
}

/** The raw adjustment inputs, decoupled from the full ElsterConfig for easy testing. */
export interface UsteAnpassungenInput {
    /** `adjustments.privatanteile` — deemed sonstige Leistungen (§ 3 Abs. 9a). */
    privatanteile?: Array<{ bezeichnung: string; netto: number; ust_satz?: number }>;
    /** The Betriebsaufgabe assets withdrawn to private (§ 3 Abs. 1b) — from the UStE aggregate. */
    entnahmeAssets?: Array<{ bezeichnung: string; gemeinerWert: number }>;
    /** `adjustments.sonderbetriebsausgaben` — per-partner, a Feststellung matter (no USt). */
    sonderbetriebsausgaben?: Array<{ gesellschafter_id: string; bezeichnung: string; betrag: number }>;
}

/**
 * Surface the "stille Anpassungen" that drive form lines but appear in no report: the Privatanteile
 * (→ UStE Zeile 24, § 3 Abs. 9a), the Betriebsaufgabe-Entnahme (→ UStE Zeile 23, § 3 Abs. 1b), and
 * the Sonderbetriebsausgaben (→ Feststellung, no USt). ADVISORY — the amounts are already inside the
 * computed figures; this only tells the user WHAT to type WHERE. Reuses {@link usteVordruckLine}.
 */
export function buildUsteAnpassungen(input: UsteAnpassungenInput, year: number): UsteAnpassung[] {
    const out: UsteAnpassung[] = [];

    const z24 = usteVordruckLine(year, 'wertabgabeSonstige19');
    for (const p of input.privatanteile ?? []) {
        out.push({
            bezeichnung: p.bezeichnung,
            betrag: p.netto,
            zeile: z24?.zeile,
            ziel: z24 ? `UStE Zeile ${z24.zeile} — ${z24.label}` : 'UStE (Zeile im ERiC-Mapping nicht gefunden)',
            rechtsgrund: '§ 3 Abs. 9a UStG (unentgeltliche sonstige Leistung)',
            ustWirksam: true,
        });
    }

    const z23 = usteVordruckLine(year, 'wertabgabeLieferung19');
    for (const a of (input.entnahmeAssets ?? []).filter((asset) => asset.gemeinerWert > 0)) {
        out.push({
            bezeichnung: a.bezeichnung,
            betrag: a.gemeinerWert,
            zeile: z23?.zeile,
            ziel: z23 ? `UStE Zeile ${z23.zeile} — ${z23.label}` : 'UStE (Zeile im ERiC-Mapping nicht gefunden)',
            rechtsgrund: '§ 3 Abs. 1b Nr. 1 UStG (Entnahme ins Privatvermögen bei Betriebsaufgabe)',
            ustWirksam: true,
        });
    }

    for (const s of input.sonderbetriebsausgaben ?? []) {
        out.push({
            bezeichnung: `${s.bezeichnung} (${s.gesellschafter_id})`,
            betrag: s.betrag,
            // Sonderbetriebsausgaben reduce the Gewinnanteil in the Feststellung — NO USt line.
            ziel: 'Feststellung (Anlage FE) — mindert den Gewinnanteil des Gesellschafters; KEIN USt-Bezug',
            rechtsgrund: '§ 4 Abs. 4 i.V.m. § 15 Abs. 1 Satz 1 Nr. 2 EStG (Sonderbetriebsausgabe)',
            ustWirksam: false,
        });
    }

    return out;
}
