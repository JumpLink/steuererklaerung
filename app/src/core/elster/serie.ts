/**
 * Series detection: same party, same amount, fixed interval — monthly, quarterly, half-yearly or
 * yearly, each ± a few days. From {@link SERIE_MIN_TREFFER} hits on it is probably a subscription, rent
 * or insurance and no duplicate. The Geld-Prüfungen (Idee 7 in docs/ideen-nutzerfuehrung.md) exclude
 * series with it.
 *
 * „Laufende Kosten erkennen" (Idee 8) uses {@link findeSerienMitDrift}: the same chains, but the amount
 * may move by a share from one hit to the next (a price change), and the minimum hits are given per
 * interval.
 *
 * Pure: items in, series out. An item off the beat (say a second debit two days after the monthly
 * rate) belongs to no series and stays visible to the checks.
 */

import { dayDiff } from '../lib/transactions/reconcile.ts';

export type SerienAbstand = 'monatlich' | 'vierteljaehrlich' | 'halbjaehrlich' | 'jaehrlich';

/** Hits from which equal amounts at a fixed interval count as a series — an app threshold, not a legal
 *  number (docs/references/tax-sources.md, „Geld-Prüfungen"). */
export const SERIE_MIN_TREFFER = 3;

/** Days an item may miss its expected date by (weekends, bank holidays). */
export const SERIE_TOLERANZ_TAGE = 5;

/** Months per interval. */
export const ABSTAND_MONATE: Record<SerienAbstand, number> = {
    monatlich: 1,
    vierteljaehrlich: 3,
    halbjaehrlich: 6,
    jaehrlich: 12,
};

/** Shortest interval first: a monthly subscription is not also a quarterly series. */
const ABSTAENDE = Object.entries(ABSTAND_MONATE) as [SerienAbstand, number][];

export interface SerienPosten {
    id: string;
    /** YYYY-MM-DD. */
    datum: string;
    /** EUR; the sign counts (a debit is no credit). */
    betrag: number;
    /** Recipient or sender as written — compared by {@link parteiSchluessel}. */
    partei: string;
}

export interface Serie {
    /** The normalised name ({@link parteiSchluessel}). */
    partei: string;
    betrag: number;
    abstand: SerienAbstand;
    /** The series' items, oldest first. */
    ids: string[];
    von: string;
    bis: string;
}

/**
 * Comparison key for a name: lower case, letters and digits only. „HETZNER ONLINE GMBH" and „Hetzner
 * Online GmbH" are then the same party; „Hetzner" alone is another.
 */
export function parteiSchluessel(name: string | null | undefined): string {
    return (name ?? '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
}

/**
 * Whether two names mean the same party: equal keys, or one contained in the other („Hetzner" on the
 * invoice, „Hetzner Online GmbH" on the debit).
 */
export function gleichePartei(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = parteiSchluessel(a);
    const y = parteiSchluessel(b);
    return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/** `iso` plus `n` months, the day clamped to the month's last (31 Jan + 1 → 28/29 Feb). */
export function plusMonate(iso: string, n: number): string {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7)) - 1 + n;
    const d = Number(iso.slice(8, 10));
    const zy = y + Math.floor(m / 12);
    const zm = ((m % 12) + 12) % 12;
    const letzter = new Date(Date.UTC(zy, zm + 1, 0)).getUTCDate();
    return `${zy}-${String(zm + 1).padStart(2, '0')}-${String(Math.min(d, letzter)).padStart(2, '0')}`;
}

/**
 * Chains at `monate` intervals: each item joins the chain whose next date it fits best — and, when
 * given, whose last item it `passt` to (the amount check of the drift variant).
 */
function ketten(
    posten: SerienPosten[],
    monate: number,
    passt?: (letzter: SerienPosten, p: SerienPosten) => boolean,
): SerienPosten[][] {
    const out: SerienPosten[][] = [];
    for (const p of posten) {
        let best: { kette: SerienPosten[]; abw: number } | undefined;
        for (const k of out) {
            const letzter = k[k.length - 1];
            if (p.datum <= letzter.datum) continue;
            if (passt && !passt(letzter, p)) continue;
            const abw = Math.abs(dayDiff(p.datum, plusMonate(letzter.datum, monate)) ?? Infinity);
            if (abw <= SERIE_TOLERANZ_TAGE && (!best || abw < best.abw)) best = { kette: k, abw };
        }
        if (best) best.kette.push(p);
        else out.push([p]);
    }
    return out;
}

/** Items grouped by `key`, only well-formed ones (a party and a date). */
function gruppiere(posten: readonly SerienPosten[], key: (p: SerienPosten, partei: string) => string) {
    const gruppen = new Map<string, SerienPosten[]>();
    for (const p of posten) {
        const partei = parteiSchluessel(p.partei);
        if (!partei || !/^\d{4}-\d{2}-\d{2}/.test(p.datum)) continue;
        const k = key(p, partei);
        const g = gruppen.get(k) ?? [];
        g.push(p);
        gruppen.set(k, g);
    }
    return gruppen.values();
}

/** The chains of one group, shortest interval first; an item joins at most one chain. */
function serienDerGruppe(
    g: SerienPosten[],
    minTreffer: (a: SerienAbstand) => number,
    passt?: (letzter: SerienPosten, p: SerienPosten) => boolean,
): { abstand: SerienAbstand; posten: SerienPosten[] }[] {
    const mindestens = Math.min(...ABSTAENDE.map(([a]) => minTreffer(a)));
    if (g.length < mindestens) return [];
    const out: { abstand: SerienAbstand; posten: SerienPosten[] }[] = [];
    let rest = [...g].sort((a, b) => a.datum.localeCompare(b.datum) || a.id.localeCompare(b.id));
    for (const [abstand, monate] of ABSTAENDE) {
        const vergeben = new Set<string>();
        for (const k of ketten(rest, monate, passt)) {
            if (k.length < minTreffer(abstand)) continue;
            out.push({ abstand, posten: k });
            for (const p of k) vergeben.add(p.id);
        }
        rest = rest.filter((p) => !vergeben.has(p.id));
        if (rest.length < mindestens) break;
    }
    return out;
}

/** Every series among the items. An item belongs to at most one series. */
export function findeSerien(posten: readonly SerienPosten[]): Serie[] {
    const serien: Serie[] = [];
    for (const g of gruppiere(posten, (p, partei) => `${partei}|${Math.round(p.betrag * 100)}`)) {
        for (const { abstand, posten: k } of serienDerGruppe(g, () => SERIE_MIN_TREFFER)) {
            serien.push({
                partei: parteiSchluessel(k[0].partei),
                betrag: k[0].betrag,
                abstand,
                ids: k.map((p) => p.id),
                von: k[0].datum,
                bis: k[k.length - 1].datum,
            });
        }
    }
    return serien;
}

/** A series whose amount may drift; the items carry their own amounts. */
export interface DriftSerie {
    partei: string;
    abstand: SerienAbstand;
    /** Oldest first. */
    posten: SerienPosten[];
}

/**
 * Series per party whose amount may move from one hit to the next by at most `driftAnteil` of the
 * previous amount (same sign) — a price change keeps the series, a different product of the same
 * party starts its own. `minTreffer` gives the hits each interval needs.
 */
export function findeSerienMitDrift(
    posten: readonly SerienPosten[],
    opts: { driftAnteil: number; minTreffer: (abstand: SerienAbstand) => number },
): DriftSerie[] {
    const passt = (letzter: SerienPosten, p: SerienPosten) =>
        Math.sign(letzter.betrag) === Math.sign(p.betrag) &&
        Math.abs(p.betrag - letzter.betrag) <= Math.abs(letzter.betrag) * opts.driftAnteil + 0.005;
    const serien: DriftSerie[] = [];
    for (const g of gruppiere(posten, (_p, partei) => partei)) {
        for (const { abstand, posten: k } of serienDerGruppe(g, opts.minTreffer, passt)) {
            serien.push({ partei: parteiSchluessel(k[0].partei), abstand, posten: k });
        }
    }
    return serien;
}

/** The ids of every item that belongs to a series. */
export function serienIds(serien: readonly Serie[]): Set<string> {
    return new Set(serien.flatMap((s) => s.ids));
}
