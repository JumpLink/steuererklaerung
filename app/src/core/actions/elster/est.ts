/**
 * Private Einkommensteuer (ESt) report — the I/O wrapper that turns a `privat` entity's store
 * transactions plus its {@link EstConfig} into an {@link EstResult} estimate.
 *
 * Store-only: a private account has no Paperless/DMS, so (like the home dashboard) this reads bank
 * transactions and nothing else. The transaction-derived theme buckets (est-aggregate) are merged
 * with the hand-entered Lohnsteuerbescheinigung/Vorsorge (est-config) — config wins — into the pure
 * {@link EstInputs}, then {@link computeEst} produces the assessment. Everything is a *Schätzung*.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import { round2, fmtDe as fmt } from '../../lib/money.ts';
import { searchAccountKeys } from '../transactions.ts';
import { type EstConfig, estJahr, estKindJahr } from '../../config/index.ts';
import {
    aggregateEstByTransactions,
    type EstTxAggregate,
    type EstTxOverrides,
    type EstThemeBucket,
} from '../../elster/est-aggregate.ts';
import {
    computeEst,
    estThemeImpacts,
    type EstInputs,
    type EstResult,
    type EstThemeImpact,
    type EstThemeKey,
} from '../../elster/est-berechnung.ts';

export interface EstReport {
    year: number;
    entityId: string;
    inputs: EstInputs;
    aggregate: EstTxAggregate;
    result: EstResult;
    themeImpacts: EstThemeImpact[];
    /** true when a Lohnsteuerbescheinigung row exists for the year (else the plan blocks). */
    hasBescheinigung: boolean;
    /** Net-pay plausibility: expected annual net vs. the salary credits detected (info only). */
    gehaltPlausibilitaet?: { netUngefaehr: number; gehaltNettoSumme: number; abweichungProzent: number };
}

/** The per-transaction overrides the aggregate needs, derived from the config. */
export function estOverrides(config: EstConfig): EstTxOverrides {
    const arbeitskosten: Record<string, number> = {};
    for (const e of config.par35a_arbeitskosten) arbeitskosten[e.transaktion_id] = e.arbeitskosten;
    const reklassifizierung: Record<string, EstThemeBucket> = {};
    for (const e of config.reklassifizierungen) reklassifizierung[e.transaktion_id] = e.ziel;
    return { arbeitskosten, reklassifizierung };
}

/**
 * Merge config + transaction aggregate into the pure {@link EstInputs}. Config figures win; the
 * aggregate supplies the transaction-derived posten (Werbungskosten, §35a Arbeitskosten, Spenden,
 * Krankheitskosten). Pure — unit-testable without a store.
 */
export function buildEstInputs(config: EstConfig, aggregate: EstTxAggregate, year: number): EstInputs {
    const j = estJahr(config, year);
    const v = j?.vorsorge;
    // Anlage Kind amounts: per child the share borne by the taxpayer himself (von_mir,
    // default = gezahlt resp. betrag − erstattet) — only one's own share is deductible.
    const kindJahre = (config.kinder ?? []).map((k) => estKindJahr(k, year));
    const schulgeldJeKind = kindJahre.map((kj) =>
        round2(kj?.schulgeld ? (kj.schulgeld.von_mir ?? kj.schulgeld.gezahlt) : 0),
    );
    const kinderbetreuungJeKind = kindJahre.map((kj) =>
        round2((kj?.kinderbetreuung ?? []).reduce((s, b) => s + (b.von_mir ?? Math.max(0, b.betrag - b.erstattet)), 0)),
    );
    // The per-child cap applies only when the amount is attributed to children COMPLETELY (no
    // extra annual lump-sum figure, which could not be capped in any child column).
    const schulgeldProKind = schulgeldJeKind.some((x) => x > 0) && (j?.schulgeld ?? 0) === 0;
    const betreuungProKind = kinderbetreuungJeKind.some((x) => x > 0) && (j?.kinderbetreuung ?? 0) === 0;
    return {
        year,
        veranlagung: config.veranlagung,
        kinder: config.person.kinder,
        kirchensteuersatz: config.person.kirchensteuersatz,
        bruttoarbeitslohn: j?.bruttoarbeitslohn ?? 0,
        einkuenfteGewerbe: j?.einkuenfte_gewerbe ?? 0,
        // Festgestellte Beteiligungen (Anlage G Ges_Fest) feed into the GdE — the Schätzung has to
        // account for them the way the E10 XML does (est-xml buildG). Kept separate (no double count
        // in E0800302). Without Beteiligungen = 0 → result identical to before.
        einkuenfteGewerbeBeteiligungen: round2((j?.gewerbe_beteiligungen ?? []).reduce((s, b) => s + b.betrag, 0)),
        einbehalten: {
            lohnsteuer: j?.lohnsteuer ?? 0,
            soli: j?.soli ?? 0,
            kirchensteuer: j?.kirchensteuer ?? 0,
            estVorauszahlung: j?.est_vorauszahlung ?? 0,
        },
        werbungskosten: {
            homeofficeTage: j?.werbungskosten?.homeoffice_tage ?? 0,
            pendel: j?.werbungskosten?.pendel
                ? { tage: j.werbungskosten.pendel.arbeitstage, kmEinfach: j.werbungskosten.pendel.km_einfach }
                : undefined,
            posten: [
                ...aggregate.werbungskostenPosten,
                ...(j?.werbungskosten?.posten ?? []).map((p) => ({
                    bezeichnung: p.bezeichnung,
                    betrag: p.betrag,
                    quelle: 'manuell' as const,
                })),
            ],
        },
        vorsorge: {
            rvArbeitnehmer: v?.rv_arbeitnehmer ?? 0,
            rvArbeitgeberSteuerfrei: v?.rv_arbeitgeber_steuerfrei ?? 0,
            kvBasis: v?.kv_basis ?? 0,
            pvBasis: v?.pv_basis ?? 0,
            // AV-Beiträge (Bescheinigung Nr. 27) share the capped "sonstige Vorsorge" bucket
            // (§10 Abs. 1 Nr. 3a) — the split only matters for the E10 XML lines.
            sonstige: round2((v?.sonstige ?? 0) + (v?.av_arbeitnehmer ?? 0)),
            hatAgZuschuss: v?.ag_zuschuss ?? true,
        },
        sonderausgaben: {
            spenden: round2(aggregate.spenden + (j?.spenden ?? 0)),
            gezahlteKirchensteuer: j?.gezahlte_kirchensteuer ?? j?.kirchensteuer ?? 0,
            // Annual lump-sum figure (a Schätzung without child attribution) + the child-attributed
            // amounts; the E10 XML accepts ONLY the child-attributed ones (fail loud in est-xml).
            schulgeld: round2((j?.schulgeld ?? 0) + schulgeldJeKind.reduce((s, x) => s + x, 0)),
            kinderbetreuung: round2((j?.kinderbetreuung ?? 0) + kinderbetreuungJeKind.reduce((s, x) => s + x, 0)),
            schulgeldJeKind: schulgeldProKind ? schulgeldJeKind : undefined,
            kinderbetreuungJeKind: betreuungProKind ? kinderbetreuungJeKind : undefined,
        },
        agb: { krankheitskosten: round2(aggregate.krankheitskosten + (j?.krankheitskosten ?? 0)) },
        par35a: {
            handwerkerArbeitskosten: round2(aggregate.handwerkerArbeitskosten + (j?.par35a_manuell?.handwerker ?? 0)),
            haushaltsnah: round2(aggregate.haushaltsnahArbeitskosten + (j?.par35a_manuell?.haushaltsnah ?? 0)),
            minijob: j?.par35a_manuell?.minijob ?? 0,
        },
        par34g: { parteibeitrag: j?.parteibeitrag ?? 0 },
        // §32b: net of the Einkommensersatzleistungen (received − repaid); negative on a repayment.
        progressionseinkuenfte: round2((j?.lohnersatz?.erhalten ?? 0) - (j?.lohnersatz?.zurueckgezahlt ?? 0)),
        // §24b Entlastungsbetrag für Alleinerziehende (months + further children).
        entlastungAlleinerziehende: j?.entlastung_alleinerziehende
            ? {
                  monate: j.entlastung_alleinerziehende.monate,
                  weitereKinder: j.entlastung_alleinerziehende.weitere_kinder,
              }
            : undefined,
    };
}

/** Rough expected annual net (Brutto − LSt/Soli/KiSt − AN-Sozialversicherung) for the plausibility check. */
function netUngefaehr(config: EstConfig, year: number): number | undefined {
    const j = estJahr(config, year);
    if (!j || j.bruttoarbeitslohn <= 0) return undefined;
    const v = j.vorsorge;
    const abz =
        j.lohnsteuer + j.soli + j.kirchensteuer + (v?.rv_arbeitnehmer ?? 0) + (v?.kv_basis ?? 0) + (v?.pv_basis ?? 0);
    return round2(j.bruttoarbeitslohn - abz);
}

/**
 * Build the full ESt report for a year. Pass pre-fetched `txs` (web/app cache) to avoid a store
 * read; otherwise the entity's `accountKeys` are read from the store for that year.
 */
export function estReport(
    config: EstConfig,
    year: number,
    options: { accountKeys?: string[]; txs?: UnifiedTransaction[]; detail?: boolean } = {},
): EstReport {
    const overrides = estOverrides(config);
    const txs =
        options.txs ?? searchAccountKeys(options.accountKeys ?? [], { from: `${year}-01-01`, to: `${year}-12-31` });
    const aggregate = aggregateEstByTransactions(txs, year, { detail: options.detail, overrides });
    const inputs = buildEstInputs(config, aggregate, year);
    const result = computeEst(inputs);
    const themeImpacts = estThemeImpacts(inputs);
    const hasBescheinigung = estJahr(config, year) != null;

    let gehaltPlausibilitaet: EstReport['gehaltPlausibilitaet'];
    const net = netUngefaehr(config, year);
    if (net != null && net > 0 && aggregate.gehaltNettoSumme > 0) {
        gehaltPlausibilitaet = {
            netUngefaehr: net,
            gehaltNettoSumme: aggregate.gehaltNettoSumme,
            abweichungProzent: round2(((aggregate.gehaltNettoSumme - net) / net) * 100),
        };
    }

    return {
        year,
        entityId: config.entity_id,
        inputs,
        aggregate,
        result,
        themeImpacts,
        hasBescheinigung,
        gehaltPlausibilitaet,
    };
}

const THEME_LABEL: Record<string, string> = {
    arbeit: 'Arbeit & Werbungskosten',
    handwerker: 'Zuhause & Handwerker (§35a)',
    haushaltsnah: 'Haushaltsnahe Dienstleistungen (§35a)',
    vorsorge: 'Versicherungen & Vorsorge',
    gesundheit: 'Gesundheit (agB)',
    spenden: 'Spenden',
};
const eur = (n: number): string => `${fmt(n)} €`;
const signedEur = (n: number): string => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))} €`;

/** One Finanzguru-style Steuer-Thema card (design 08-steuer.png), everything pre-formatted for the UI. */
export interface EstThemeCard {
    key: EstThemeKey;
    title: string;
    /** Base amount of the theme. */
    amount: number;
    /** € effect on the refund (exact counterfactual). */
    impact: number;
    /** done = has an effect · open = captured, but (yet) without effect / input needed · na = not relevant. */
    status: 'done' | 'open' | 'na';
    hint: string;
    items: Array<{ label: string; value: string }>;
}

const THEME_TITLES: Record<EstThemeKey, string> = {
    arbeit: 'Arbeit & Werbungskosten',
    handwerker: 'Zuhause & Handwerker',
    haushaltsnah: 'Haushaltsnahe Dienstleistungen',
    vorsorge: 'Versicherungen & Vorsorge',
    gesundheit: 'Gesundheit',
    spenden: 'Spenden & Mitgliedschaften',
};

/** Enrich the raw {@link EstThemeImpact}s into UI cards (title, status, hint, line items). */
export function estThemeCards(report: EstReport): EstThemeCard[] {
    const r = report.result;
    return report.themeImpacts.map((t): EstThemeCard => {
        const items: Array<{ label: string; value: string }> = [];
        let hint = '';
        let status: EstThemeCard['status'] = t.amount === 0 ? 'na' : t.impact > 0 ? 'done' : 'open';
        switch (t.key) {
            case 'arbeit': {
                const w = r.werbungskosten;
                if (w.entfernungspauschale > 0)
                    items.push({ label: 'Entfernungspauschale', value: eur(w.entfernungspauschale) });
                if (w.homeofficePauschale > 0)
                    items.push({ label: 'Homeoffice-Pauschale', value: eur(w.homeofficePauschale) });
                for (const p of report.inputs.werbungskosten.posten)
                    items.push({ label: p.bezeichnung, value: eur(p.betrag) });
                hint = w.pauschbetragGewonnen
                    ? `Arbeitnehmer-Pauschbetrag ${eur(w.pauschbetrag)} greift (höher als der Einzelnachweis).`
                    : `Einzelnachweis ${eur(w.angesetzt)} liegt über der Pauschale ${eur(w.pauschbetrag)}.`;
                break;
            }
            case 'handwerker':
                items.push({
                    label: 'begünstigte Arbeitskosten',
                    value: eur(report.inputs.par35a.handwerkerArbeitskosten),
                });
                if (report.aggregate.par35aOhneArbeitskosten > 0) {
                    status = 'open';
                    hint = `${report.aggregate.par35aOhneArbeitskosten} Rechnung(en) noch ohne Arbeitskostenanteil — nur der Arbeitslohn zählt (§35a), aus der Rechnung eintragen.`;
                } else {
                    hint =
                        '20 % des Arbeitslohns werden direkt von der Steuer abgezogen (§35a); die Bankzahlung erfüllt die Unbar-Pflicht.';
                }
                break;
            case 'haushaltsnah':
                items.push({ label: 'haushaltsnahe Dienstleistungen', value: eur(report.inputs.par35a.haushaltsnah) });
                hint =
                    '20 % (max. 4.000 €) direkt von der Steuer (§35a) — z. B. die Lohnanteile aus der Nebenkostenabrechnung.';
                break;
            case 'vorsorge': {
                const v = r.vorsorge;
                items.push({ label: 'Altersvorsorge (abziehbar)', value: eur(v.altersvorsorgeAbziehbar) });
                items.push({ label: 'KV/PV + sonstige (abziehbar)', value: eur(v.sonstigeAbziehbar) });
                hint =
                    'Rentenbeiträge kommen als eDaten von der Rentenversicherung; Basis-KV/PV sind unbegrenzt abziehbar.';
                break;
            }
            case 'gesundheit':
                items.push({ label: 'Krankheitskosten', value: eur(r.agb.krankheitskosten) });
                hint =
                    r.agb.abziehbar > 0
                        ? `${eur(r.agb.abziehbar)} über der zumutbaren Belastung (${eur(r.agb.zumutbareBelastung)}) wirken sich aus.`
                        : `Liegt unter der zumutbaren Belastung (${eur(r.agb.zumutbareBelastung)}) — derzeit ohne Wirkung, trotzdem erfassen.`;
                break;
            case 'spenden':
                items.push({ label: 'Spenden', value: eur(r.sonderausgaben.spenden) });
                hint = 'Bis 300 € genügt der Kontoauszug als Nachweis (§10b Abs. 1).';
                break;
        }
        return { key: t.key, title: THEME_TITLES[t.key], amount: t.amount, impact: t.impact, status, hint, items };
    });
}

/** One row of the Abzugs-Wasserfall (design's Abzugs-Summary), pre-formatted. */
export interface EstWaterfallRow {
    label: string;
    value: string;
    /** total = subtotal (bold) · result = the Erstattung/Nachzahlung (accented). */
    emphasis?: 'total' | 'result';
}

/** The Bruttoarbeitslohn → … → Erstattung waterfall as display rows. */
export function estWaterfall(r: EstResult): EstWaterfallRow[] {
    const rows: EstWaterfallRow[] = [{ label: 'Bruttoarbeitslohn', value: eur(r.bruttoarbeitslohn) }];
    if (r.einkuenfteGewerbe > 0) rows.push({ label: 'Einkünfte aus Gewerbebetrieb', value: eur(r.einkuenfteGewerbe) });
    rows.push({ label: 'Werbungskosten (Anlage N)', value: `−${eur(r.werbungskosten.angesetzt)}` });
    rows.push({ label: 'Gesamtbetrag der Einkünfte', value: eur(r.gesamtbetragEinkuenfte), emphasis: 'total' });
    rows.push({ label: 'Sonderausgaben & Vorsorge', value: `−${eur(r.sonderausgaben.gesamt)}` });
    if (r.agb.abziehbar > 0) rows.push({ label: 'Außergewöhnliche Belastungen', value: `−${eur(r.agb.abziehbar)}` });
    rows.push({ label: 'Zu versteuerndes Einkommen', value: eur(r.zvE), emphasis: 'total' });
    rows.push({ label: 'Tarifliche Einkommensteuer', value: eur(r.tariflicheESt) });
    if (r.ermaessigung34g.angesetzt > 0)
        rows.push({ label: 'Steuerermäßigung §34g (Parteien)', value: `−${eur(r.ermaessigung34g.angesetzt)}` });
    if (r.ermaessigung35a.angesetzt > 0)
        rows.push({ label: 'Steuerermäßigung §35a', value: `−${eur(r.ermaessigung35a.angesetzt)}` });
    rows.push({ label: 'Festzusetzende Einkommensteuer', value: eur(r.festzusetzendeESt) });
    rows.push({ label: 'Einbehaltene Lohnsteuer', value: `−${eur(r.abrechnung.est.einbehalten)}` });
    rows.push({
        label: r.erstattung >= 0 ? 'Voraussichtliche Erstattung' : 'Voraussichtliche Nachzahlung',
        value: signedEur(r.erstattung),
        emphasis: 'result',
    });
    return rows;
}

/** Print the ESt estimate as a readable breakdown (headless CLI view). */
export function printEstReport(report: EstReport): void {
    const r = report.result;
    console.log(`\nEinkommensteuer-Schätzung — ${report.entityId} ${report.year}`);
    console.log('='.repeat(64));
    console.log(`Bruttoarbeitslohn            ${eur(r.bruttoarbeitslohn).padStart(16)}`);
    if (r.einkuenfteGewerbe > 0) console.log(`Einkünfte Gewerbebetrieb     ${eur(r.einkuenfteGewerbe).padStart(16)}`);
    console.log(
        `− Werbungskosten             ${eur(r.werbungskosten.angesetzt).padStart(16)}${r.werbungskosten.pauschbetragGewonnen ? '  (Pauschbetrag)' : ''}`,
    );
    console.log(`= Gesamtbetrag Einkünfte     ${eur(r.gesamtbetragEinkuenfte).padStart(16)}`);
    const saExtra = [
        r.sonderausgaben.schulgeld > 0 ? `Schulgeld ${eur(r.sonderausgaben.schulgeld)}` : '',
        r.sonderausgaben.kinderbetreuung > 0 ? `Kinderbetreuung ${eur(r.sonderausgaben.kinderbetreuung)}` : '',
    ].filter(Boolean);
    console.log(
        `− Sonderausgaben             ${eur(r.sonderausgaben.gesamt).padStart(16)}  (Vorsorge ${eur(r.sonderausgaben.vorsorgeAbziehbar)}${saExtra.length ? ' · ' + saExtra.join(' · ') : ''})`,
    );
    if (r.agb.abziehbar > 0) console.log(`− agB (über zumutbar)        ${eur(r.agb.abziehbar).padStart(16)}`);
    console.log(`= zu versteuerndes Einkommen ${eur(r.zvE).padStart(16)}`);
    console.log(`  tarifliche ESt             ${eur(r.tariflicheESt).padStart(16)}`);
    if (r.ermaessigung34g.angesetzt > 0)
        console.log(`− §34g-Ermäßigung (Parteien) ${eur(r.ermaessigung34g.angesetzt).padStart(16)}`);
    console.log(
        `− §35a-Ermäßigung            ${eur(r.ermaessigung35a.angesetzt).padStart(16)}${r.ermaessigung35a.verfallen > 0 ? `  (${eur(r.ermaessigung35a.verfallen)} verfallen)` : ''}`,
    );
    console.log(`= festzusetzende ESt         ${eur(r.festzusetzendeESt).padStart(16)}`);
    console.log(
        `  Soli / KiSt (Soll)         ${eur(r.abrechnung.soli.soll)} / ${eur(r.abrechnung.kirchensteuer.soll)}`,
    );
    const sign = r.erstattung >= 0 ? '+' : '−';
    console.log(
        `\n${r.erstattung >= 0 ? 'Voraussichtliche Erstattung' : 'Voraussichtliche Nachzahlung'}: ${sign}${eur(Math.abs(r.erstattung))}`,
    );

    console.log('\nSteuer-Themen (€-Wirkung auf die Erstattung):');
    for (const t of report.themeImpacts) {
        if (t.amount === 0 && t.impact === 0) continue;
        console.log(
            `  ${(THEME_LABEL[t.key] ?? t.key).padEnd(38)} ${eur(t.amount).padStart(12)}   Wirkung ${t.impact >= 0 ? '+' : '−'}${eur(Math.abs(t.impact))}`,
        );
    }
    for (const h of r.hinweise) console.log(`  · ${h}`);
    console.log('');
}
