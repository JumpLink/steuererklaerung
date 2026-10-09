/**
 * USt-Jahreserklärung report: orchestrate the EÜR aggregate and produce the annual VAT
 * figures (taxable revenue by rate, input/output VAT, Zahllast) plus the closing balance
 * against the already-filed Voranmeldungen.
 */

import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import {
    aggregateUsteFromEuerTx,
    computeUsteFormFigures,
    type UsteAggregate,
    type UsteEntnahme,
    type UsteFormFigures,
    type UsteFormLine,
} from '../../elster/uste-aggregate.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';
import {
    buildUsteVordruckRows,
    buildUsteAnpassungen,
    type UsteAnpassung,
    type UsteVordruckRow,
} from '../../elster/vordruck-lines.ts';
import { euerReportByTransactions, buildAufgabegewinn } from './euer.ts';
import { prepaidVatFromFilings } from '../filings.ts';
import { fmtDe as fmt } from '../../lib/money.ts';

/**
 * Compute the annual UStE figures for the year from the transaction-driven EÜR.
 *
 * The already-filed Vorauszahlungen (subtracted from the annual Zahllast to get the
 * Abschlusszahlung) are read from the filings register when it holds USt-VA entries for the
 * year — the authoritative record of what was actually filed — and only fall back to the manual
 * `uste.prepaid_vat` config when the register is empty. `entityId` defaults to the config's
 * ledger `entity_id`; the register lookup is alias-tolerant (gbr ⇔ artcode).
 */
export async function usteReport(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    options: { accountKeys?: string[]; entityId?: string; agg?: EuerTxAggregate } = {},
): Promise<UsteAggregate> {
    // Reuse a pre-computed EÜR aggregate when the caller has one (web/app cache) — one derivation
    // path, no extra Paperless fetch.
    const euer =
        options.agg ?? (await euerReportByTransactions(syncConfig, year, { accountKeys: options.accountKeys, elster }));
    const entityId = options.entityId ?? elster.entity_id;
    const fromRegister = entityId ? prepaidVatFromFilings(entityId, year) : null;
    const prepaidVat = fromRegister ?? elster.uste?.prepaid_vat ?? 0;
    const source: 'register' | 'config' = fromRegister != null ? 'register' : 'config';
    return { ...aggregateUsteFromEuerTx(euer, prepaidVat, usteEntnahme(elster, year)), prepaidVatSource: source };
}

/**
 * The Betriebsaufgabe assets whose withdrawal is a §3 Abs. 1b supply, for the year the Aufgabe
 * actually falls in. Reuses {@link buildAufgabegewinn} (same gemeine Werte as the Aufgabegewinn),
 * and drops assets flagged `vorsteuerabzug: false` — without an input-tax deduction on acquisition
 * there is no deemed supply. Returns undefined when the entity has no Aufgabe in `year`.
 */
export function usteEntnahme(elster: ElsterConfig, year: number): UsteEntnahme | undefined {
    const aufgabe = buildAufgabegewinn(elster, year);
    if (!aufgabe) return undefined;
    if (!aufgabe.datum.startsWith(String(year))) return undefined;
    const ohneVorsteuer = new Set(
        (elster.adjustments?.anlageverzeichnis ?? []).filter((a) => a.vorsteuerabzug === false).map((a) => a.id),
    );
    return {
        assets: aufgabe.assets
            .filter((a) => !ohneVorsteuer.has(a.id))
            .map((a) => ({ bezeichnung: a.bezeichnung, gemeinerWert: a.gemeinerWert })),
    };
}

/** Integer-euro amount, de-DE grouped (Bemessungsgrundlagen are stated in full euros). */
const eurInt = (n: number): string => Math.trunc(n).toLocaleString('de-DE');

const LABEL_W = 50;
const BMG_W = 11;
const TAX_W = 13;

/** One report line: label, optional BMG (full euro), optional Steuer (decimal). */
function usteLine(label: string, bmg: string, tax: string): string {
    return `  ${label.padEnd(LABEL_W)}${bmg.padStart(BMG_W)}${tax.padStart(TAX_W)}`;
}

/**
 * Print the annual VAT summary the way the ANNUAL FORM computes it: per rate the Bemessungsgrundlage
 * rounded DOWN to full euro AND the tax derived from it (matching the Übertragungsprotokoll), the §13b
 * tax per line (which ELSTER does NOT auto-compute), and the closing balance. See
 * {@link computeUsteFormFigures}.
 */
export function printUsteReport(u: UsteAggregate): void {
    const f = computeUsteFormFigures(u);
    const line = (l: UsteFormLine, label: string) => console.log(usteLine(label, eurInt(l.bmg), fmt(l.tax)));

    console.log(`\nUmsatzsteuer-Jahreserklärung ${u.year} — Prüfblatt`);
    console.log('(Werte wie im Formular: Bemessungsgrundlage auf volle Euro abgerundet, Steuer daraus abgeleitet)');
    console.log('='.repeat(LABEL_W + BMG_W + TAX_W + 2));
    console.log(usteLine('', 'BMG (€)', 'Steuer (€)'));

    console.log('Steuerpflichtige Umsätze / unentgeltliche Wertabgaben');
    line(f.lieferungen19, 'Z22 Lieferungen/sonst. Leistungen 19 %');
    if (f.wertabgabeLieferung19) {
        line(f.wertabgabeLieferung19, 'Z23 unentgeltl. Wertabgabe §3 Abs. 1b 19 %');
        for (const a of u.entnahmeAssets ?? []) {
            console.log(`        · ${a.bezeichnung.padEnd(38)} ${eurInt(a.gemeinerWert).padStart(8)} € gem. Wert`);
        }
    }
    if (f.wertabgabeSonstige19) line(f.wertabgabeSonstige19, 'Z24 unentgeltl. Wertabgabe §3 Abs. 9a 19 %');
    if (f.ermaessigt7) line(f.ermaessigt7, 'Umsätze zum ermäßigten Steuersatz 7 %');
    console.log(usteLine('Z37 Summe der Steuer', '', fmt(f.steuerUmsaetze)));
    if (u.net_0 !== 0) console.log(usteLine('Steuerfreie / §13b-Umsätze (nachrichtlich)', eurInt(u.net_0), ''));

    if (f.reverseChargeAbs1 || f.reverseChargeAbs2) {
        console.log('\n§13b — Leistungsempfänger schuldet die Steuer (von ELSTER NICHT berechnet, selbst eintragen)');
        if (f.reverseChargeAbs1) line(f.reverseChargeAbs1, 'Z65 §13b Abs. 1 EU-Leistungen 19 %');
        if (f.reverseChargeAbs2) line(f.reverseChargeAbs2, 'Z67 §13b Abs. 2 Drittland 19 %');
        console.log(usteLine('Z68 Summe §13b-Steuer', '', fmt(f.steuer13b)));
    }

    console.log('\nAbziehbare Vorsteuer');
    console.log(usteLine('Z79 Vorsteuer aus Rechnungen', '', fmt(f.vorsteuer)));
    if (f.vorsteuer13b) console.log(usteLine('Z83 Vorsteuer aus §13b (zahllastneutral)', '', fmt(f.vorsteuer13b)));
    console.log(usteLine('Z87 Summe Vorsteuer', '', fmt(f.vorsteuerSumme)));

    console.log('\nBerechnung');
    console.log(usteLine('Z118 Verbleibende USt (Jahres-Zahllast)', '', fmt(f.verbleibend)));
    const quelle = f.prepaidVatSource === 'config' ? 'aus Config' : 'aus Filing-Register';
    console.log(usteLine(`Z119 − Vorauszahlungssoll (${quelle})`, '', fmt(f.vorauszahlungssoll)));
    const label = f.abschluss >= 0 ? 'Z120 = Abschlusszahlung' : 'Z120 = Erstattung';
    console.log(usteLine(label, '', fmt(Math.abs(f.abschluss))));

    console.log(
        '\nHinweis: Das Vorauszahlungssoll (Z119) stammt aus UNSEREM Filing-Register (bereits angemeldete\n' +
            'USt-VA-Zahllasten), NICHT aus dem amtlichen Soll des Finanzamts — gegen das ELSTER-Steuerkonto\n' +
            'abgleichen, sonst kann die Abschlusszahlung (Z120) falsch sein.',
    );
    console.log('');
}

/**
 * The "stille Anpassungen" for the UStE, extracted from the ElsterConfig + the aggregate's
 * Betriebsaufgabe-Entnahme. Thin adapter over {@link buildUsteAnpassungen} (the pure, testable core).
 */
export function usteAnpassungen(u: UsteAggregate, elster: ElsterConfig, year: number): UsteAnpassung[] {
    return buildUsteAnpassungen(
        {
            privatanteile: elster.adjustments?.privatanteile,
            entnahmeAssets: u.entnahmeAssets,
            sonderbetriebsausgaben: elster.adjustments?.sonderbetriebsausgaben,
        },
        year,
    );
}

/** Build the Vordruckzeilen mapping rows for the given year (unmapped figures → stderr warning). */
export function usteVordruckRows(u: UsteAggregate, year: number): UsteVordruckRow[] {
    return buildUsteVordruckRows(computeUsteFormFigures(u), year, (m) => console.error(m));
}

const VZEILE_W = 8;
const VBETRAG_W = 16;

/**
 * `--vordruck`: annotate every emitted figure with the amtliche Vordruckzeile of the annual
 * USt-Jahreserklärung form, so the Prüfblatt can be hand-entered into Mein ELSTER. DISPLAY-ONLY —
 * driven purely by the extracted ERiC line table ({@link buildUsteVordruckRows}); changes no figure.
 */
export function printUsteVordruck(u: UsteAggregate, year: number): void {
    const rows = usteVordruckRows(u, year);
    const width = VZEILE_W + VBETRAG_W + 60;
    console.log(`\nVordruckzeilen-Zuordnung — USt-Jahreserklärung ${year} (Mein ELSTER)`);
    console.log('Quelle: lokale ERiC-Jahresdokumentation (amtliche Vordruckzeilen) — nur Anzeige, ändert keine Zahl.');
    console.log('='.repeat(width));
    console.log(`  ${'Zeile'.padEnd(VZEILE_W)}${'Betrag'.padStart(VBETRAG_W)}  Feld`);
    for (const r of rows) {
        const betrag = r.art === 'bmg' ? `${eurInt(r.betrag)} €` : `${fmt(r.betrag)} €`;
        const zeile = `Z${r.zeile}`.padEnd(VZEILE_W);
        const suffix = r.art === 'bmg' ? ' (BMG)' : '';
        console.log(`  ${zeile}${betrag.padStart(VBETRAG_W)}  ${r.label}${suffix}`);
    }
    console.log('');
}

/**
 * `--vordruck`: the "stille Anpassungen" section — Privatanteile / Betriebsaufgabe-Entnahme /
 * Sonderbetriebsausgaben with the form line each drives and its §-Grund. ADVISORY: these amounts are
 * already inside the computed figures above; this only says WHAT to type WHERE. See {@link usteAnpassungen}.
 */
export function printUsteAnpassungen(anpassungen: UsteAnpassung[]): void {
    if (anpassungen.length === 0) return;
    console.log('Stille Anpassungen (nicht aus Bankbewegungen ableitbar) — was wohin einzutragen ist');
    console.log('Diese Werte stecken bereits in den obigen Zahlen, tauchen sonst aber in keinem Report auf.');
    console.log('-'.repeat(VZEILE_W + VBETRAG_W + 60));
    for (const a of anpassungen) {
        const betrag = `${eurInt(a.betrag)} €`;
        console.log(`  ${a.bezeichnung.padEnd(34)}${betrag.padStart(12)}  → ${a.ziel}`);
        const effekt = a.ustWirksam ? 'in der USt enthalten' : 'kein USt-Effekt';
        console.log(`  ${' '.repeat(34)}${' '.repeat(12)}    ${a.rechtsgrund}  [${effekt}]`);
    }
    console.log('');
}

export type { UsteFormFigures };
export type { UsteAnpassung, UsteVordruckRow };
