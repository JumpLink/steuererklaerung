/**
 * AfA (Absetzung für Abnutzung) from an Anlageverzeichnis — linear depreciation.
 *
 * The transaction-driven EÜR cannot see AfA: depreciation is a non-cash booking with
 * no bank transaction, so it must be supplied as a year-end adjustment from the asset
 * register (config `adjustments.anlageverzeichnis`). This module is the pure compute:
 * linear AfA = AHK / Nutzungsdauer, pro-rata to the month of a Betriebsaufgabe in the
 * filing year, capped so the book value never drops below the Erinnerungswert.
 *
 * The remaining `restbuchwertEnde` is the carrying value at year/Aufgabe end — the basis
 * for the Betriebsaufgabe-Entnahme (assets withdrawn to private at gemeiner Wert).
 */

import { round2 } from '../lib/money.ts';

/** Anlage-AVEÜR asset class — drives the AfA line + asset-register group in the XML. */
export type AnlagegutArt = 'beweglich' | 'gebaeude';

/** A depreciable fixed asset (mirrors the config Anlagegut, camelCased). */
export interface Anlagegut {
    id: string;
    bezeichnung: string;
    /** Anschaffungs-/Herstellungsdatum (YYYY-MM-DD). */
    anschaffung: string;
    /** Anschaffungs-/Herstellungskosten. */
    ahk: number;
    /** Nutzungsdauer in years (linear AfA = AHK / ND). */
    nutzungsdauerJahre: number;
    /** Restbuchwert at the start of the filing year (Buchwert 01.01.). */
    restbuchwertAnfang: number;
    /** Floor the book value never drops below (1 € Erinnerungswert for kept assets). */
    erinnerungswert: number;
    /** AVEÜR asset class (bewegliche WG vs Gebäude/Einbauten); default 'beweglich'. */
    art: AnlagegutArt;
}

/** Per-AVEÜR-group asset-register totals (Buchwerte + AfA) for one asset class. */
export interface AfaGroupTotals {
    /** Σ Buchwert zu Beginn des Gewinnermittlungszeitraums. */
    buchwertAnfang: number;
    /** Σ AfA des Jahres. */
    afa: number;
    /** Σ Buchwert am Ende = buchwertAnfang − afa. */
    buchwertEnde: number;
}

/** Sum an AfA result's per-asset figures into AVEÜR groups by asset class. */
export function afaGroupTotals(result: AfaResult, art: AnlagegutArt): AfaGroupTotals {
    const inGroup = result.assets.filter((a) => a.art === art);
    const buchwertAnfang = round2(inGroup.reduce((s, a) => s + a.restbuchwertAnfang, 0));
    const afa = round2(inGroup.reduce((s, a) => s + a.afa, 0));
    return { buchwertAnfang, afa, buchwertEnde: round2(buchwertAnfang - afa) };
}

export interface AfaAssetResult extends Anlagegut {
    /** Months depreciated in the filing year (12, or fewer if the business ceased). */
    months: number;
    /** AfA charged this year (pro-rata, capped at restbuchwertAnfang − erinnerungswert). */
    afa: number;
    /** Restbuchwert at year/Aufgabe end (restbuchwertAnfang − afa). */
    restbuchwertEnde: number;
}

export interface AfaResult {
    year: number;
    /** Σ of all assets' AfA for the year. */
    totalAfa: number;
    /** Σ of all assets' Restbuchwert at year/Aufgabe end (Betriebsaufgabe-Entnahme basis). */
    restbuchwertEnde: number;
    assets: AfaAssetResult[];
}

/**
 * Months an asset is depreciated in `year`. Full year = 12; if the business ceased in
 * `year` (businessEndDate), AfA runs pro rata temporis up to and including the end month.
 */
function monthsInYear(year: number, businessEndDate?: string): number {
    if (!businessEndDate) return 12;
    const endYear = Number(businessEndDate.slice(0, 4));
    if (endYear > year) return 12;
    if (endYear < year) return 0;
    return Number(businessEndDate.slice(5, 7)); // 1..12 — month of the last active day
}

/**
 * Compute linear AfA for the filing year from the asset register.
 * @param businessEndDate last day of the Unternehmereigenschaft (YYYY-MM-DD), for pro-rata.
 */
export function computeAfa(assets: Anlagegut[], year: number, businessEndDate?: string): AfaResult {
    const months = monthsInYear(year, businessEndDate);
    const results: AfaAssetResult[] = assets.map((a) => {
        const depreciable = round2(Math.max(0, a.restbuchwertAnfang - a.erinnerungswert));
        const annual = a.nutzungsdauerJahre > 0 ? round2(a.ahk / a.nutzungsdauerJahre) : 0;
        const prorata = round2((annual * months) / 12);
        const afa = Math.min(prorata, depreciable);
        return {
            ...a,
            months,
            afa: round2(afa),
            restbuchwertEnde: round2(a.restbuchwertAnfang - afa),
        };
    });
    return {
        year,
        totalAfa: round2(results.reduce((s, r) => s + r.afa, 0)),
        restbuchwertEnde: round2(results.reduce((s, r) => s + r.restbuchwertEnde, 0)),
        assets: results,
    };
}
