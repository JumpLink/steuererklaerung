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
import { _, _n, fmt as tfmt } from '../../lib/i18n.ts';
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
        { label: _('Profit (EÜR)'), amount: inp.euer.totals.profit },
        { label: _('USt-Zahllast'), amount: inp.euer.totals.vatPayable },
    ];
    if (inp.gewst) secondary.push({ label: _('GewSt-Messbetrag'), amount: inp.gewst.result.messbetrag });
    if (inp.feststellung)
        secondary.push({
            label: _('Festgestellte Einkünfte'),
            amount: inp.feststellung.result.festgestellteEinkuenfte,
        });
    return {
        primary: {
            label: bal >= 0 ? _('Expected additional payment') : _('Expected refund'),
            amount: Math.abs(bal),
            kind: bal >= 0 ? 'payment' : 'refund',
        },
        context: tfmt(_('USt closing balance {year}'), { year: inp.year }),
        secondary,
    };
}

/** The monetary result hero for the private ESt: the refund/payment + zvE + festzusetzende ESt. */
function estSummary(report: EstReport): TaxReturnSummary {
    const r = report.result;
    // r.erstattung: ≥ 0 = Erstattung (refund/green) · < 0 = Nachzahlung (payment/amber).
    return {
        primary: {
            label: r.erstattung >= 0 ? _('Expected refund') : _('Expected additional payment'),
            amount: Math.abs(r.erstattung),
            kind: r.erstattung >= 0 ? 'refund' : 'payment',
        },
        context: tfmt(_('Income tax {year}'), { year: report.year }),
        secondary: [
            { label: _('Taxable income (zvE)'), amount: r.zvE },
            { label: _('Income tax assessed'), amount: r.festzusetzendeESt },
        ],
    };
}

/** Build the form previews from the computed reports. */
function buildFormPreviews(inp: TaxReturnPlanInputs): WizardFormPreview[] {
    const blockedReason = inp.hasBetrieb ? undefined : _('No `betrieb` block in the ELSTER configuration.');
    const canExport = inp.hasBetrieb;
    const forms: WizardFormPreview[] = [];

    forms.push({
        form: 'euer',
        title: _('Anlage EÜR'),
        canExport,
        blockedReason,
        figures: [
            { label: _('Profit (current)'), value: eur(inp.euer.totals.profit) },
            { label: _('USt-Zahllast (year)'), value: eur(inp.euer.totals.vatPayable) },
        ],
    });

    const u = inp.uste;
    forms.push({
        form: 'uste',
        title: _('USt-Jahreserklärung'),
        canExport,
        blockedReason,
        figures: [
            { label: _('Revenue 19 %'), value: eur(u.net_19) },
            { label: _('USt collected'), value: eur(u.vat_out) },
            { label: _('Vorsteuer'), value: eur(u.vat_in) },
            {
                label: u.closingBalance >= 0 ? _('Abschlusszahlung') : _('Refund'),
                value: eur(Math.abs(u.closingBalance)),
            },
        ],
    });

    if (inp.gewst) {
        const r = inp.gewst.result;
        forms.push({
            form: 'gewst',
            title: _('Gewerbesteuer'),
            canExport,
            blockedReason,
            figures: [
                { label: _('Gewerbeertrag'), value: eur(r.gewerbeertrag) },
                { label: _('Steuermessbetrag'), value: eur(r.messbetrag) },
            ],
        });
    }

    if (inp.feststellung) {
        const res = inp.feststellung.result;
        forms.push({
            form: 'feststellung',
            title: _('Feststellung (GbR)'),
            canExport,
            blockedReason,
            // Names + Anteile only — never the partners' Steuer-IdNr.
            figures: [
                { label: _('Festgestellte Einkünfte'), value: eur(res.festgestellteEinkuenfte) },
                { label: _('Total income'), value: eur(res.einkuenfteGesamt) },
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
            title: _('Completeness'),
            tab: _('Complete'),
            status: 'blocked',
            headline: _('Without the year-end adjustments — the ELSTER configuration is missing.'),
            details: [_('The figures are a raw cash view (no AfA/§24/private share).')],
            actions: [{ label: _('Open settings'), view: 'settings' }],
        });
    } else {
        const uncl = cov.unclassified.length;
        steps.push({
            id: 'vollstaendigkeit',
            title: _('Completeness'),
            tab: _('Complete'),
            status: uncl === 0 ? 'ok' : 'blocked',
            headline:
                uncl === 0
                    ? tfmt(_n('All {n} booking classified.', 'All {n} bookings classified.', cov.transactions), {
                          n: cov.transactions,
                      })
                    : tfmt(_('{n} of {total} bookings unclassified — settle before filing.'), {
                          n: uncl,
                          total: cov.transactions,
                      }),
            details: [
                tfmt(_('via receipt: {byDoc} · via rule: {byRule}'), {
                    byDoc: cov.classifiedByDocument,
                    byRule: cov.classifiedByRule,
                }),
                ...cov.unclassified.slice(0, 5).map((u) =>
                    tfmt(_('unclear: {date} {amount} € {counterparty}'), {
                        date: u.bookingDate,
                        amount: fmt(u.amount),
                        counterparty: u.counterparty ?? '',
                    }).trim(),
                ),
            ],
            // Open bookings are fixed in the Buchungen view — deep-link straight there.
            actions: uncl === 0 ? undefined : [{ label: _('Open bookings'), view: 'transactions' }],
        });
    }

    // 2 · Anpassungen: the non-cash year-end items that were folded in.
    const anp: string[] = [];
    const afa = inp.euer.expenses.find((c) => c.category.startsWith('4830'));
    if (afa) anp.push(tfmt(_('AfA: {amount}'), { amount: eur(afa.net) }));
    const priv = inp.euer.income.find((c) => c.category.startsWith('8924'));
    if (priv) anp.push(tfmt(_('Private share (unentgeltliche Wertabgabe): {amount}'), { amount: eur(priv.net) }));
    if (inp.euer.totals.nachtraeglichNet !== 0)
        anp.push(tfmt(_('§24 subsequent (net): {amount}'), { amount: eur(inp.euer.totals.nachtraeglichNet) }));
    if (inp.betriebsaufgabeSchaetzung)
        anp.push(_('Betriebsaufgabe: gemeine Werte configured (an estimate — please check).'));
    steps.push({
        id: 'anpassungen',
        title: _('Year-end adjustments'),
        tab: _('Adjustments'),
        status: inp.betriebsaufgabeSchaetzung ? 'warn' : anp.length ? 'ok' : 'info',
        headline: anp.length
            ? tfmt(_n('{n} adjustment taken into account.', '{n} adjustments taken into account.', anp.length), {
                  n: anp.length,
              })
            : _('No adjustments configured.'),
        details: anp.length
            ? anp
            : [_('AfA/private share/§24/Betriebsaufgabe via `adjustments` in the ELSTER configuration.')],
    });

    // 3 · Formulare: previews + exportability.
    const exportable = forms.filter((f) => f.canExport).length;
    steps.push({
        id: 'formulare',
        title: _('Form previews'),
        tab: _('Forms'),
        status: exportable === forms.length ? 'ok' : 'blocked',
        headline:
            exportable === forms.length
                ? tfmt(
                      _n(
                          '{n} form ready (check PDF + ERiC XML).',
                          '{n} forms ready (check PDF + ERiC XML).',
                          forms.length,
                      ),
                      { n: forms.length },
                  )
                : tfmt(_('{n} of {total} forms cannot be exported.'), {
                      n: forms.length - exportable,
                      total: forms.length,
                  }),
        details: forms.map(
            (f) => `${f.title}: ${f.figures[0]?.value ?? '—'}${f.canExport ? '' : ` (${f.blockedReason})`}`,
        ),
        // Not exportable = the `betrieb`-Block is missing → the Einstellungen (ELSTER config) is where it's added.
        actions: exportable === forms.length ? undefined : [{ label: _('Open settings'), view: 'settings' }],
    });

    // 4 · Prüfung: the human-judgment items to confirm before filing.
    const checks: string[] = [];
    if (inp.betriebsaufgabeSchaetzung)
        checks.push(_('Confirm the gemeine Werte of the Betriebsaufgabe (§16/§34 — an estimate).'));
    checks.push(_('Spot-check the classification (`elster euer report --detail`).'));
    checks.push(_('Reconcile the figures against the prior year / the tax adviser’s reference.'));
    if (inp.gewst?.result.messbetrag === 0)
        checks.push(_('GewSt-Messbetrag 0 € (below the Freibetrag) — the return is filed all the same.'));
    steps.push({
        id: 'pruefung',
        title: _('Cross-check'),
        tab: _('Check'),
        status: inp.betriebsaufgabeSchaetzung ? 'warn' : 'info',
        headline: tfmt(_n('{n} point to check before filing.', '{n} points to check before filing.', checks.length), {
            n: checks.length,
        }),
        details: checks,
    });

    // 5 · Zusammenfassung: the final numbers + readiness for the Mein-ELSTER upload.
    const blocked = steps.some((s) => s.status === 'blocked');
    const ready = !blocked && exportable === forms.length;
    const summary: string[] = [
        tfmt(_('Profit (current): {amount}'), { amount: eur(inp.euer.totals.profit) }),
        tfmt(_('USt closing balance: {amount} ({kind})'), {
            amount: eur(inp.uste.closingBalance),
            kind: inp.uste.closingBalance >= 0 ? _('payment') : _('refund'),
        }),
    ];
    if (inp.feststellung)
        summary.push(
            tfmt(_('Festgestellte Einkünfte: {amount}'), {
                amount: eur(inp.feststellung.result.festgestellteEinkuenfte),
            }),
        );
    if (inp.gewst) summary.push(tfmt(_('GewSt-Messbetrag: {amount}'), { amount: eur(inp.gewst.result.messbetrag) }));
    summary.push(
        ready
            ? tfmt(
                  _n(
                      '{n} form exportable as ERiC XML → upload it in Mein ELSTER.',
                      '{n} forms exportable as ERiC XML → upload them in Mein ELSTER.',
                      exportable,
                  ),
                  { n: exportable },
              )
            : _('Not ready to file yet — open steps above.'),
    );
    steps.push({
        id: 'zusammenfassung',
        title: _('Summary & filing'),
        tab: _('Filing'),
        status: ready ? 'ok' : 'blocked',
        headline: ready ? _('Ready to file — export the XML for Mein ELSTER.') : _('Not ready to file yet.'),
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
        tfmt(_('Gross wages: {gross} · Lohnsteuer withheld: {withheld}'), {
            gross: eur(r.bruttoarbeitslohn),
            withheld: eur(r.abrechnung.est.einbehalten),
        }),
    ];
    if (r.einkuenfteGewerbe > 0)
        complete.push(tfmt(_('Einkünfte aus Gewerbebetrieb: {amount}'), { amount: eur(r.einkuenfteGewerbe) }));
    if (report.gehaltPlausibilitaet) {
        const g = report.gehaltPlausibilitaet;
        complete.push(
            tfmt(_('Net plausibility: detected {detected} vs. expected {expected} ({delta}, {percent} %)'), {
                detected: eur(g.gehaltNettoSumme),
                expected: eur(g.netUngefaehr),
                delta: signedEur(g.gehaltNettoSumme - g.netUngefaehr),
                percent: g.abweichungProzent,
            }),
        );
    }
    const unclassified = report.aggregate.coverage.unclassified.length;
    if (unclassified > 0)
        complete.push(
            tfmt(
                _n(
                    '{n} booking unclassified — assign it to a topic or ignore it.',
                    '{n} bookings unclassified — assign them to a topic or ignore them.',
                    unclassified,
                ),
                { n: unclassified },
            ),
        );
    const plausibilityOff =
        (report.gehaltPlausibilitaet?.abweichungProzent ?? 0) < -10 ||
        (report.gehaltPlausibilitaet?.abweichungProzent ?? 0) > 10;
    steps.push({
        id: 'vollstaendigkeit',
        title: _('Income & Lohnsteuerbescheinigung'),
        tab: _('Income'),
        status: !report.hasBescheinigung ? 'blocked' : plausibilityOff ? 'warn' : 'ok',
        headline: !report.hasBescheinigung
            ? tfmt(_('No Lohnsteuerbescheinigung for {year} in the ESt configuration.'), { year: report.year })
            : tfmt(_('Gross wages {amount} recorded.'), { amount: eur(r.bruttoarbeitslohn) }),
        details: report.hasBescheinigung
            ? complete
            : [_('Enter jahre[].bruttoarbeitslohn/lohnsteuer/soli/kirchensteuer in est-config.json.')],
        // No Lohnsteuerbescheinigung → it's entered in the ESt config (Einstellungen); otherwise open
        // bookings to classify are fixed in the Buchungen view.
        actions: !report.hasBescheinigung
            ? [{ label: _('Open settings'), view: 'settings' }]
            : unclassified > 0
              ? [{ label: _('Open bookings'), view: 'transactions' }]
              : undefined,
    });

    // 2 · Abzüge (Werbungskosten, Vorsorge, Sonderausgaben, agB, §35a).
    const abz: string[] = [
        r.werbungskosten.pauschbetragGewonnen
            ? tfmt(_('Work-related expenses: employee lump sum {amount} (higher than the itemised proof).'), {
                  amount: eur(r.werbungskosten.pauschbetrag),
              })
            : tfmt(_('Work-related expenses: itemised {amount} (above the lump sum {lump}).'), {
                  amount: eur(r.werbungskosten.angesetzt),
                  lump: eur(r.werbungskosten.pauschbetrag),
              }),
        tfmt(_('Insurance contributions deductible: {amount} (retirement {retirement} + health/care/other {other}).'), {
            amount: eur(r.vorsorge.abziehbar),
            retirement: eur(r.vorsorge.altersvorsorgeAbziehbar),
            other: eur(r.vorsorge.sonstigeAbziehbar),
        }),
        tfmt(_('Sonderausgaben (church tax/donations): {amount}.'), {
            amount: eur(r.sonderausgaben.nichtVorsorgeAngesetzt),
        }),
    ];
    if (r.agb.krankheitskosten > 0) {
        abz.push(
            r.agb.abziehbar > 0
                ? tfmt(_('agB: {amount} above the zumutbare Belastung ({limit}).'), {
                      amount: eur(r.agb.abziehbar),
                      limit: eur(r.agb.zumutbareBelastung),
                  })
                : tfmt(_('agB: {amount} entirely absorbed by the zumutbare Belastung ({limit}).'), {
                      amount: eur(r.agb.krankheitskosten),
                      limit: eur(r.agb.zumutbareBelastung),
                  }),
        );
    }
    const par35aOffen = report.aggregate.par35aOhneArbeitskosten;
    if (par35aOffen > 0) {
        abz.push(
            tfmt(
                _n(
                    '§35a: {n} trade/service booking without a labour-cost share — only the labour (not the material) counts; enter it from the invoice (the payment is cashless ✓).',
                    '§35a: {n} trade/service bookings without a labour-cost share — only the labour (not the material) counts; enter it from the invoice (the payment is cashless ✓).',
                    par35aOffen,
                ),
                { n: par35aOffen },
            ),
        );
    } else if (r.ermaessigung35a.berechnet > 0) {
        abz.push(
            r.ermaessigung35a.verfallen > 0
                ? tfmt(_('§35a reduction: {amount} ({expired} expired).'), {
                      amount: eur(r.ermaessigung35a.angesetzt),
                      expired: eur(r.ermaessigung35a.verfallen),
                  })
                : tfmt(_('§35a reduction: {amount}.'), { amount: eur(r.ermaessigung35a.angesetzt) }),
        );
    }
    if (report.aggregate.vorsorgeKandidat > 0) {
        abz.push(
            tfmt(
                _(
                    'Insurance candidates from bookings: {amount} — sort into basic health/care vs. other (configuration).',
                ),
                { amount: eur(report.aggregate.vorsorgeKandidat) },
            ),
        );
    }
    steps.push({
        id: 'anpassungen',
        title: _('Deductions'),
        status: par35aOffen > 0 ? 'warn' : 'ok',
        headline: tfmt(_('Total amount of income {total} → zvE {zve}.'), {
            total: eur(r.gesamtbetragEinkuenfte),
            zve: eur(r.zvE),
        }),
        details: abz,
    });

    // 3 · Formular-Vorschau (ESt 1 A + Anlage N) — E10-XML + Prüfblatt exportable (buildEstEds / loadEstPdf).
    const forms: WizardFormPreview[] = [
        {
            form: 'est',
            title: _('ESt 1 A + Anlage N (estimate)'),
            canExport: true,
            figures: [
                { label: _('Taxable income (zvE)'), value: eur(r.zvE) },
                { label: _('Tariff income tax'), value: eur(r.tariflicheESt) },
                { label: _('Tax reduction §35a'), value: eur(r.ermaessigung35a.angesetzt) },
                { label: _('Income tax assessed'), value: eur(r.festzusetzendeESt) },
                { label: r.erstattung >= 0 ? _('Refund') : _('Additional payment'), value: signedEur(r.erstattung) },
            ],
        },
    ];
    steps.push({
        id: 'formulare',
        title: _('Form preview'),
        tab: _('Forms'),
        status: 'info',
        headline: _(
            'ESt 1 A + Anlage N (estimate) — check PDF + E10 XML exportable; file via ELSTER direct submission (release) or the web form.',
        ),
        details: forms[0].figures.map((f) => `${f.label}: ${f.value}`),
    });

    // 4 · Gegenprüfung (the Günstigerprüfungen the Finanzamt runs, the duty to keep receipts).
    steps.push({
        id: 'pruefung',
        title: _('Cross-check'),
        tab: _('Check'),
        status: 'info',
        headline: _('Points that can make the assessment differ from the estimate.'),
        details: [
            _(
                'The Finanzamt runs the Günstigerprüfungen: Kindergeld/Kinderfreibetrag (§31), capital income (§32d (6)) + Sparer-Pauschbetrag, the old insurance rule (§10 (4a)).',
            ),
            _(
                '§35a: an invoice + a cashless payment are required (a bank payment satisfies that) — keep the receipts.',
            ),
            _('The tax assessment is what binds; these figures are an estimate.'),
        ],
    });

    // 5 · Zusammenfassung.
    const blocked = steps.some((s) => s.status === 'blocked');
    const ready = !blocked;
    steps.push({
        id: 'zusammenfassung',
        title: _('Summary'),
        tab: _('Filing'),
        status: ready ? 'ok' : 'blocked',
        headline: ready
            ? r.erstattung >= 0
                ? tfmt(_('Expected refund: {amount}'), { amount: signedEur(r.erstattung) })
                : tfmt(_('Expected additional payment: {amount}'), { amount: signedEur(r.erstattung) })
            : _('Still incomplete — the Lohnsteuerbescheinigung is missing.'),
        details: [
            tfmt(_('income tax assessed {assessed} − Lohnsteuer withheld {withheld} = {result}'), {
                assessed: eur(r.festzusetzendeESt),
                withheld: eur(r.abrechnung.est.einbehalten),
                result: signedEur(r.abrechnung.est.erstattung),
            }),
            tfmt(_('Soli {owed} − withheld {withheld} = {result}'), {
                owed: eur(r.abrechnung.soli.soll),
                withheld: eur(r.abrechnung.soli.einbehalten),
                result: signedEur(r.abrechnung.soli.erstattung),
            }),
            tfmt(_('KiSt {owed} − withheld {withheld} = {result}'), {
                owed: eur(r.abrechnung.kirchensteuer.soll),
                withheld: eur(r.abrechnung.kirchensteuer.einbehalten),
                result: signedEur(r.abrechnung.kirchensteuer.erstattung),
            }),
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
                    title: _('Income tax'),
                    tab: _('Income'),
                    status: 'blocked',
                    headline: tfmt(_('No income tax tariff on file for {year}.'), { year }),
                    details: [
                        tfmt(
                            _(
                                'The estimate exists only for documented assessment years (2025 at the moment). Add the tariff + constants for {year} to docs/references/tax-sources.md.',
                            ),
                            { year },
                        ),
                    ],
                },
            ],
        };
    }
    const report = estReport(estConfig, year, { accountKeys: options.accountKeys, txs: options.txs });
    return assembleEstPlan(report);
}
