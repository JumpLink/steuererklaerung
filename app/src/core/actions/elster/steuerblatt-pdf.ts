/**
 * Build a {@link SteuerblattModel} (tax-return review datasheet) from the computed reports and
 * render it to a PDF. This is the "look at it before we transmit" companion to the ERiC XML: the
 * same figures that go into the XML, laid out human-readably. One builder per return; the render +
 * write is shared. GJS-only rendering (cairo/Pango) — the CLI/app run on GJS; on Node it throws.
 */

import { writeFileSync } from 'node:fs';
import {
    pdfRenderingAvailable,
    renderSteuerblattPdf,
    type SteuerblattModel,
    type SteuerblattRow,
    type SteuerblattSection,
} from '@steuererklaerung/invoice-pdf';
import { fmtDe as fmt } from '../../lib/money.ts';
import type { ElsterConfig } from '../../config/index.ts';
import type { FeststellungReport } from './feststellung.ts';
import type { GewstReport } from './gewst.ts';
import { computeUsteFormFigures, type UsteAggregate, type UsteFormLine } from '../../elster/uste-aggregate.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';
import type { UstvaAggregate } from '../../elster/ustva-aggregate.ts';
import { hasReverseCharge } from '../../elster/reverse-charge.ts';
import { buildEuerKennzahlen } from './euer.ts';
import type { EstReport } from './est.ts';
import type { EstConfig } from '../../config/index.ts';

const eur = (n: number): string => `${fmt(n)} €`;
/** Integer-euro amount, de-DE grouped (Bemessungsgrundlagen are stated in full euros). */
const eurInt = (n: number): string => `${Math.trunc(n).toLocaleString('de-DE')} €`;

/** Einkommensteuererklärung (E10) → Prüf-Datenblatt: the waterfall Einkünfte → GdE → zvE →
 *  festzusetzende ESt → Erstattung, human-readable as in the form. Schätzung (Anrechnung = einbehaltene LSt). */
export function estToSteuerblatt(report: EstReport, config: EstConfig): SteuerblattModel {
    const r = report.result;
    const p = config.person;
    const name = `${p.vorname ?? ''} ${p.nachname ?? p.name ?? ''}`.trim() || config.entity_id;
    const einkuenfte: SteuerblattRow[] = [
        { label: 'Bruttoarbeitslohn', value: eur(r.bruttoarbeitslohn) },
        { label: '− Werbungskosten (angesetzt)', value: eur(r.werbungskosten.angesetzt) },
        { label: '= Einkünfte aus nichtselbständiger Arbeit (§19)', value: eur(r.einkuenfte19), emphasis: true },
    ];
    if (r.einkuenfteGewerbe !== 0)
        einkuenfte.push({ label: '+ Einkünfte aus Gewerbebetrieb (§15)', value: eur(r.einkuenfteGewerbe) });
    if (r.entlastungAlleinerziehende > 0)
        einkuenfte.push({
            label: '− Entlastungsbetrag für Alleinerziehende (§24b)',
            value: eur(r.entlastungAlleinerziehende),
        });
    einkuenfte.push({ label: '= Gesamtbetrag der Einkünfte', value: eur(r.gesamtbetragEinkuenfte), emphasis: true });

    const sonder: SteuerblattRow[] = [{ label: 'Vorsorgeaufwendungen (abziehbar)', value: eur(r.vorsorge.abziehbar) }];
    if (r.sonderausgaben.kirchensteuer > 0)
        sonder.push({ label: 'Gezahlte Kirchensteuer (§10 Abs. 1 Nr. 4)', value: eur(r.sonderausgaben.kirchensteuer) });
    if (r.sonderausgaben.spenden > 0) sonder.push({ label: 'Spenden (§10b)', value: eur(r.sonderausgaben.spenden) });
    if (r.sonderausgaben.schulgeld > 0)
        sonder.push({ label: 'Schulgeld (§10 Abs. 1 Nr. 9)', value: eur(r.sonderausgaben.schulgeld) });
    if (r.sonderausgaben.kinderbetreuung > 0)
        sonder.push({
            label: 'Kinderbetreuungskosten (§10 Abs. 1 Nr. 5)',
            value: eur(r.sonderausgaben.kinderbetreuung),
        });
    sonder.push({ label: '= Sonderausgaben gesamt', value: eur(r.sonderausgaben.gesamt), emphasis: true });
    if (r.agb.abziehbar > 0)
        sonder.push({ label: 'Außergewöhnliche Belastungen (§33, abziehbar)', value: eur(r.agb.abziehbar) });

    const steuer: SteuerblattRow[] = [{ label: 'Zu versteuerndes Einkommen', value: eur(r.zvE), emphasis: true }];
    if (r.progressionseinkuenfte !== 0)
        steuer.push({
            label: `Progressionsvorbehalt §32b (${r.progressionseinkuenfte < 0 ? 'Rückzahlung' : 'Leistungen'})`,
            value: eur(r.progressionseinkuenfte),
        });
    steuer.push({ label: 'Tarifliche Einkommensteuer (§32a)', value: eur(r.tariflicheESt) });
    if (r.ermaessigung34g.angesetzt > 0)
        steuer.push({ label: '− Steuerermäßigung §34g (Parteizuwendungen)', value: eur(r.ermaessigung34g.angesetzt) });
    if (r.ermaessigung35a.angesetzt > 0)
        steuer.push({ label: '− Steuerermäßigung §35a', value: eur(r.ermaessigung35a.angesetzt) });
    steuer.push({ label: '= Festzusetzende Einkommensteuer', value: eur(r.festzusetzendeESt), emphasis: true });

    const abrechnung: SteuerblattRow[] = [
        { label: '− Einbehaltene Lohnsteuer', value: eur(r.abrechnung.est.einbehalten) },
        {
            label: r.erstattung >= 0 ? '= Voraussichtliche Erstattung' : '= Voraussichtliche Nachzahlung',
            value: eur(Math.abs(r.erstattung)),
            emphasis: true,
        },
    ];

    const warnings: string[] = [
        'Schätzung — verbindlich ist allein der Steuerbescheid. Werte vor der Abgabe in Mein ELSTER gegenlesen.',
    ];
    if (r.entlastungAlleinerziehende > 0)
        warnings.push(
            '§24b: die anteilige Monatszahl ermittelt das Finanzamt aus der Haushaltslage — hier konservativ nach `monate` geschätzt.',
        );

    const sections: SteuerblattSection[] = [
        { heading: 'Einkünfte', rows: einkuenfte },
        { heading: 'Sonderausgaben & außergewöhnliche Belastungen', rows: sonder },
        { heading: 'Steuerberechnung', rows: steuer },
        { heading: 'Anrechnung & Ergebnis', rows: abrechnung },
    ];
    return {
        title: `Einkommensteuererklärung ${report.year} — Prüf-Datenblatt`,
        subtitle: `${r.veranlagung === 'splitting' ? 'Zusammenveranlagung' : 'Einzelveranlagung'} · Schätzung`,
        meta: [
            { label: 'Steuerpflichtiger', value: name },
            { label: 'Steuernummer', value: p.steuernummer ?? '—' },
            { label: 'Finanzamt', value: p.finanzamt ?? '—' },
            { label: 'Veranlagungszeitraum', value: String(report.year) },
        ],
        sections,
        warnings,
        note: 'Schätzung der Einkommensteuer — verbindlich ist allein der Steuerbescheid. Vor der Abgabe die Werte in Mein ELSTER gegenlesen.',
    };
}

/** Feststellung (gesonderte u. einheitliche Feststellung) → review datasheet. */
export function feststellungToSteuerblatt(report: FeststellungReport, elster: ElsterConfig): SteuerblattModel {
    const { result, euer } = report;
    const hasSbv = result.allocations.some((a) => a.sonderbetriebsausgaben !== 0);
    const hasAufgabe = result.aufgabegewinn !== 0;

    const gesamthand: SteuerblattRow[] = [{ label: 'Laufender Gewinn lt. EÜR', value: eur(result.totalProfit) }];
    if (hasSbv) {
        const sbvSum = result.allocations.reduce((s, a) => s + a.sonderbetriebsausgaben, 0);
        gesamthand.push({ label: '− Sonderbetriebsausgaben', value: eur(sbvSum) });
        gesamthand.push({
            label: '= Festgestellte laufende Einkünfte',
            value: eur(result.festgestellteEinkuenfte),
            emphasis: !hasAufgabe,
        });
    }
    if (hasAufgabe) {
        gesamthand.push({
            label: result.aufgabegewinn < 0 ? '+ Aufgabeverlust (§16/§34)' : '+ Aufgabegewinn (§16/§34)',
            value: eur(result.aufgabegewinn),
        });
        gesamthand.push({
            label: '= Einkünfte aus Gewerbebetrieb',
            value: eur(result.einkuenfteGesamt),
            emphasis: true,
        });
    }

    const verteilung: SteuerblattRow[] = result.allocations.map((a) => ({
        label: `${a.gesellschafter.name} (${(a.gesellschafter.quote * 100).toFixed(2)} %)`,
        value: eur(a.gesamtAnteil),
    }));

    const kennzahlen: SteuerblattRow[] = buildEuerKennzahlen({
        income: euer.income,
        expenses: euer.expenses,
        totals: euer.totals,
    }).map((k) => ({ label: `Kz ${k.kz}  ${k.label}`, value: eur(k.amount) }));

    const sections: SteuerblattSection[] = [
        { heading: 'Gesamthand (Einkünfte aus Gewerbebetrieb)', rows: gesamthand },
        { heading: 'Anlage FE — Verteilung auf die Beteiligten', rows: verteilung },
        { heading: 'Anlage EÜR — Kennzahlen', rows: kennzahlen },
    ];
    if (hasAufgabe && report.aufgabe) {
        sections.push({
            heading: `Betriebsaufgabe ${report.aufgabe.datum} — Entnahme Anlagevermögen (gW ./. RBW)`,
            rows: report.aufgabe.assets.map((a) => ({
                label: `${a.bezeichnung}  (gW ${fmt(a.gemeinerWert)} − RBW ${fmt(a.restbuchwert)})`,
                value: eur(a.gewinn),
                indent: 1,
            })),
        });
    }

    const warnings: string[] = [];
    if (euer.coverage.unclassified.length > 0) {
        warnings.push(`${euer.coverage.unclassified.length} unklassifizierte Buchung(en) — vor Abgabe klären.`);
    }
    if (hasAufgabe) warnings.push('Gemeine Werte der Betriebsaufgabe sind eine Schätzung — bitte prüfen.');

    return {
        title: `Feststellungserklärung ${result.year} — Prüf-Datenblatt`,
        subtitle: 'Gesonderte u. einheitliche Feststellung (GbR)',
        meta: [
            { label: 'Gesellschaft', value: elster.betrieb?.name ?? elster.tax_number },
            { label: 'Steuernummer', value: elster.tax_number },
            { label: 'Veranlagungszeitraum', value: String(result.year) },
        ],
        sections,
        warnings,
        note: 'Vorschau der Werte für die FEIN-90-XML. Kz-Beschriftung gegen die ELSTER-Formularzeilen prüfen und vor der Übermittlung in Mein ELSTER gegenlesen.',
    };
}

/**
 * USt-Jahreserklärung → review datasheet. The tax on each line is derived from the Bemessungsgrundlage
 * ROUNDED DOWN to full euro (in the row label), exactly as the annual form + Übertragungsprotokoll show
 * it — see {@link computeUsteFormFigures}. The §13b tax per line (which ELSTER does not auto-compute) is
 * surfaced explicitly, and the Vorauszahlungssoll is flagged as the register value, not the FA's Soll.
 */
export function usteToSteuerblatt(u: UsteAggregate, elster: ElsterConfig): SteuerblattModel {
    const f = computeUsteFormFigures(u);
    const rows: SteuerblattRow[] = [];
    const lineRow = (l: UsteFormLine, label: string, emphasis = false) =>
        rows.push({ label: `${label} · BMG ${eurInt(l.bmg)}`, value: eur(l.tax), emphasis });

    lineRow(f.lieferungen19, 'Z22 Lieferungen/sonst. Leistungen 19 %');
    if (f.wertabgabeLieferung19) {
        lineRow(f.wertabgabeLieferung19, 'Z23 unentgeltl. Wertabgabe §3 Abs. 1b 19 %');
        for (const a of u.entnahmeAssets ?? [])
            rows.push({ label: `${a.bezeichnung} (gemeiner Wert)`, value: eurInt(a.gemeinerWert), indent: 1 });
    }
    if (f.wertabgabeSonstige19) lineRow(f.wertabgabeSonstige19, 'Z24 unentgeltl. Wertabgabe §3 Abs. 9a 19 %');
    if (f.ermaessigt7) lineRow(f.ermaessigt7, 'Umsätze zum ermäßigten Steuersatz 7 %');
    rows.push({ label: 'Z37 Summe der Steuer', value: eur(f.steuerUmsaetze), emphasis: true });
    if (u.net_0 !== 0) rows.push({ label: 'Steuerfreie / §13b-Umsätze (nachrichtlich)', value: eurInt(u.net_0) });

    // §13b Steuerschuldnerschaft des Leistungsempfängers (neutral for the Zahllast: owed = Vorsteuer).
    // ELSTER does NOT compute that tax — enter it yourself from the rounded-down BMG.
    if (f.reverseChargeAbs1 || f.reverseChargeAbs2) {
        if (f.reverseChargeAbs1) lineRow(f.reverseChargeAbs1, 'Z65 §13b Abs. 1 EU-Leistungen 19 %');
        if (f.reverseChargeAbs2) lineRow(f.reverseChargeAbs2, 'Z67 §13b Abs. 2 Drittland 19 %');
        rows.push({ label: 'Z68 Summe §13b-Steuer (selbst eintragen)', value: eur(f.steuer13b), indent: 1 });
    }

    rows.push({ label: 'Z79 Vorsteuer aus Rechnungen', value: eur(f.vorsteuer) });
    if (f.vorsteuer13b) rows.push({ label: 'Z83 Vorsteuer aus §13b (zahllastneutral)', value: eur(f.vorsteuer13b) });
    rows.push({ label: 'Z87 Summe Vorsteuer', value: eur(f.vorsteuerSumme) });

    rows.push({ label: 'Z118 Verbleibende USt (Jahres-Zahllast)', value: eur(f.verbleibend), emphasis: true });
    const quelle = f.prepaidVatSource === 'config' ? 'aus Config' : 'aus Filing-Register';
    rows.push({ label: `Z119 − Vorauszahlungssoll (${quelle}, nicht amtl. Soll)`, value: eur(f.vorauszahlungssoll) });
    rows.push({
        label: f.abschluss >= 0 ? 'Z120 = Abschlusszahlung' : 'Z120 = Erstattung',
        value: eur(Math.abs(f.abschluss)),
        emphasis: true,
    });

    const warnings: string[] = [
        'Vorauszahlungssoll (Z119) aus unserem Filing-Register — nicht das amtliche Soll des Finanzamts; gegen das ELSTER-Steuerkonto abgleichen.',
    ];
    if (u.reverseChargeReview && u.reverseChargeReview.length > 0) {
        warnings.push(
            `${u.reverseChargeReview.length} Auslandsbeleg(e) mit unklarer §13b-Einordnung — vor Abgabe prüfen.`,
        );
    }

    return {
        title: `Umsatzsteuer-Jahreserklärung ${u.year} — Prüf-Datenblatt`,
        subtitle: `${elster.taxation_basis === 'ist' ? 'Ist-Versteuerung (§20 UStG)' : 'Soll-Versteuerung'}`,
        meta: [
            { label: 'Unternehmen', value: elster.betrieb?.name ?? elster.tax_number },
            { label: 'Steuernummer', value: elster.tax_number },
            { label: 'Veranlagungszeitraum', value: String(u.year) },
        ],
        sections: [{ heading: 'Umsatzsteuer (Werte wie im Formular: BMG auf volle Euro abgerundet)', rows }],
        warnings,
        note: 'Vorschau der Formularwerte. Die §13b-Steuer (Z65/67/68) berechnet ELSTER nicht selbst — aus der abgerundeten BMG eintragen. Vor der Übermittlung in Mein ELSTER gegenlesen.',
    };
}

/** Anlage EÜR (transaction-driven) → review datasheet. */
export function euerToSteuerblatt(agg: EuerTxAggregate, elster: ElsterConfig): SteuerblattModel {
    const einnahmen: SteuerblattRow[] = agg.income.map((c) => ({ label: c.category, value: eur(c.net) }));
    einnahmen.push({ label: 'Summe Einnahmen netto', value: eur(agg.totals.incomeNet), emphasis: true });

    const ausgaben: SteuerblattRow[] = agg.expenses.map((c) => ({ label: c.category, value: eur(c.net) }));
    ausgaben.push({ label: 'Summe Ausgaben netto', value: eur(agg.totals.expenseNet), emphasis: true });

    const ergebnis: SteuerblattRow[] = [
        { label: 'Gewinn (Einnahmen − Ausgaben)', value: eur(agg.totals.profit), emphasis: true },
        { label: 'USt-Zahllast (USt − Vorsteuer)', value: eur(agg.totals.vatPayable) },
    ];

    const kennzahlen: SteuerblattRow[] = buildEuerKennzahlen({
        income: agg.income,
        expenses: agg.expenses,
        totals: agg.totals,
    }).map((k) => ({ label: `Kz ${k.kz}  ${k.label}`, value: eur(k.amount) }));

    const sections: SteuerblattSection[] = [
        { heading: 'Betriebseinnahmen (netto)', rows: einnahmen },
        { heading: 'Betriebsausgaben (netto)', rows: ausgaben },
        { heading: 'Ergebnis', rows: ergebnis },
    ];
    if (agg.neutral.length > 0) {
        sections.push({
            heading: 'Neutral (nicht GuV-wirksam — intern/privat/Steuer)',
            rows: agg.neutral.map((c) => ({ label: c.category, value: eur(c.gross), indent: 1 })),
        });
    }
    sections.push({ heading: 'Anlage-EÜR Kennzahlen (zum Eintragen in Mein ELSTER)', rows: kennzahlen });

    const warnings: string[] = [];
    if (agg.coverage.unclassified.length > 0) {
        warnings.push(
            `${agg.coverage.unclassified.length} unklassifizierte Buchung(en) — nicht in der EÜR enthalten, vor Abgabe klären.`,
        );
    }

    return {
        title: `Anlage EÜR ${agg.year} — Prüf-Datenblatt`,
        subtitle: 'Einnahmen-Überschuss-Rechnung (§4 Abs. 3 EStG) — transaktionsgetrieben',
        meta: [
            { label: 'Unternehmen', value: elster.betrieb?.name ?? elster.tax_number },
            { label: 'Steuernummer', value: elster.tax_number },
            { label: 'Veranlagungszeitraum', value: String(agg.year) },
        ],
        sections,
        warnings,
        note: 'Die Kz-Zuordnung ist Best-Effort — gegen die amtliche Anlage-EÜR-Datensatzbeschreibung prüfen und vor der Übermittlung in Mein ELSTER gegenlesen.',
    };
}

/** Gewerbesteuer (GewSt 1 A) — Messbetragsermittlung → review datasheet. */
export function gewstToSteuerblatt(report: GewstReport, elster: ElsterConfig, year: number): SteuerblattModel {
    const r = report.result;
    const g = elster.gewerbe;
    // Reconstruct the input Gewinn (before §8/§9) exactly as printGewstReport does.
    const gewinn = r.gewerbeertrag - r.sumHinzurechnungen + r.sumKuerzungen;

    const rows: SteuerblattRow[] = [
        { label: 'Gewinn aus Gewerbebetrieb (EÜR)', value: eur(gewinn) },
        { label: '+ Hinzurechnungen (§8)', value: eur(r.sumHinzurechnungen) },
        { label: '− Kürzungen (§9)', value: eur(r.sumKuerzungen) },
        { label: '= Gewerbeertrag', value: eur(r.gewerbeertrag) },
        { label: 'Gewerbeertrag (abgerundet, §11)', value: eur(r.gewerbeertragRounded) },
        { label: '− Freibetrag (§11 Abs. 1 Nr. 1)', value: eur(r.freibetrag) },
        { label: '= Bemessungsgrundlage', value: eur(r.bemessungsgrundlage), emphasis: true },
        { label: `× Steuermesszahl ${(r.steuermesszahl * 100).toFixed(1).replace('.', ',')} %`, value: '' },
        { label: '= Steuermessbetrag', value: eur(r.messbetrag), emphasis: true },
        { label: `Gewerbesteuer (× Hebesatz ${g?.hebesatz ?? '—'} %)`, value: eur(r.gewerbesteuer) },
    ];

    const warnings: string[] = [];
    if (report.euer.coverage.unclassified.length > 0) {
        warnings.push(
            `${report.euer.coverage.unclassified.length} unklassifizierte Buchung(en) in der EÜR — Gewerbeertrag vor Abgabe prüfen.`,
        );
    }
    if (r.messbetrag === 0) {
        warnings.push('Messbetrag 0 € (Gewinn unter dem Freibetrag) — die Erklärung wird dennoch abgegeben.');
    }

    return {
        title: `Gewerbesteuer ${year} — Prüf-Datenblatt`,
        subtitle: 'Messbetragsermittlung (GewSt 1 A) aus dem EÜR-Gewinn',
        meta: [
            { label: 'Unternehmen', value: elster.betrieb?.name ?? elster.tax_number },
            { label: 'Steuernummer', value: elster.tax_number },
            { label: 'Gemeinde', value: g?.gemeinde ?? '—' },
            { label: 'Veranlagungszeitraum', value: String(year) },
        ],
        sections: [{ heading: 'Messbetragsermittlung', rows }],
        warnings,
        note: 'Werte aus der transaktionsgetriebenen EÜR (abzgl. Sonderbetriebsausgaben + §24-nachträglicher Posten). Hinzurechnungen/Kürzungen stammen aus der Config — vor der Übermittlung in Mein ELSTER gegenlesen.',
    };
}

const MONTHS_DE = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
];

/** Human-readable USt-VA period, e.g. "Q2 2025", "März 2025" or "2025". */
function ustvaPeriodLabel(period: ElsterConfig['period']): string {
    if (period.month != null) return `${MONTHS_DE[period.month - 1] ?? String(period.month)} ${period.year}`;
    if (period.quarter != null) return `Q${period.quarter} ${period.year}`;
    return String(period.year);
}

/**
 * USt-Voranmeldung → review datasheet. Mirrors the Kennzahlen the XML emits
 * ({@link buildUstvaXml}): Kz81/86 (net), Kz66 (Vorsteuer), Kz83 (Zahllast = 19 %·net_19 +
 * 7 %·net_7 − Vorsteuer), so the sheet reconciles to the transmitted XML by construction.
 */
export function ustvaToSteuerblatt(
    aggregate: UstvaAggregate,
    config: ElsterConfig,
    opts: { missingBmfRates?: Array<{ id: number; currency: string; month: string }> } = {},
): SteuerblattModel {
    const vat19 = Math.round(aggregate.net_19 * 19) / 100;
    const vat7 = Math.round(aggregate.net_7 * 7) / 100;
    const kz83 = vat19 + vat7 - aggregate.vat_in;

    const rows: SteuerblattRow[] = [
        { label: 'Steuerpflichtige Umsätze 19 % (Kz 81)', value: eur(aggregate.net_19) },
        { label: 'Steuerpflichtige Umsätze 7 % (Kz 86)', value: eur(aggregate.net_7) },
        { label: 'Vereinnahmte Umsatzsteuer', value: eur(aggregate.vat_out) },
        { label: 'Abziehbare Vorsteuer (Kz 66)', value: eur(aggregate.vat_in) },
    ];

    // §13b Steuerschuldnerschaft des Leistungsempfängers (neutral for the Zahllast: Kz 47/85 = Kz 67).
    const rc = aggregate.reverseCharge;
    if (rc && hasReverseCharge(rc)) {
        if (rc.abs1Base !== 0) {
            rows.push({ label: '§13b Abs. 1 EU-Leistungen — Basis (Kz 46)', value: eur(rc.abs1Base) });
            rows.push({ label: '§13b Abs. 1 — Steuer (Kz 47)', value: eur(rc.abs1Tax), indent: 1 });
        }
        if (rc.abs2Base !== 0) {
            rows.push({ label: '§13b Abs. 2 Drittland — Basis (Kz 84)', value: eur(rc.abs2Base) });
            rows.push({ label: '§13b Abs. 2 — Steuer (Kz 85)', value: eur(rc.abs2Tax), indent: 1 });
        }
        rows.push({ label: '+ Vorsteuer aus §13b (Kz 67)', value: eur(rc.deductibleVat), indent: 1 });
    }

    rows.push({
        label: kz83 >= 0 ? '= Verbleibende USt-Vorauszahlung (Kz 83)' : '= Verbleibender Überschuss (Kz 83)',
        value: eur(Math.abs(kz83)),
        emphasis: true,
    });

    const warnings: string[] = [];
    if (opts.missingBmfRates && opts.missingBmfRates.length > 0) {
        warnings.push(
            `${opts.missingBmfRates.length} Fremdwährungsbeleg(e) ohne BMF-Umrechnungskurs — nicht enthalten, vor Abgabe ergänzen.`,
        );
    }
    if (aggregate.reverseChargeReview && aggregate.reverseChargeReview.length > 0) {
        warnings.push(
            `${aggregate.reverseChargeReview.length} Auslandsbeleg(e) mit unklarer §13b-Einordnung — vor Abgabe prüfen.`,
        );
    }

    return {
        title: `Umsatzsteuer-Voranmeldung ${ustvaPeriodLabel(config.period)} — Prüf-Datenblatt`,
        subtitle: config.taxation_basis === 'ist' ? 'Ist-Versteuerung (§20 UStG)' : 'Soll-Versteuerung',
        meta: [
            { label: 'Unternehmen', value: config.betrieb?.name ?? config.tax_number },
            { label: 'Steuernummer', value: config.tax_number },
            { label: 'Zeitraum', value: ustvaPeriodLabel(config.period) },
        ],
        sections: [{ heading: 'Umsatzsteuer-Voranmeldung', rows }],
        warnings,
        note: `Vorschau der Werte für die USt-VA-XML (Kz 81/86/66/83) — ${aggregate.outgoing_count} Ausgangs-, ${aggregate.incoming_count} Eingangsrechnung(en). Vor der Übermittlung in Mein ELSTER gegenlesen.`,
    };
}

/** Render a datasheet model to a PDF file (GJS runtime only). Returns the written path. */
export async function writeSteuerblattPdf(model: SteuerblattModel, outputPath: string): Promise<string> {
    if (!pdfRenderingAvailable()) {
        throw new Error(
            'PDF-Export benötigt die GJS-Laufzeit (Cairo/Pango) — nutze den GJS-Build (steuer web / app / CLI).',
        );
    }
    const bytes = await renderSteuerblattPdf(model);
    writeFileSync(outputPath, bytes);
    return outputPath;
}
