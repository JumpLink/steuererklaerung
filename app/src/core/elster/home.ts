/**
 * Home / Übersicht dashboard model — a pure assembler shared by the web (`data.ts` year cache) and
 * the native app (`data/home.ts`), so the two front-ends can never drift (the established pattern of
 * `computeBwa` / `computeSteuerDashboard` / `computeHinweise`).
 *
 * Everything is derived from the entity's transactions plus the already-computed Steuer-Dashboard
 * (tax forecast + declaration deadlines). No classification is required, so it works identically for
 * a business entity, the private household, the demo firm, and real data.
 */

import type { SteuerDashboard } from './fristen.ts';
import type { Hinweis, HinweisHandlung } from './hinweise.ts';
import { qontoCategoryLabel } from '../lib/qonto-categories.ts';
import { fmtDe } from '../lib/money.ts';
import { zuPruefenTitel } from './zu-pruefen.ts';
import { zuBestaetigenTitel } from './laufende-kosten.ts';
import { erstattungenTitel } from './erstattung.ts';
import { forderungenTitel } from '../invoices/forderungen.ts';

/** Minimal transaction shape the dashboard needs (a structural subset of UnifiedTransaction). */
export interface HomeTx {
    accountKey: string;
    source: string;
    bookingDate: string;
    amount: number;
    category?: string;
}

export interface HomeModelInput {
    year: number;
    /** ALL of the entity's transactions (any year) — year filtering + all-time balances happen here. */
    txs: HomeTx[];
    /** Steuer-Dashboard for the tax-forecast KPI + the "Als Nächstes" deadlines (null without ELSTER). */
    dashboard: SteuerDashboard | null;
    /** Optional account-key → display label overrides (from the ELSTER config). */
    accountLabels?: Record<string, string>;
    /** Suspected double payments (see invoices/doppelzahlung.ts) — one "Als Nächstes" task each, before the fristen. */
    doppelzahlungVerdacht?: { rechnungId: string; rechnungNummer: string; zuViel: number; teilweise?: boolean }[];
    /** The year's Hinweise (already without the ones marked „in Ordnung"): each finding with an action is a task. */
    hinweise?: Hinweis[];
    /** Bookings in „Zu prüfen" (unclassified or only caught by an Auffangregel) — one task for all. */
    zuPruefen?: number;
    /** Detected laufende Kosten without a decision — one task for all. */
    laufendeKostenOffen?: number;
    /**
     * Incoming payments with a refund candidate and no link (Idee 9) — one task for all. `zuPruefen`
     * must then count the queue WITHOUT them (they sit in it too), so no booking makes two tasks.
     */
    erstattungenOffen?: number;
    /**
     * Overdue outgoing invoices (Idee 12) — one task for all. Count only the ones the Verjährung hint
     * does not carry (`zaehleUeberfaellige`), so no invoice makes two tasks.
     */
    forderungenUeberfaellig?: number;
}

export interface HomeKpis {
    income: number;
    expense: number;
    profit: number;
    /** vsl. Nachzahlung (>0) / Erstattung (<0); null without a tax config. */
    tax: { total: number; label: string } | null;
}

export interface HomeAccount {
    name: string;
    initials: string;
    balance: number;
    source: string;
}

export interface HomeTask {
    title: string;
    sub: string;
    tone: 'accent' | 'warn' | 'neutral';
    /** Set on a task that opens a specific decision instead of a deadline. */
    kind?: 'doppelzahlung' | 'hinweis' | 'zu-pruefen' | 'laufende-kosten' | 'erstattungen' | 'forderungen';
    /** The subject the task refers to — for `doppelzahlung` the invoice id, for `hinweis` the hint key. */
    ref?: string;
    /** For `hinweis`: the action activating the task runs (the hint's first one besides „in Ordnung"). */
    handlung?: HinweisHandlung;
}

/**
 * Hints with a task of their own above — shown once, not twice. The unclassified bookings are a
 * subset of „Zu prüfen", so while that task exists it replaces the hint's; the hint itself stays in
 * the Einblicke with its actions.
 */
const EIGENE_AUFGABE: Record<string, (i: HomeModelInput) => boolean> = {
    'doppelzahlung-verdacht': (i) => (i.doppelzahlungVerdacht?.length ?? 0) > 0,
    unklassifiziert: (i) => (i.zuPruefen ?? 0) > 0 || (i.erstattungenOffen ?? 0) > 0,
};

/** The one „Zu prüfen" task, or none when the queue is empty. */
export function zuPruefenTask(input: HomeModelInput): HomeTask | null {
    const n = input.zuPruefen ?? 0;
    if (n <= 0) return null;
    return {
        title: zuPruefenTitel(n),
        sub: 'Unklassifiziert oder nur von einer Auffangregel erfasst — bestätigen oder umbuchen',
        tone: 'warn',
        kind: 'zu-pruefen',
    };
}

/** The one „N Erstattungen zuordnen" task, or none when no refund waits for „Ja" or „Nein". */
export function erstattungenTask(input: HomeModelInput): HomeTask | null {
    const n = input.erstattungenOffen ?? 0;
    if (n <= 0) return null;
    return {
        title: erstattungenTitel(n),
        sub: 'Eingänge, die eine frühere Zahlung erstatten — „Ja" übernimmt deren Kategorie und Vorsteuer',
        tone: 'accent',
        kind: 'erstattungen',
    };
}

/** The one „N Forderungen überfällig" task, or none when no outgoing invoice is overdue. */
export function forderungenTask(input: HomeModelInput): HomeTask | null {
    const n = input.forderungenUeberfaellig ?? 0;
    if (n <= 0) return null;
    return {
        title: forderungenTitel(n),
        sub: 'Offene Ausgangsrechnungen nach Fälligkeit — Mahnung entwerfen, versandt markieren',
        tone: 'warn',
        kind: 'forderungen',
    };
}

/** The one „Laufende Kosten zu bestätigen" task, or none when every series is decided. */
export function laufendeKostenTask(input: HomeModelInput): HomeTask | null {
    const n = input.laufendeKostenOffen ?? 0;
    if (n <= 0) return null;
    return {
        title: zuBestaetigenTitel(n),
        sub: 'Regelmäßige Abbuchungen erkannt — bestätigen, korrigieren oder „keine laufenden Kosten"',
        tone: 'accent',
        kind: 'laufende-kosten',
    };
}

/** One "Als Nächstes" task per finding that has something to do (status `befund` + an action). */
export function hinweisTasks(input: HomeModelInput): HomeTask[] {
    const tasks: HomeTask[] = [];
    for (const h of input.hinweise ?? []) {
        if (h.status !== 'befund' || !h.handlungen?.length) continue;
        if (EIGENE_AUFGABE[h.key]?.(input)) continue;
        const handlung = h.handlungen.find((a) => a.target.art !== 'aktion') ?? h.handlungen[0];
        const first = h.betroffen?.[0]?.zeile;
        const more = (h.betroffen?.length ?? 0) - 1 + (h.betroffenWeitere ?? 0);
        tasks.push({
            title: h.title,
            sub: first ? `${first}${more > 0 ? ` · und ${more} weitere` : ''} — ${handlung.label}` : handlung.label,
            tone: h.level === 'warnung' ? 'warn' : 'accent',
            kind: 'hinweis',
            ref: h.key,
            handlung,
        });
    }
    return tasks;
}

export interface HomeModel {
    year: number;
    kpis: HomeKpis;
    /** Cumulative profit per month (12 values, Jan→Dez) — feeds the KPI sparkline. */
    profitSparkline: number[];
    /** Grouped bar chart source: 12 month labels + the two magnitude series. */
    monthly: { labels: string[]; income: number[]; expense: number[] };
    /** Expense total per category, largest first (top 6). */
    categories: { name: string; amount: number }[];
    liquidity: { now: number; series: number[]; accounts: HomeAccount[] };
    tasks: HomeTask[];
}

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Dashboard fristen that mark a business declaration — their presence means the tax KPI is the
 *  USt+GewSt load; their absence (a `privat` entity with only the `est` frist) means it is
 *  the personal ESt estimate. */
const BUSINESS_FRIST_KEYS = new Set(['ust-jahres', 'feststellung', 'euer', 'gewst']);

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Month index 0..11 from a YYYY-MM-DD booking date, or -1 if unparseable. */
function monthIndex(date: string): number {
    const m = Number(date.slice(5, 7));
    return m >= 1 && m <= 12 ? m - 1 : -1;
}

export function accountName(accountKey: string, source: string, labels?: Record<string, string>): string {
    if (labels?.[accountKey]) return labels[accountKey];
    switch (source) {
        case 'qonto':
            return 'Qonto';
        case 'paypal':
            return 'PayPal';
        case 'fints':
            return 'Bankkonto';
        case 'camt':
            return 'CAMT-Datei';
        default:
            return accountKey;
    }
}

export function buildHomeModel(input: HomeModelInput): HomeModel {
    const { year, txs, dashboard, accountLabels, doppelzahlungVerdacht } = input;
    const yearStr = String(year);
    const yearTxs = txs.filter((t) => t.bookingDate.slice(0, 4) === yearStr);

    // ── monthly income / expense + KPIs + profit sparkline ──
    const income = Array.from({ length: 12 }, () => 0);
    const expense = Array.from({ length: 12 }, () => 0);
    const categoryTotals = new Map<string, number>();
    for (const t of yearTxs) {
        const mi = monthIndex(t.bookingDate);
        if (mi < 0) continue;
        if (t.amount >= 0) {
            income[mi] += t.amount;
        } else {
            const mag = -t.amount;
            expense[mi] += mag;
            const cat = t.category?.trim() || 'Sonstige';
            categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + mag);
        }
    }
    const totalIncome = round2(income.reduce((a, b) => a + b, 0));
    const totalExpense = round2(expense.reduce((a, b) => a + b, 0));

    const profitSparkline: number[] = [];
    let cum = 0;
    for (let m = 0; m < 12; m++) {
        cum += income[m] - expense[m];
        profitSparkline.push(round2(cum));
    }

    const categories = [...categoryTotals.entries()]
        .map(([name, amount]) => ({ name: qontoCategoryLabel(name), amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 6);

    // ── liquidity: all-time per-account balance (movement) + this-year cumulative trend ──
    const accountNet = new Map<string, { net: number; source: string }>();
    for (const t of txs) {
        const cur = accountNet.get(t.accountKey) ?? { net: 0, source: t.source };
        cur.net += t.amount;
        accountNet.set(t.accountKey, cur);
    }
    const accounts: HomeAccount[] = [...accountNet.entries()]
        .map(([key, { net, source }]) => {
            const name = accountName(key, source, accountLabels);
            return { name, initials: name.charAt(0).toUpperCase(), balance: round2(net), source };
        })
        .sort((a, b) => b.balance - a.balance);
    const now = round2(accounts.reduce((s, a) => s + a.balance, 0));

    const series: number[] = [];
    let liq = 0;
    for (let m = 0; m < 12; m++) {
        liq += income[m] - expense[m];
        series.push(round2(liq));
    }

    // ── tax forecast KPI + "Als Nächstes" from the Steuer-Dashboard ──
    let tax: HomeKpis['tax'] = null;
    const tasks: HomeTask[] = [];
    // A hint with `vorrang` (IBAN-Wechsel) leads the list, ahead even of the double payments.
    const vorrang = new Set((input.hinweise ?? []).filter((h) => h.vorrang).map((h) => h.key));
    const hTasks = hinweisTasks(input);
    tasks.push(...hTasks.filter((t) => vorrang.has(t.ref ?? '')));
    for (const v of doppelzahlungVerdacht ?? []) {
        tasks.push({
            title: `Rechnung ${v.rechnungNummer} doppelt bezahlt?`,
            sub: `${fmtDe(v.zuViel)} € zu viel eingegangen${v.teilweise ? ' (teilweise zu viel)' : ''} — klären`,
            tone: 'warn',
            kind: 'doppelzahlung',
            ref: v.rechnungId,
        });
    }
    const zuPruefen = zuPruefenTask(input);
    if (zuPruefen) tasks.push(zuPruefen);
    const erstattungen = erstattungenTask(input);
    if (erstattungen) tasks.push(erstattungen);
    const forderungen = forderungenTask(input);
    if (forderungen) tasks.push(forderungen);
    tasks.push(...hTasks.filter((t) => !vorrang.has(t.ref ?? '')));
    const laufend = laufendeKostenTask(input);
    if (laufend) tasks.push(laufend);
    if (dashboard) {
        const isBusiness = dashboard.fristen.some((f) => BUSINESS_FRIST_KEYS.has(f.key));
        if (isBusiness) {
            const total = round2(dashboard.load.total);
            tax = { total, label: total >= 0 ? 'vsl. Nachzahlung' : 'vsl. Erstattung' };
        } else if (dashboard.estErstattung != null) {
            // Personal ESt entity: the KPI is the ESt result. Convention mirrors the load (+ = Nachzahlung),
            // so negate the estimate (+ Erstattung → − load). A null estimate yields no KPI, never a bogus 0 €.
            const total = round2(-dashboard.estErstattung);
            tax = { total, label: total >= 0 ? 'vsl. Nachzahlung' : 'vsl. Erstattung' };
        }
        for (const f of dashboard.fristen.slice(0, 4)) {
            const amountLabel = f.amount != null && f.amountLabel ? ` · ${f.amountLabel}` : '';
            tasks.push({
                title: f.label,
                sub: `fällig ${f.dueDate}${amountLabel}${f.note ? ` · ${f.note}` : ''}`,
                tone: f.status === 'offen' ? 'warn' : 'accent',
            });
        }
    }

    return {
        year,
        kpis: { income: totalIncome, expense: totalExpense, profit: round2(totalIncome - totalExpense), tax },
        profitSparkline,
        monthly: { labels: MONTHS_DE, income: income.map(round2), expense: expense.map(round2) },
        categories,
        liquidity: { now, series, accounts },
        tasks,
    };
}
