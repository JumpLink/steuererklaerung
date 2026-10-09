/**
 * Gesonderte und einheitliche Feststellung (GbR) — profit allocation.
 *
 * A Personengesellschaft's profit is determined once at the entity level (the EÜR
 * Gewinn) and then allocated to the Gesellschafter by their Beteiligungsquote; each
 * partner declares their share in their personal Einkommensteuererklärung.
 *
 * This module is the pure allocation core. The interim filing path renders a
 * "Feststellungs-Datenblatt" from it (manual entry into Mein ELSTER) paired with the
 * Anlage-EÜR XML; the later full Feststellung XML generator (DatenArt `Feststellung`,
 * schema FEIN_90_2025) reuses the exact same allocation.
 */

import { round2 } from '../lib/money.ts';

/** A partner of the GbR. Identity + Beteiligungsquote. PRIVATE data — config-only. */
export interface Gesellschafter {
    /** Stable key, e.g. 'partner1'. */
    id: string;
    name: string;
    /** 11-digit persönliche Steuer-IdNr (NOT the GbR Steuernummer). */
    steuerId: string;
    /** Beteiligungsquote as a fraction; the quotes across all partners sum to 1. */
    quote: number;
    /** The partner's personal Finanzamt (for Anlage FE), optional. */
    finanzamt?: string;
}

export interface FeststellungAllocation {
    gesellschafter: Gesellschafter;
    /** round2(totalProfit × quote), adjusted so the shares sum exactly to totalProfit. */
    laufenderAnteil: number;
    /** The partner's Sonderbetriebsausgaben (e.g. häusliches Arbeitszimmer), ≥ 0. */
    sonderbetriebsausgaben: number;
    /** Zuzurechnende laufende Einkünfte = laufenderAnteil − sonderbetriebsausgaben. */
    profitShare: number;
    /** The partner's share of the Aufgabegewinn/-verlust (§16/§34), by quote. */
    aufgabegewinnAnteil: number;
    /** Total Einkünfte aus Gewerbebetrieb = profitShare + aufgabegewinnAnteil. */
    gesamtAnteil: number;
}

export interface FeststellungResult {
    year: number;
    /** The entity-level EÜR Gewinn (laufende Einkünfte) that gets allocated. */
    totalProfit: number;
    /** Σ of the partners' zuzurechnende laufende Einkünfte = totalProfit − Σ Sonderbetriebsausgaben. */
    festgestellteEinkuenfte: number;
    /** Aufgabegewinn/-verlust (§16/§34), 0 if no Betriebsaufgabe. */
    aufgabegewinn: number;
    /** Total Einkünfte aus Gewerbebetrieb = festgestellteEinkuenfte + aufgabegewinn. */
    einkuenfteGesamt: number;
    allocations: FeststellungAllocation[];
    rounding: {
        /** Σ of the raw round2 laufende shares before the residual fix. */
        rawSum: number;
        /** totalProfit − rawSum, assigned to the largest laufende share. */
        residual: number;
    };
}

const QUOTE_EPSILON = 1e-6;

/**
 * Allocate `totalProfit` across the Gesellschafter by quote. Asserts the quotes sum
 * to 1, and assigns the rounding residual to the largest share so the allocation sums
 * back to `totalProfit` exactly (to the cent).
 */
export function computeFeststellung(
    totalProfit: number,
    gesellschafter: Gesellschafter[],
    year: number,
    sonderbetriebsausgaben: Record<string, number> = {},
    aufgabegewinn = 0,
): FeststellungResult {
    if (gesellschafter.length === 0) {
        throw new Error('computeFeststellung: no Gesellschafter configured.');
    }
    const quoteSum = gesellschafter.reduce((s, g) => s + g.quote, 0);
    if (Math.abs(quoteSum - 1) > QUOTE_EPSILON) {
        throw new Error(`Gesellschafter quotes must sum to 1, got ${quoteSum}.`);
    }

    // The partner with the largest quote absorbs each rounding residual.
    let maxIdx = 0;
    for (let i = 1; i < gesellschafter.length; i++) {
        if (gesellschafter[i].quote > gesellschafter[maxIdx].quote) maxIdx = i;
    }
    /** Split an amount by quote (round2), assigning the residual to the largest quote. */
    const splitByQuote = (amount: number): number[] => {
        const shares = gesellschafter.map((g) => round2(amount * g.quote));
        const residual = round2(amount - round2(shares.reduce((s, x) => s + x, 0)));
        if (residual !== 0) shares[maxIdx] = round2(shares[maxIdx] + residual);
        return shares;
    };

    const laufendeShares = gesellschafter.map((g) => round2(totalProfit * g.quote));
    const rawSum = round2(laufendeShares.reduce((s, x) => s + x, 0));
    const residual = round2(totalProfit - rawSum);
    if (residual !== 0) laufendeShares[maxIdx] = round2(laufendeShares[maxIdx] + residual);
    const aufgabeShares =
        round2(aufgabegewinn) !== 0 ? splitByQuote(round2(aufgabegewinn)) : gesellschafter.map(() => 0);

    const allocations: FeststellungAllocation[] = gesellschafter.map((g, i) => {
        const sba = round2(sonderbetriebsausgaben[g.id] ?? 0);
        const profitShare = round2(laufendeShares[i] - sba);
        return {
            gesellschafter: g,
            laufenderAnteil: laufendeShares[i],
            sonderbetriebsausgaben: sba,
            profitShare,
            aufgabegewinnAnteil: aufgabeShares[i],
            gesamtAnteil: round2(profitShare + aufgabeShares[i]),
        };
    });

    const festgestellteEinkuenfte = round2(allocations.reduce((s, a) => s + a.profitShare, 0));
    const aufgabe = round2(aufgabegewinn);
    return {
        year,
        totalProfit,
        festgestellteEinkuenfte,
        aufgabegewinn: aufgabe,
        einkuenfteGesamt: round2(festgestellteEinkuenfte + aufgabe),
        allocations,
        rounding: { rawSum, residual },
    };
}
