/**
 * Haushaltsrechnung — how much instalment the household actually carries.
 *
 * Two views, deliberately kept side by side rather than collapsed into one number:
 *
 *  - **Ist-Rechnung**: your real income minus your real expenses, dropping what
 *    disappears with the purchase (above all the rent). This is the truth about your
 *    budget.
 *  - **Bank-Sicht**: only income a lender counts, and everyday living costs replaced
 *    by the lender's flat rate. Banks do it this way because they cannot audit your
 *    grocery bill, and their flat rate is usually higher than a frugal household's
 *    actual spend — so this view is the more conservative of the two.
 *
 * Both are reported because the gap between them IS the negotiating room: if the Ist
 * view carries the instalment but the bank view does not, the conversation is about
 * which flat rate the lender applies, not about whether you can afford it.
 */

import type { FinanzierungHaushalt } from '../../config/schema/finanzierung.ts';

/** One side of the household ledger, itemised for display. */
export interface HaushaltPosten {
    bezeichnung: string;
    betragMonat: number;
    /** Where the figure came from, when the config recorded it. */
    quelle?: string;
}

/** The computed Haushaltsrechnung. */
export interface HaushaltsErgebnis {
    /** All income per month. */
    einnahmenGesamt: number;
    /** Only income flagged `sicher` — what a lender will actually count. */
    einnahmenSicher: number;
    /** All expenses per month, as they are today (excluding anything that starts with ownership). */
    ausgabenGesamt: number;
    /** Expenses after the purchase: today's minus what falls away, plus what ownership adds. */
    ausgabenNachKauf: number;
    /** Costs that disappear with the purchase — itemised, because this is the lever. */
    entfallend: HaushaltPosten[];
    /** Costs that only arrive with ownership — Grundsteuer, Versicherung, Instandhaltung. */
    hinzukommend: HaushaltPosten[];
    /** Today's free income: all income − all expenses. */
    freiHeute: number;
    /** Free income after the purchase, Ist-Rechnung. */
    freiNachKauf: number;
    /** The lender's living-cost flat rate for this household size. */
    lebenshaltungPauschale: number;
    /** Free income after the purchase, Bank-Sicht (safe income − flat rate − remaining non-living costs). */
    freiNachKaufBankSicht: number;
    /** The Puffer withheld from the instalment, in euro. */
    puffer: number;
    /** Ist-Rechnung minus Puffer — the instalment the budget carries. */
    tragbareRate: number;
    /** Bank-Sicht minus Puffer — the instalment a lender is likely to grant. */
    tragbareRateBankSicht: number;
}

function round(value: number): number {
    return Math.round(value * 1e2) / 1e2;
}

function sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0);
}

/**
 * Compute the Haushaltsrechnung from the configured household.
 *
 * @param haushalt The entity's `finanzierung.haushalt` block.
 * @returns Both views plus the derived carrying capacity; see {@link HaushaltsErgebnis}.
 */
export function berechneHaushalt(haushalt: FinanzierungHaushalt): HaushaltsErgebnis {
    const einnahmenGesamt = round(sum(haushalt.einnahmen.map((e) => e.betrag_monat)));
    const einnahmenSicher = round(sum(haushalt.einnahmen.filter((e) => e.sicher).map((e) => e.betrag_monat)));

    const posten = (a: (typeof haushalt.ausgaben)[number]): HaushaltPosten => ({
        bezeichnung: a.bezeichnung,
        betragMonat: a.betrag_monat,
        quelle: a.quelle,
    });

    // Today's expenses exclude anything that only starts with ownership.
    const heute = haushalt.ausgaben.filter((a) => !a.erst_nach_kauf);
    const ausgabenGesamt = round(sum(heute.map((a) => a.betrag_monat)));

    // After the purchase: today's that survive, plus the ones ownership brings.
    const bleibend = haushalt.ausgaben.filter((a) => !a.entfaellt_nach_kauf);
    const ausgabenNachKauf = round(sum(bleibend.map((a) => a.betrag_monat)));

    const entfallend: HaushaltPosten[] = haushalt.ausgaben
        .filter((a) => a.entfaellt_nach_kauf && !a.erst_nach_kauf)
        .map(posten);
    const hinzukommend: HaushaltPosten[] = haushalt.ausgaben
        .filter((a) => a.erst_nach_kauf && !a.entfaellt_nach_kauf)
        .map(posten);

    // Bank-Sicht: the flat rate REPLACES the items marked as living costs, so those are
    // excluded here instead of counted twice.
    const lh = haushalt.lebenshaltung;
    const lebenshaltungPauschale = round(
        lh.erster_erwachsener +
            Math.max(0, haushalt.erwachsene - 1) * lh.weiterer_erwachsener +
            haushalt.kinder * lh.kind,
    );
    const ausgabenOhnePauschalePosten = round(sum(bleibend.filter((a) => !a.in_pauschale).map((a) => a.betrag_monat)));

    const freiHeute = round(einnahmenGesamt - ausgabenGesamt);
    const freiNachKauf = round(einnahmenGesamt - ausgabenNachKauf);
    const freiNachKaufBankSicht = round(einnahmenSicher - ausgabenOhnePauschalePosten - lebenshaltungPauschale);

    const pufferFaktor = 1 - haushalt.puffer_prozent / 100;
    const puffer = round(Math.max(0, freiNachKauf) * (haushalt.puffer_prozent / 100));

    return {
        einnahmenGesamt,
        einnahmenSicher,
        ausgabenGesamt,
        ausgabenNachKauf,
        entfallend,
        hinzukommend,
        freiHeute,
        freiNachKauf,
        lebenshaltungPauschale,
        freiNachKaufBankSicht,
        puffer,
        tragbareRate: round(Math.max(0, freiNachKauf) * pufferFaktor),
        tragbareRateBankSicht: round(Math.max(0, freiNachKaufBankSicht) * pufferFaktor),
    };
}
