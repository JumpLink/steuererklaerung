/**
 * BWA (betriebswirtschaftliche Auswertung): a monthly P&L derived from the
 * transaction-driven EÜR. Every classified booking already carries an SKR03-near
 * category + a `kind` (income/expense/neutral); this buckets them by **month** and by
 * **BWA position** (Umsatz → Wareneinsatz → Rohertrag → Betriebskosten → Betriebsergebnis),
 * plus the usual margins. Neutral bookings (Privatentnahmen, interne Übertragungen,
 * USt-Zahllast, Gewerbesteuer, Doppelzahlungen) are NOT part of the operating result.
 *
 * It reads off the SAME aggregate as the EÜR, so the yearly Betriebsergebnis reconciles
 * to the EÜR Gewinn — including the non-cash adjustments (AfA, Privatanteil, dated
 * 31.12.) and the kept post-Aufgabe §24 items (which live in `coverage.outsidePeriod`,
 * not in `detail`). Read-only; nothing is persisted.
 */

import { round2 } from '../lib/money.ts';
import type { EuerKind } from './euer-aggregate.ts';
import { beitragsZeilen, type EuerTxAggregate } from './euer-transactions.ts';

type BwaRole = 'income' | 'direct' | 'cost';

interface BwaGroupDef {
    key: string;
    label: string;
    role: BwaRole;
    /** Leading SKR03 numbers (the token before the first space in a category) routed here. */
    accounts: string[];
}

/** Ordered BWA structure: income, then the direct cost, then the operating cost groups. */
const GROUPS: BwaGroupDef[] = [
    { key: 'umsatz', label: 'Umsatzerlöse', role: 'income', accounts: ['8400', '8300', '8336', '8125'] },
    {
        key: 'sonstige_ertraege',
        label: 'Sonstige betriebl. Erträge',
        role: 'income',
        accounts: ['8500', '8924', '8410'],
    },
    { key: 'wareneinsatz', label: 'Wareneinsatz / Fremdleistungen', role: 'direct', accounts: ['4946'] },
    { key: 'personal', label: 'Personalkosten', role: 'cost', accounts: ['4100', '4138'] },
    { key: 'raumkosten', label: 'Raumkosten', role: 'cost', accounts: ['4210', '4240'] },
    { key: 'versicherung', label: 'Versicherungen / Beiträge', role: 'cost', accounts: ['4360', '4380'] },
    { key: 'kfz', label: 'Kfz-Kosten', role: 'cost', accounts: ['4500'] },
    { key: 'werbung_reise', label: 'Werbung / Reisen / Bewirtung', role: 'cost', accounts: ['4600', '4670', '4654'] },
    { key: 'beratung', label: 'Beratung / Fortbildung', role: 'cost', accounts: ['4950', '4940'] },
    {
        key: 'it_kommunikation',
        label: 'IT / Software / Telefon',
        role: 'cost',
        accounts: ['4806', '4921', '4955', '4964'],
    },
    { key: 'buero', label: 'Bürobedarf', role: 'cost', accounts: ['4930'] },
    { key: 'abschreibungen', label: 'Abschreibungen / GWG', role: 'cost', accounts: ['4830', '0420'] },
    { key: 'sonstige_kosten', label: 'Sonstige Kosten', role: 'cost', accounts: ['4650', '4970', '4655'] },
];

const ACCOUNT_TO_GROUP = new Map<string, BwaGroupDef>();
for (const g of GROUPS) for (const a of g.accounts) ACCOUNT_TO_GROUP.set(a, g);
const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));

/** Route a category to its BWA group; unmapped income/expense fall back to the "Sonstige" buckets. */
function groupFor(category: string, kind: EuerKind): BwaGroupDef | null {
    if (kind === 'neutral') return null;
    const num = category.split(/\s+/)[0];
    return (
        ACCOUNT_TO_GROUP.get(num) ??
        GROUP_BY_KEY.get(kind === 'income' ? 'sonstige_ertraege' : 'sonstige_kosten') ??
        null
    );
}

export type BwaLevel = 'line' | 'subtotal' | 'result' | 'margin';

export interface BwaLine {
    key: string;
    label: string;
    level: BwaLevel;
    role?: BwaRole;
    /** One value per `months` entry. `null` only on a margin where the base is 0. */
    perMonth: Array<number | null>;
    /** Year total (Σ over months); `null` for an undefined margin. */
    total: number | null;
}

export interface BwaResult {
    year: number;
    /** 1-based month numbers that carry any booking, ascending. */
    months: number[];
    lines: BwaLine[];
    totals: {
        gesamtleistung: number;
        rohertrag: number;
        betriebskosten: number;
        betriebsergebnis: number;
    };
}

/**
 * Build the monthly BWA from an EÜR transaction aggregate (needs `detail` — i.e. the
 * aggregate produced with `{ detail: true }`). The yearly `betriebsergebnis` equals the
 * EÜR `totals.profit`.
 */
export function computeBwa(agg: EuerTxAggregate, year: number): BwaResult {
    const rows: Array<{ month: number; key: string; net: number }> = [];
    const add = (bookingDate: string, category: string, kind: EuerKind, net: number) => {
        const g = groupFor(category, kind);
        const month = Number(bookingDate.slice(5, 7));
        if (!g || !month) return;
        rows.push({ month, key: g.key, net });
    };
    for (const d of beitragsZeilen(agg.detail ?? [])) add(d.bookingDate, d.category, d.kind, d.net);
    // Kept post-Aufgabe §24 items live here (not in detail) but ARE in totals.profit.
    for (const o of agg.coverage.outsidePeriod) if (o.included) add(o.bookingDate, o.category, o.kind, o.net);

    const months = [...new Set(rows.map((r) => r.month))].sort((a, b) => a - b);
    const idx = new Map(months.map((m, i) => [m, i]));
    const zero = () => months.map(() => 0);

    const groupPM = new Map<string, number[]>(GROUPS.map((g) => [g.key, zero()]));
    for (const r of rows) {
        const arr = groupPM.get(r.key);
        if (arr) arr[idx.get(r.month) as number] = round2(arr[idx.get(r.month) as number] + r.net);
    }

    const sumOf = (a: number[]) => round2(a.reduce((s, x) => s + x, 0));
    const sumRoles = (...roles: BwaRole[]): number[] =>
        months.map((_, i) =>
            round2(
                GROUPS.filter((g) => roles.includes(g.role)).reduce(
                    (s, g) => s + (groupPM.get(g.key) as number[])[i],
                    0,
                ),
            ),
        );

    const gesamt = sumRoles('income');
    const direkt = sumRoles('direct');
    const rohertrag = months.map((_, i) => round2(gesamt[i] - direkt[i]));
    const kosten = sumRoles('cost');
    const ergebnis = months.map((_, i) => round2(rohertrag[i] - kosten[i]));

    const nonZero = (pm: number[]) => pm.some((v) => Math.abs(v) > 0.005);
    const groupLine = (g: BwaGroupDef): BwaLine => {
        const pm = groupPM.get(g.key) as number[];
        return { key: g.key, label: g.label, level: 'line', role: g.role, perMonth: pm, total: sumOf(pm) };
    };
    const subtotal = (key: string, label: string, pm: number[], level: BwaLevel = 'subtotal'): BwaLine => ({
        key,
        label,
        level,
        perMonth: pm,
        total: sumOf(pm),
    });
    const margin = (key: string, label: string, num: number[], den: number[]): BwaLine => ({
        key,
        label,
        level: 'margin',
        perMonth: num.map((n, i) => (Math.abs(den[i]) > 0.005 ? round2(n / den[i]) : null)),
        total: Math.abs(sumOf(den)) > 0.005 ? round2(sumOf(num) / sumOf(den)) : null,
    });

    const lines: BwaLine[] = [];
    for (const g of GROUPS)
        if (g.role === 'income' && nonZero(groupPM.get(g.key) as number[])) lines.push(groupLine(g));
    lines.push(subtotal('gesamtleistung', 'Gesamtleistung', gesamt));
    const hasDirect = GROUPS.some((g) => g.role === 'direct' && nonZero(groupPM.get(g.key) as number[]));
    if (hasDirect) {
        for (const g of GROUPS) if (g.role === 'direct') lines.push(groupLine(g));
        lines.push(subtotal('rohertrag', 'Rohertrag', rohertrag));
        lines.push(margin('rohertragsquote', 'Rohertragsquote', rohertrag, gesamt));
    }
    for (const g of GROUPS) if (g.role === 'cost' && nonZero(groupPM.get(g.key) as number[])) lines.push(groupLine(g));
    lines.push(subtotal('betriebskosten', 'Summe Betriebskosten', kosten));
    lines.push(subtotal('betriebsergebnis', 'Betriebsergebnis', ergebnis, 'result'));
    lines.push(margin('umsatzrendite', 'Umsatzrendite', ergebnis, gesamt));

    return {
        year,
        months,
        lines,
        totals: {
            gesamtleistung: sumOf(gesamt),
            rohertrag: sumOf(rohertrag),
            betriebskosten: sumOf(kosten),
            betriebsergebnis: sumOf(ergebnis),
        },
    };
}
