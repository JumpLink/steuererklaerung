/**
 * Steuererklärungs-Assistent — the shared core behind the "wizard" that walks a tax year from
 * completeness to a final, ERiC-checked summary ready for the Mein-ELSTER upload.
 *
 * This is the SINGLE source both front-ends render (native GNOME app + web): a {@link TaxReturnPlan}
 * = ordered steps (each with a status + human-readable headline/details) plus one preview per annual
 * form (EÜR, USt-Jahr, GewSt, Feststellung), all derived from ONE transaction-driven EÜR aggregate.
 *
 * The pure {@link assembleTaxReturnPlan} builds the plan from already-computed reports (unit-testable,
 * no I/O); {@link buildTaxReturnPlan} is the thin wrapper that fetches the aggregate once and threads
 * it into the per-form reports. Read-only — nothing is transmitted here; the last step exports the
 * ERiC-valid XML for the manual Mein-ELSTER upload.
 */

import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import { fmtDe as fmt } from '../../lib/money.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';
import type { UsteAggregate } from '../../elster/uste-aggregate.ts';
import { euerReportByTransactions } from './euer.ts';
import { usteReport } from './uste.ts';
import { gewstReport, type GewstReport } from './gewst.ts';
import { feststellungReport, type FeststellungReport } from './feststellung.ts';
import {
    estReport,
    estThemeCards,
    estWaterfall,
    type EstReport,
    type EstThemeCard,
    type EstWaterfallRow,
} from './est.ts';
import type { EstConfig } from '../../config/index.ts';
import { estYearAvailable } from '../../elster/est-tarif.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

/** ok = done/green · warn = needs a human decision · blocked = must fix before filing · info = FYI. */
export type StepStatus = 'ok' | 'warn' | 'blocked' | 'info';

/**
 * A deep-link from a wizard step to the app view where its open item is resolved (unclassified
 * bookings → Buchungen, a missing ELSTER/ESt config → Einstellungen). `view` is the shared nav id
 * both front-ends navigate by (native window.ts `win.navigate` action · web `bh-navigate` event), so
 * the SAME plan drives a working "hier beheben" button in the app AND the web.
 */
export interface WizardStepAction {
    /** Button label, e.g. "Buchungen öffnen". */
    label: string;
    /** Target nav view id — shared by app + web: 'transactions' | 'settings' | 'review' | … */
    view: string;
}

/** One wizard step: a status plus a one-line headline and optional detail bullets. */
export interface WizardStep {
    id: 'vollstaendigkeit' | 'anpassungen' | 'formulare' | 'pruefung' | 'zusammenfassung';
    title: string;
    /** Short label for a compact tab/pill switcher (falls back to `title` when absent). */
    tab?: string;
    status: StepStatus;
    headline: string;
    details: string[];
    /** Optional "hier beheben" deep-links to the relevant app view (absent = nothing to jump to). */
    actions?: WizardStepAction[];
}

/** A per-form preview card: the key figures + whether its ERiC XML can be exported now. */
export interface WizardFormPreview {
    form: 'euer' | 'uste' | 'gewst' | 'feststellung' | 'est';
    title: string;
    figures: Array<{ label: string; value: string }>;
    /** The ERiC EDS XML can be built now (business identity present). */
    canExport: boolean;
    /** Why it can't be exported yet, when canExport is false. */
    blockedReason?: string;
}

/** One figure in the result summary's mini-table (amount kept numeric so both front-ends format it). */
export interface TaxReturnSummaryLine {
    label: string;
    amount: number;
}

/**
 * The monetary result hero the design puts at the top of the Steuererklärung (design 01–03): a big
 * headline number — the expected payment (amber) or refund (green) — plus a right-aligned mini-table
 * of the key figures. Kept as raw numbers so the app AND the web render the SAME value (the form
 * previews only carry pre-formatted strings, which must not be re-parsed).
 */
export interface TaxReturnSummary {
    /** Headline result: `payment` = owed (Nachzahlung, amber) · `refund` = back (Erstattung, green). `amount` = magnitude. */
    primary: { label: string; amount: number; kind: 'payment' | 'refund' };
    /** Context line under the primary (e.g. "USt-Abschluss 2025" / "Einkommensteuer 2025"). */
    context: string;
    /** Key figures as a mini-table (business: Gewinn/USt-Zahllast/GewSt · ESt: zvE/festzusetzende ESt). */
    secondary: TaxReturnSummaryLine[];
}

/** The full plan a front-end renders: ordered steps + form previews + overall readiness. */
export interface TaxReturnPlan {
    entityId: string;
    year: number;
    /** True when no step is `blocked` and every applicable form can export — safe to file. */
    ready: boolean;
    steps: WizardStep[];
    forms: WizardFormPreview[];
    /** The monetary result hero (design). Absent on a blocked plan (no meaningful figure yet). */
    summary?: TaxReturnSummary;
    /** Private-ESt extras (Steuer-Themen cards + Abzugs-Wasserfall). Present only for a `privat` plan. */
    est?: { waterfall: EstWaterfallRow[]; themes: EstThemeCard[] };
}

const eur = (n: number): string => `${fmt(n)} €`;

/** Inputs to the pure plan assembler — already-computed reports + config flags (no I/O). */
export interface TaxReturnPlanInputs {
    entityId: string;
    year: number;
    euer: EuerTxAggregate;
    uste: UsteAggregate;
    /** null when no `gewerbe` block (GewSt does not apply). */
    gewst: GewstReport | null;
    /** null when no `gesellschafter` (e.g. an Einzelunternehmen → no Feststellung). */
    feststellung: FeststellungReport | null;
    /** Business identity (betrieb) present → the EDS XML can be built/exported. */
    hasBetrieb: boolean;
    /** A Betriebsaufgabe with estimated gemeine Werte is configured → a human-judgment flag. */
    betriebsaufgabeSchaetzung: boolean;
}

/**
 * The monetary result hero for a business entity: the USt closing balance is the entity's own
 * headline (income tax is the partners'/owner's private matter), with the key figures beside it.
 */
function businessSummary(inp: TaxReturnPlanInputs): TaxReturnSummary {
    const bal = inp.uste.closingBalance; // ≥ 0 = Abschlusszahlung (owed) · < 0 = Erstattung (back)
    const secondary: TaxReturnSummaryLine[] = [
        { label: 'Gewinn (EÜR)', amount: inp.euer.totals.profit },
        { label: 'USt-Zahllast', amount: inp.euer.totals.vatPayable },
    ];
    if (inp.gewst) secondary.push({ label: 'GewSt-Messbetrag', amount: inp.gewst.result.messbetrag });
    if (inp.feststellung)
        secondary.push({ label: 'Festgestellte Einkünfte', amount: inp.feststellung.result.festgestellteEinkuenfte });
    return {
        primary: {
            label: bal >= 0 ? 'Voraussichtliche Nachzahlung' : 'Voraussichtliche Erstattung',
            amount: Math.abs(bal),
            kind: bal >= 0 ? 'payment' : 'refund',
        },
        context: `USt-Abschluss ${inp.year}`,
        secondary,
    };
}

/** The monetary result hero for the private ESt: the refund/payment + zvE + festzusetzende ESt. */
function estSummary(report: EstReport): TaxReturnSummary {
    const r = report.result;
    // r.erstattung: ≥ 0 = Erstattung (refund/green) · < 0 = Nachzahlung (payment/amber).
    return {
        primary: {
            label: r.erstattung >= 0 ? 'Voraussichtliche Erstattung' : 'Voraussichtliche Nachzahlung',
            amount: Math.abs(r.erstattung),
            kind: r.erstattung >= 0 ? 'refund' : 'payment',
        },
        context: `Einkommensteuer ${report.year}`,
        secondary: [
            { label: 'zu versteuerndes Einkommen', amount: r.zvE },
            { label: 'Festzusetzende ESt', amount: r.festzusetzendeESt },
        ],
    };
}

/** Build the form previews from the computed reports. */
function buildFormPreviews(inp: TaxReturnPlanInputs): WizardFormPreview[] {
    const blockedReason = inp.hasBetrieb ? undefined : 'Kein `betrieb`-Block in der ELSTER-Config.';
    const canExport = inp.hasBetrieb;
    const forms: WizardFormPreview[] = [];

    forms.push({
        form: 'euer',
        title: 'Anlage EÜR',
        canExport,
        blockedReason,
        figures: [
            { label: 'Gewinn (laufend)', value: eur(inp.euer.totals.profit) },
            { label: 'USt-Zahllast (Jahr)', value: eur(inp.euer.totals.vatPayable) },
        ],
    });

    const u = inp.uste;
    forms.push({
        form: 'uste',
        title: 'USt-Jahreserklärung',
        canExport,
        blockedReason,
        figures: [
            { label: 'Umsätze 19 %', value: eur(u.net_19) },
            { label: 'Vereinnahmte USt', value: eur(u.vat_out) },
            { label: 'Vorsteuer', value: eur(u.vat_in) },
            {
                label: u.closingBalance >= 0 ? 'Abschlusszahlung' : 'Erstattung',
                value: eur(Math.abs(u.closingBalance)),
            },
        ],
    });

    if (inp.gewst) {
        const r = inp.gewst.result;
        forms.push({
            form: 'gewst',
            title: 'Gewerbesteuer',
            canExport,
            blockedReason,
            figures: [
                { label: 'Gewerbeertrag', value: eur(r.gewerbeertrag) },
                { label: 'Steuermessbetrag', value: eur(r.messbetrag) },
            ],
        });
    }

    if (inp.feststellung) {
        const res = inp.feststellung.result;
        forms.push({
            form: 'feststellung',
            title: 'Feststellung (GbR)',
            canExport,
            blockedReason,
            // Names + Anteile only — never the partners' Steuer-IdNr.
            figures: [
                { label: 'Festgestellte Einkünfte', value: eur(res.festgestellteEinkuenfte) },
                { label: 'Einkünfte gesamt', value: eur(res.einkuenfteGesamt) },
                ...res.allocations.map((a) => ({ label: a.gesellschafter.name, value: eur(a.gesamtAnteil) })),
            ],
        });
    }

    return forms;
}

/**
 * Assemble the {@link TaxReturnPlan} from already-computed reports. Pure — no I/O — so the step
 * logic is unit-testable. The steps mirror the wizard: completeness → adjustments → form previews →
 * human review → final summary.
 */
export function assembleTaxReturnPlan(inp: TaxReturnPlanInputs): TaxReturnPlan {
    const steps: WizardStep[] = [];
    const forms = buildFormPreviews(inp);

    // 1 · Vollständigkeit: every booking classified + the year-end adjustments applied.
    const cov = inp.euer.coverage;
    if (!inp.euer.adjustmentsApplied) {
        steps.push({
            id: 'vollstaendigkeit',
            title: 'Vollständigkeit',
            tab: 'Vollständig',
            status: 'blocked',
            headline: 'Ohne Jahresabschluss-Anpassungen — ELSTER-Config fehlt.',
            details: ['Die Zahlen sind eine rohe Kassensicht (ohne AfA/§24/Privatanteil).'],
            actions: [{ label: 'Einstellungen öffnen', view: 'settings' }],
        });
    } else {
        const uncl = cov.unclassified.length;
        steps.push({
            id: 'vollstaendigkeit',
            title: 'Vollständigkeit',
            tab: 'Vollständig',
            status: uncl === 0 ? 'ok' : 'blocked',
            headline:
                uncl === 0
                    ? `Alle ${cov.transactions} Buchungen klassifiziert.`
                    : `${uncl} von ${cov.transactions} Buchungen unklassifiziert — vor Abgabe klären.`,
            details: [
                `via Beleg: ${cov.classifiedByDocument} · via Regel: ${cov.classifiedByRule}`,
                ...cov.unclassified
                    .slice(0, 5)
                    .map((u) => `unklar: ${u.bookingDate} ${fmt(u.amount)} € ${u.counterparty ?? ''}`.trim()),
            ],
            // Open bookings are fixed in the Buchungen view — deep-link straight there.
            actions: uncl === 0 ? undefined : [{ label: 'Buchungen öffnen', view: 'transactions' }],
        });
    }

    // 2 · Anpassungen: the non-cash year-end items that were folded in.
    const anp: string[] = [];
    const afa = inp.euer.expenses.find((c) => c.category.startsWith('4830'));
    if (afa) anp.push(`AfA: ${eur(afa.net)}`);
    const priv = inp.euer.income.find((c) => c.category.startsWith('8924'));
    if (priv) anp.push(`Privatanteil (unentgeltl. Wertabgabe): ${eur(priv.net)}`);
    if (inp.euer.totals.nachtraeglichNet !== 0)
        anp.push(`§24 nachträglich (netto): ${eur(inp.euer.totals.nachtraeglichNet)}`);
    if (inp.betriebsaufgabeSchaetzung) anp.push('Betriebsaufgabe: gemeine Werte konfiguriert (Schätzung — prüfen).');
    steps.push({
        id: 'anpassungen',
        title: 'Jahresabschluss-Anpassungen',
        tab: 'Anpassung',
        status: inp.betriebsaufgabeSchaetzung ? 'warn' : anp.length ? 'ok' : 'info',
        headline: anp.length ? `${anp.length} Anpassung(en) berücksichtigt.` : 'Keine Anpassungen konfiguriert.',
        details: anp.length ? anp : ['AfA/Privatanteil/§24/Betriebsaufgabe via `adjustments` in der ELSTER-Config.'],
    });

    // 3 · Formulare: previews + exportability.
    const exportable = forms.filter((f) => f.canExport).length;
    steps.push({
        id: 'formulare',
        title: 'Formular-Vorschauen',
        tab: 'Formulare',
        status: exportable === forms.length ? 'ok' : 'blocked',
        headline:
            exportable === forms.length
                ? `${forms.length} Formulare bereit (Prüf-PDF + ERiC-XML).`
                : `${forms.length - exportable} von ${forms.length} Formularen nicht exportierbar.`,
        details: forms.map(
            (f) => `${f.title}: ${f.figures[0]?.value ?? '—'}${f.canExport ? '' : ` (${f.blockedReason})`}`,
        ),
        // Not exportable = the `betrieb`-Block is missing → the Einstellungen (ELSTER config) is where it's added.
        actions: exportable === forms.length ? undefined : [{ label: 'Einstellungen öffnen', view: 'settings' }],
    });

    // 4 · Prüfung: the human-judgment items to confirm before filing.
    const checks: string[] = [];
    if (inp.betriebsaufgabeSchaetzung)
        checks.push('Gemeine Werte der Betriebsaufgabe bestätigen (§16/§34 — Schätzung).');
    checks.push('Klassifikation stichprobenartig prüfen (`elster euer report --detail`).');
    checks.push('Zahlen gegen Vorjahr / Steuerberater-Referenz abgleichen.');
    if (inp.gewst?.result.messbetrag === 0)
        checks.push('GewSt-Messbetrag 0 € (unter Freibetrag) — Erklärung wird dennoch abgegeben.');
    steps.push({
        id: 'pruefung',
        title: 'Gegenprüfung',
        tab: 'Prüfung',
        status: inp.betriebsaufgabeSchaetzung ? 'warn' : 'info',
        headline: `${checks.length} Punkt(e) vor Abgabe prüfen.`,
        details: checks,
    });

    // 5 · Zusammenfassung: the final numbers + readiness for the Mein-ELSTER upload.
    const blocked = steps.some((s) => s.status === 'blocked');
    const ready = !blocked && exportable === forms.length;
    const summary: string[] = [
        `Gewinn (laufend): ${eur(inp.euer.totals.profit)}`,
        `USt-Abschluss: ${eur(inp.uste.closingBalance)} (${inp.uste.closingBalance >= 0 ? 'Zahlung' : 'Erstattung'})`,
    ];
    if (inp.feststellung)
        summary.push(`Festgestellte Einkünfte: ${eur(inp.feststellung.result.festgestellteEinkuenfte)}`);
    if (inp.gewst) summary.push(`GewSt-Messbetrag: ${eur(inp.gewst.result.messbetrag)}`);
    summary.push(
        ready
            ? `${exportable} Formulare als ERiC-XML exportierbar → in Mein ELSTER hochladen.`
            : 'Noch nicht abgabebereit — offene Schritte oben.',
    );
    steps.push({
        id: 'zusammenfassung',
        title: 'Zusammenfassung & Abgabe',
        tab: 'Abgabe',
        status: ready ? 'ok' : 'blocked',
        headline: ready ? 'Abgabebereit — XML für Mein ELSTER exportieren.' : 'Noch nicht abgabebereit.',
        details: summary,
    });

    return { entityId: inp.entityId, year: inp.year, ready, steps, forms, summary: businessSummary(inp) };
}

/**
 * Build the plan for a year: compute the transaction-driven EÜR ONCE and thread it into the
 * per-form reports (uste/gewst/feststellung) so there is a single Paperless fetch and one derivation.
 */
export async function buildTaxReturnPlan(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    options: { accountKeys?: string[]; agg?: EuerTxAggregate } = {},
): Promise<TaxReturnPlan> {
    // Reuse a pre-computed EÜR aggregate when the caller has one (app/web cache) — one Paperless fetch.
    const euer =
        options.agg ?? (await euerReportByTransactions(syncConfig, year, { accountKeys: options.accountKeys, elster }));
    const uste = await usteReport(syncConfig, elster, year, { accountKeys: options.accountKeys, agg: euer });
    const gewst = elster.gewerbe
        ? await gewstReport(syncConfig, elster, year, { accountKeys: options.accountKeys, agg: euer })
        : null;
    const feststellung =
        elster.gesellschafter.length > 0
            ? await feststellungReport(syncConfig, elster, year, { accountKeys: options.accountKeys, agg: euer })
            : null;

    return assembleTaxReturnPlan({
        entityId: elster.entity_id,
        year,
        euer,
        uste,
        gewst,
        feststellung,
        hasBetrieb: !!elster.betrieb,
        betriebsaufgabeSchaetzung: !!elster.adjustments?.betriebsaufgabe,
    });
}

const STATUS_ICON: Record<StepStatus, string> = { ok: '✓', warn: '⚠', blocked: '✗', info: 'ℹ' };

/** Print the plan as a readable stepper (CLI headless view; the app/web render the same model). */
export function printTaxReturnPlan(plan: TaxReturnPlan): void {
    console.log(`\nSteuererklärungs-Assistent — ${plan.entityId} ${plan.year}`);
    console.log('='.repeat(64));
    plan.steps.forEach((s, i) => {
        console.log(`\n${i + 1}. ${STATUS_ICON[s.status]} ${s.title} — ${s.headline}`);
        for (const d of s.details) console.log(`     ${d}`);
    });
    console.log(
        `\n${plan.ready ? '✓ Abgabebereit' : '✗ Noch nicht abgabebereit'} · ${plan.forms.filter((f) => f.canExport).length}/${plan.forms.length} Formulare exportierbar\n`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Private Einkommensteuer (ESt) — the same TaxReturnPlan model for a `privat` entity.
// Reuses the five step ids (titles are free-form) so all three renderers work unchanged; only
// WizardFormPreview.form was widened with 'est'. Everything is a Schätzung, but the E10-XML export
// (buildEstEds) + the Prüfblatt (loadEstPdf) now exist → the ESt form is canExport:true.
// ─────────────────────────────────────────────────────────────────────────────

const signedEur = (n: number): string => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))} €`;

/**
 * Assemble a {@link TaxReturnPlan} from a computed {@link EstReport}. Pure — no I/O — so the step
 * logic is unit-testable. `ready` = no blocked step (the estimate is complete); the ELSTER export
 * (E10-XML + Prüfblatt) + Direktversand now exist, so the ESt form is canExport:true.
 */
export function assembleEstPlan(report: EstReport): TaxReturnPlan {
    const r = report.result;
    const steps: WizardStep[] = [];

    // 1 · Einkünfte & Lohnsteuerbescheinigung.
    const complete: string[] = [
        `Bruttoarbeitslohn: ${eur(r.bruttoarbeitslohn)} · einbehaltene LSt: ${eur(r.abrechnung.est.einbehalten)}`,
    ];
    if (r.einkuenfteGewerbe > 0) complete.push(`Einkünfte aus Gewerbebetrieb: ${eur(r.einkuenfteGewerbe)}`);
    if (report.gehaltPlausibilitaet) {
        const g = report.gehaltPlausibilitaet;
        complete.push(
            `Netto-Plausibilität: erkannt ${eur(g.gehaltNettoSumme)} vs. erwartet ${eur(g.netUngefaehr)} (${signedEur(g.gehaltNettoSumme - g.netUngefaehr)}, ${g.abweichungProzent} %)`,
        );
    }
    const unclassified = report.aggregate.coverage.unclassified.length;
    if (unclassified > 0)
        complete.push(`${unclassified} Buchung(en) unklassifiziert — als Thema einordnen oder ignorieren.`);
    const plausibilityOff =
        (report.gehaltPlausibilitaet?.abweichungProzent ?? 0) < -10 ||
        (report.gehaltPlausibilitaet?.abweichungProzent ?? 0) > 10;
    steps.push({
        id: 'vollstaendigkeit',
        title: 'Einkünfte & Lohnsteuerbescheinigung',
        tab: 'Einkünfte',
        status: !report.hasBescheinigung ? 'blocked' : plausibilityOff ? 'warn' : 'ok',
        headline: !report.hasBescheinigung
            ? `Keine Lohnsteuerbescheinigung für ${report.year} in der ESt-Config.`
            : `Bruttoarbeitslohn ${eur(r.bruttoarbeitslohn)} erfasst.`,
        details: report.hasBescheinigung
            ? complete
            : ['jahre[].bruttoarbeitslohn/lohnsteuer/soli/kirchensteuer in der est-config.json eintragen.'],
        // No Lohnsteuerbescheinigung → it's entered in the ESt config (Einstellungen); otherwise open
        // bookings to classify are fixed in the Buchungen view.
        actions: !report.hasBescheinigung
            ? [{ label: 'Einstellungen öffnen', view: 'settings' }]
            : unclassified > 0
              ? [{ label: 'Buchungen öffnen', view: 'transactions' }]
              : undefined,
    });

    // 2 · Abzüge (Werbungskosten, Vorsorge, Sonderausgaben, agB, §35a).
    const abz: string[] = [
        r.werbungskosten.pauschbetragGewonnen
            ? `Werbungskosten: Arbeitnehmer-Pauschbetrag ${eur(r.werbungskosten.pauschbetrag)} (höher als der Einzelnachweis).`
            : `Werbungskosten: Einzelnachweis ${eur(r.werbungskosten.angesetzt)} (über der Pauschale ${eur(r.werbungskosten.pauschbetrag)}).`,
        `Vorsorge abziehbar: ${eur(r.vorsorge.abziehbar)} (Altersvorsorge ${eur(r.vorsorge.altersvorsorgeAbziehbar)} + KV/PV/sonstige ${eur(r.vorsorge.sonstigeAbziehbar)}).`,
        `Sonderausgaben (KiSt/Spenden): ${eur(r.sonderausgaben.nichtVorsorgeAngesetzt)}.`,
    ];
    if (r.agb.krankheitskosten > 0) {
        abz.push(
            r.agb.abziehbar > 0
                ? `agB: ${eur(r.agb.abziehbar)} über der zumutbaren Belastung (${eur(r.agb.zumutbareBelastung)}).`
                : `agB: ${eur(r.agb.krankheitskosten)} vollständig von der zumutbaren Belastung (${eur(r.agb.zumutbareBelastung)}) aufgezehrt.`,
        );
    }
    const par35aOffen = report.aggregate.par35aOhneArbeitskosten;
    if (par35aOffen > 0) {
        abz.push(
            `§35a: ${par35aOffen} Handwerker-/DL-Buchung(en) ohne Arbeitskostenanteil — nur der Arbeitslohn (nicht Material) zählt; aus der Rechnung eintragen (Zahlung ist unbar ✓).`,
        );
    } else if (r.ermaessigung35a.berechnet > 0) {
        abz.push(
            `§35a-Ermäßigung: ${eur(r.ermaessigung35a.angesetzt)}${r.ermaessigung35a.verfallen > 0 ? ` (${eur(r.ermaessigung35a.verfallen)} verfallen)` : ''}.`,
        );
    }
    if (report.aggregate.vorsorgeKandidat > 0) {
        abz.push(
            `Versicherungs-Kandidaten aus Buchungen: ${eur(report.aggregate.vorsorgeKandidat)} — in Basis-KV/PV vs. sonstige sortieren (Config).`,
        );
    }
    steps.push({
        id: 'anpassungen',
        title: 'Abzüge',
        status: par35aOffen > 0 ? 'warn' : 'ok',
        headline: `Gesamtbetrag der Einkünfte ${eur(r.gesamtbetragEinkuenfte)} → zvE ${eur(r.zvE)}.`,
        details: abz,
    });

    // 3 · Formular-Vorschau (ESt 1 A + Anlage N) — E10-XML + Prüfblatt exportable (buildEstEds / loadEstPdf).
    const forms: WizardFormPreview[] = [
        {
            form: 'est',
            title: 'ESt 1 A + Anlage N (Schätzung)',
            canExport: true,
            figures: [
                { label: 'zu versteuerndes Einkommen', value: eur(r.zvE) },
                { label: 'tarifliche ESt', value: eur(r.tariflicheESt) },
                { label: 'Steuerermäßigung §35a', value: eur(r.ermaessigung35a.angesetzt) },
                { label: 'festzusetzende ESt', value: eur(r.festzusetzendeESt) },
                { label: r.erstattung >= 0 ? 'Erstattung' : 'Nachzahlung', value: signedEur(r.erstattung) },
            ],
        },
    ];
    steps.push({
        id: 'formulare',
        title: 'Formular-Vorschau',
        tab: 'Formulare',
        status: 'info',
        headline:
            'ESt 1 A + Anlage N (Schätzung) — Prüf-PDF + E10-XML exportierbar; Abgabe via ELSTER-Direktversand (Freigabe) oder Web-Formular.',
        details: forms[0].figures.map((f) => `${f.label}: ${f.value}`),
    });

    // 4 · Gegenprüfung (the Günstigerprüfungen the Finanzamt runs, the duty to keep receipts).
    steps.push({
        id: 'pruefung',
        title: 'Gegenprüfung',
        tab: 'Prüfung',
        status: 'info',
        headline: 'Punkte, die den Bescheid von der Schätzung abweichen lassen können.',
        details: [
            'Günstigerprüfungen macht das Finanzamt: Kindergeld/Kinderfreibetrag (§31), Kapitalerträge (§32d Abs. 6) + Sparer-Pauschbetrag, Vorsorge-Altregelung (§10 Abs. 4a).',
            '§35a: Rechnung + unbare Zahlung erforderlich (Bankzahlung erfüllt das) — Belege aufbewahren.',
            'Der Steuerbescheid ist verbindlich; diese Zahlen sind eine Schätzung.',
        ],
    });

    // 5 · Zusammenfassung.
    const blocked = steps.some((s) => s.status === 'blocked');
    const ready = !blocked;
    steps.push({
        id: 'zusammenfassung',
        title: 'Zusammenfassung',
        tab: 'Abgabe',
        status: ready ? 'ok' : 'blocked',
        headline: ready
            ? `Voraussichtliche ${r.erstattung >= 0 ? 'Erstattung' : 'Nachzahlung'}: ${signedEur(r.erstattung)}`
            : 'Noch unvollständig — Lohnsteuerbescheinigung fehlt.',
        details: [
            `festzusetzende ESt ${eur(r.festzusetzendeESt)} − einbehaltene LSt ${eur(r.abrechnung.est.einbehalten)} = ${signedEur(r.abrechnung.est.erstattung)}`,
            `Soli ${eur(r.abrechnung.soli.soll)} − einbehalten ${eur(r.abrechnung.soli.einbehalten)} = ${signedEur(r.abrechnung.soli.erstattung)}`,
            `KiSt ${eur(r.abrechnung.kirchensteuer.soll)} − einbehalten ${eur(r.abrechnung.kirchensteuer.einbehalten)} = ${signedEur(r.abrechnung.kirchensteuer.erstattung)}`,
        ],
    });

    return {
        entityId: report.entityId,
        year: report.year,
        ready,
        steps,
        forms,
        summary: estSummary(report),
        est: { waterfall: estWaterfall(r), themes: estThemeCards(report) },
    };
}

/**
 * Build the ESt plan for a `privat` entity's year. Pass pre-fetched `txs` (web/app startup cache) to
 * avoid a store read during serving; otherwise the entity's `accountKeys` are read for the year.
 */
export function buildEstPlan(
    estConfig: EstConfig,
    year: number,
    options: { accountKeys?: string[]; txs?: UnifiedTransaction[] } = {},
): TaxReturnPlan {
    // No §32a tariff/constants for the year → the estimate can't run (a Schätzung must not fabricate
    // a tariff). Return a blocked plan naming the reason instead of throwing, so the view stays usable.
    if (!estYearAvailable(year)) {
        return {
            entityId: estConfig.entity_id,
            year,
            ready: false,
            forms: [],
            steps: [
                {
                    id: 'vollstaendigkeit',
                    title: 'Einkommensteuer',
                    tab: 'Einkünfte',
                    status: 'blocked',
                    headline: `Kein Einkommensteuertarif für ${year} hinterlegt.`,
                    details: [
                        `Die Schätzung gibt es nur für belegte Veranlagungsjahre (aktuell 2025). Tarif + Konstanten für ${year} in docs/references/tax-sources.md ergänzen.`,
                    ],
                },
            ],
        };
    }
    const report = estReport(estConfig, year, { accountKeys: options.accountKeys, txs: options.txs });
    return assembleEstPlan(report);
}
