/**
 * Gewerbesteuer (GewSt 1 A) — Gewerbeertrag → Steuermessbetrag computation.
 *
 * For a small Dienstleistungs-GbR the profit is typically far below the €24.500
 * Freibetrag for Personengesellschaften, so the Messbetrag is €0 — but the
 * declaration is still filed. The §8 Hinzurechnungen / §9 Kürzungen are de-minimis at
 * this scale (a services GbR is far under the €200.000 financing Freibetrag and owns
 * no business property) and default to 0; they are exposed as config so future years /
 * the JumpLink reuse can fill them. Pure + unit-tested; the XML builder consumes the
 * result.
 */

import { round2 } from '../lib/money.ts';

/** §8 GewStG Hinzurechnungen (add-backs). Each field optional, defaults to 0. */
export interface GewstHinzurechnungen {
    /**
     * §8 Nr.1: SUM of the financing components (interest + the statutory fractions of
     * rents/leases/licences) BEFORE the €200.000 Freibetrag and the 25 % factor — the
     * computation applies both. A small services business stays well under €200.000.
     */
    finanzierungsanteile?: number;
    /** §8 Nr.5: Streubesitzdividenden (added back in full). */
    streubesitzdividenden?: number;
    /** §8 Nr.8: Verlustanteile aus anderen Personengesellschaften. */
    verlustanteilePersGes?: number;
    /** Any further §8 add-backs, summed in verbatim. */
    sonstige?: number;
}

/** §9 GewStG Kürzungen (deductions). Each field optional, defaults to 0. */
export interface GewstKuerzungen {
    /** §9 Nr.1: 1,2 % of the Einheitswert of business real property (none here). */
    grundbesitz?: number;
    /** §9 Nr.2: Gewinnanteile aus anderen Personengesellschaften. */
    gewinnanteilePersGes?: number;
    /** §9 Nr.5: abziehbare Spenden. */
    spenden?: number;
    /** Any further §9 deductions, summed in verbatim. */
    sonstige?: number;
}

export interface GewstInputs {
    /** Gewerbeertrag start value = the EÜR Gewinn (EuerTxAggregate.totals.profit). */
    profit: number;
    hinzurechnungen?: GewstHinzurechnungen;
    kuerzungen?: GewstKuerzungen;
    /** Gemeinde Hebesatz in percent (e.g. 480). Only affects the informational GewSt. */
    hebesatz: number;
    /** Gemeinde name / AGS, for the declaration. */
    gemeinde: string;
    year: number;
}

export interface GewstResult {
    sumHinzurechnungen: number;
    sumKuerzungen: number;
    /** profit + Σ§8 − Σ§9. */
    gewerbeertrag: number;
    /** Gewerbeertrag abgerundet auf volle 100 € (§11 Abs.1 S.3). */
    gewerbeertragRounded: number;
    /** €24.500 Freibetrag for Personengesellschaften (§11 Abs.1 Nr.1). */
    freibetrag: number;
    /** max(0, gewerbeertragRounded − Freibetrag). */
    bemessungsgrundlage: number;
    /** Steuermesszahl 3,5 % (§11 Abs.2). */
    steuermesszahl: number;
    /** Steuermessbetrag = Bemessungsgrundlage × 3,5 %. €0 here. */
    messbetrag: number;
    /** Informational: Messbetrag × Hebesatz/100 (the levying Gemeinde sets this). */
    gewerbesteuer: number;
}

/** §8 Nr.1: only 25 % of the financing sum exceeding €200.000 is added back. */
const FINANZIERUNG_FREIBETRAG = 200_000;
const FREIBETRAG_PERSGES = 24_500;
const STEUERMESSZAHL = 0.035;

function sumHinzurechnungen(h: GewstHinzurechnungen | undefined): number {
    if (!h) return 0;
    const fin = h.finanzierungsanteile ?? 0;
    const finAddBack = 0.25 * Math.max(0, fin - FINANZIERUNG_FREIBETRAG);
    return round2(finAddBack + (h.streubesitzdividenden ?? 0) + (h.verlustanteilePersGes ?? 0) + (h.sonstige ?? 0));
}

function sumKuerzungen(k: GewstKuerzungen | undefined): number {
    if (!k) return 0;
    return round2((k.grundbesitz ?? 0) + (k.gewinnanteilePersGes ?? 0) + (k.spenden ?? 0) + (k.sonstige ?? 0));
}

export function computeGewst(inputs: GewstInputs): GewstResult {
    const sumHinz = sumHinzurechnungen(inputs.hinzurechnungen);
    const sumKuerz = sumKuerzungen(inputs.kuerzungen);
    const gewerbeertrag = round2(inputs.profit + sumHinz - sumKuerz);
    // §11 Abs.1 S.3: round the Gewerbeertrag DOWN to full €100 (only meaningful when positive).
    const gewerbeertragRounded = gewerbeertrag >= 0 ? Math.floor(gewerbeertrag / 100) * 100 : gewerbeertrag;
    const bemessungsgrundlage = Math.max(0, gewerbeertragRounded - FREIBETRAG_PERSGES);
    const messbetrag = round2(bemessungsgrundlage * STEUERMESSZAHL);
    const gewerbesteuer = round2((messbetrag * inputs.hebesatz) / 100);
    return {
        sumHinzurechnungen: sumHinz,
        sumKuerzungen: sumKuerz,
        gewerbeertrag,
        gewerbeertragRounded,
        freibetrag: FREIBETRAG_PERSGES,
        bemessungsgrundlage,
        steuermesszahl: STEUERMESSZAHL,
        messbetrag,
        gewerbesteuer,
    };
}
