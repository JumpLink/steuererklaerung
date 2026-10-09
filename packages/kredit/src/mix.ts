/**
 * Financing mix — several loan tranches running in parallel.
 *
 * A German property purchase is almost never one loan. It is a promotional
 * tranche (KfW, a Landesförderbank) at a low rate and a short term, plus bank
 * money at the market rate, sometimes plus a non-repayable grant. Each tranche
 * has its own rate, its own repayment and its own end date, so the monthly
 * burden is **not constant** — it steps.
 *
 * Computing the tranches separately and adding up the instalments is exactly
 * what hides the two things that matter:
 *
 * 1. **The step when a tilgungsfreie Anlaufzeit ends.** A KfW tranche that pays
 *    interest only for five years looks affordable until month 61, when the
 *    instalment jumps and the principal is still untouched. Affordability has to
 *    be checked against the *highest* burden, not the first one.
 * 2. **The step when a short tranche is repaid** — that one goes the friendly
 *    way, and it is worth seeing too.
 *
 * {@link finanzierungsmix} therefore returns the burden month by month plus the
 * steps in it, and — unlike a per-tranche view — a single blended rate and a
 * combined residual debt.
 *
 * Objektfrei like the rest of this package: tranches, rates and euros, no
 * borrower and no property.
 */

import { cent, restschuldNach, tilgungsplan } from './tilgungsplan.ts';
import type { DarlehenInput, Tilgungsplan } from './types.ts';

/** One tranche of a financing mix — a loan plus an identity. */
export interface Tranche extends DarlehenInput {
    key: string;
    /** Human label, e.g. "KfW 308 Jung kauft Alt". */
    name: string;
    /**
     * Non-repayable grant tied to this tranche (a Zuschuss, e.g. NBank's
     * Kinderzuschuss). It covers part of the requirement but is never repaid, so
     * it carries no instalment and no interest. Kept on the tranche rather than
     * as a separate concept because it comes from the same programme.
     */
    zuschuss?: number;
}

/** The combined burden in one month. */
export interface MixMonat {
    monat: number;
    jahr: number;
    /** Sum of the instalments of all tranches still running. */
    rate: number;
    zins: number;
    tilgung: number;
    /** Combined debt left after this month. */
    restschuld: number;
}

/** A point where the monthly burden changes. */
export interface MixStufe {
    monat: number;
    jahr: number;
    rateVorher: number;
    rateNachher: number;
    /** What changed, in plain German. */
    grund: string;
}

export interface TrancheErgebnis {
    key: string;
    name: string;
    betrag: number;
    zuschuss: number;
    sollzins: number;
    /** Share of the borrowed total (grants excluded), 0..1. */
    anteil: number;
    plan: Tilgungsplan;
}

export interface MixErgebnis {
    tranchen: TrancheErgebnis[];
    /** Sum of the borrowed amounts (grants excluded). */
    summeDarlehen: number;
    /** Sum of the non-repayable grants. */
    summeZuschuss: number;
    /** What the mix actually provides: borrowed + granted. */
    deckung: number;
    /** `bedarf − deckung`; positive means a gap, negative means over-financed. `null` without a `bedarf`. */
    luecke: number | null;
    /** Burden in month 1 — the number a bank advisor quotes. */
    startRate: number;
    /** Highest monthly burden over the whole term — the number affordability must be checked against. */
    maxRate: number;
    /** Month in which {@link maxRate} first occurs. */
    maxRateMonat: number;
    /** Blended nominal rate, weighted by amount, in percent p.a. */
    mischzins: number;
    monate: MixMonat[];
    stufen: MixStufe[];
    summeZins: number;
    /** Months until every tranche is repaid; `null` if one of them never is. */
    laufzeitMonate: number | null;
}

export interface FinanzierungsmixInput {
    tranchen: Tranche[];
    /** Total capital requirement, to check the mix against. Optional. */
    bedarf?: number;
    /** Safety stop for the simulation in years; default 50. */
    maxJahre?: number;
}

/** A step smaller than this is rounding noise, not a change in the burden. */
const STUFE_SCHWELLE = 1;

/**
 * Combine tranches into one financing.
 *
 * @param input The tranches, and optionally the requirement to check against.
 * @returns The combined burden month by month, its steps, and the aggregates.
 * @throws If no tranche is given, or a tranche is invalid (see {@link tilgungsplan}).
 */
export function finanzierungsmix(input: FinanzierungsmixInput): MixErgebnis {
    const { tranchen, maxJahre = 50 } = input;
    if (tranchen.length === 0) throw new Error('Ein Finanzierungsmix braucht mindestens eine Tranche.');

    const plaene = tranchen.map((t) => ({ tranche: t, plan: tilgungsplan({ ...t, maxJahre }) }));

    const summeDarlehen = cent(tranchen.reduce((s, t) => s + t.betrag, 0));
    const summeZuschuss = cent(tranchen.reduce((s, t) => s + (t.zuschuss ?? 0), 0));
    const deckung = cent(summeDarlehen + summeZuschuss);

    const trancheErgebnisse: TrancheErgebnis[] = plaene.map(({ tranche, plan }) => ({
        key: tranche.key,
        name: tranche.name,
        betrag: cent(tranche.betrag),
        zuschuss: cent(tranche.zuschuss ?? 0),
        sollzins: tranche.sollzins,
        anteil: summeDarlehen > 0 ? tranche.betrag / summeDarlehen : 0,
        plan,
    }));

    // Longest tranche decides how far the combined schedule runs. A tranche that
    // never amortises has no rows, so fall back to the simulation limit.
    const maxMonate = Math.max(
        ...plaene.map(({ plan }) => (plan.zeilen.length > 0 ? plan.zeilen.length : Math.round(maxJahre * 12))),
    );

    const monate: MixMonat[] = [];
    for (let monat = 1; monat <= maxMonate; monat++) {
        let rate = 0;
        let zins = 0;
        let tilgungAnteil = 0;
        let restschuld = 0;
        for (const { plan } of plaene) {
            const z = plan.zeilen[monat - 1];
            if (!z) continue; // this tranche is already repaid
            rate += z.rate + z.sondertilgung;
            zins += z.zins;
            tilgungAnteil += z.tilgung + z.sondertilgung;
            restschuld += z.restschuld;
        }
        monate.push({
            monat,
            jahr: Math.ceil(monat / 12),
            rate: cent(rate),
            zins: cent(zins),
            tilgung: cent(tilgungAnteil),
            restschuld: cent(restschuld),
        });
    }

    const stufen = findeStufen(monate, plaene);

    let maxRate = 0;
    let maxRateMonat = 0;
    for (const m of monate) {
        if (m.rate > maxRate) {
            maxRate = m.rate;
            maxRateMonat = m.monat;
        }
    }

    const alleGetilgt = plaene.every(({ plan }) => plan.laufzeitMonate !== null);
    const laufzeitMonate = alleGetilgt
        ? Math.max(...plaene.map(({ plan }) => plan.laufzeitMonate ?? 0))
        : null;

    return {
        tranchen: trancheErgebnisse,
        summeDarlehen,
        summeZuschuss,
        deckung,
        luecke: input.bedarf !== undefined ? cent(input.bedarf - deckung) : null,
        startRate: monate.length > 0 ? monate[0].rate : 0,
        maxRate,
        maxRateMonat,
        mischzins:
            summeDarlehen > 0
                ? Math.round((tranchen.reduce((s, t) => s + t.betrag * t.sollzins, 0) / summeDarlehen) * 1000) / 1000
                : 0,
        monate,
        stufen,
        summeZins: cent(plaene.reduce((s, { plan }) => s + plan.summeZins, 0)),
        laufzeitMonate,
    };
}

/**
 * Find the months where the combined burden changes, and say why.
 *
 * The reason matters more than the number: a step up because an interest-only
 * period ended is a planning problem, a step down because a tranche is repaid is
 * a relief. Both are attributed to the tranche that caused them.
 */
function findeStufen(
    monate: MixMonat[],
    plaene: { tranche: Tranche; plan: Tilgungsplan }[],
): MixStufe[] {
    const stufen: MixStufe[] = [];
    for (let i = 1; i < monate.length; i++) {
        const vorher = monate[i - 1].rate;
        const nachher = monate[i].rate;
        if (Math.abs(nachher - vorher) < STUFE_SCHWELLE) continue;

        const monat = monate[i].monat;
        const gruende: string[] = [];
        for (const { tranche, plan } of plaene) {
            const anlaufMonate = Math.round((tranche.tilgungsfreieAnlaufjahre ?? 0) * 12);
            if (anlaufMonate > 0 && monat === anlaufMonate + 1) {
                gruende.push(`${tranche.name}: tilgungsfreie Anlaufzeit endet, Tilgung setzt ein`);
            }
            if (plan.laufzeitMonate !== null && monat === plan.laufzeitMonate + 1) {
                gruende.push(`${tranche.name}: abbezahlt`);
            }
        }
        stufen.push({
            monat,
            jahr: monate[i].jahr,
            rateVorher: vorher,
            rateNachher: nachher,
            grund: gruende.length > 0 ? gruende.join('; ') : 'letzte Rate einer Tranche',
        });
    }
    return stufen;
}

/**
 * Combined debt left after a given number of years — the figure an
 * Anschlussfinanzierung has to cover.
 *
 * @param ergebnis A computed {@link MixErgebnis}.
 * @param jahre Years to look ahead.
 */
export function mixRestschuldNach(ergebnis: MixErgebnis, jahre: number): number {
    return cent(
        ergebnis.tranchen.reduce((sum, t) => sum + restschuldNach(t.plan, jahre), 0),
    );
}
