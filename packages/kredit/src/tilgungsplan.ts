/**
 * Annuitätendarlehen — instalment, amortisation schedule and the derived figures a
 * bank conversation actually turns on (Restschuld nach Zinsbindung, Laufzeit,
 * Gesamtzins).
 *
 * The model is the standard German Annuitätendarlehen with monthly instalments and
 * monthly interest accrual: each month the interest is charged on the current debt,
 * the rest of the instalment repays it, so the repayment share grows over time.
 * Sondertilgungen are booked at the end of a full year, which is what most contracts
 * allow.
 *
 * Rounding: every amount is rounded to cents on the way out, but the simulation runs
 * on unrounded values so a 30-year schedule does not drift.
 */

import type { DarlehenInput, JahresZeile, TilgungsZeile, Tilgungsplan } from './types.ts';

/** Round to cents — used for every figure that leaves this module. */
export function cent(value: number): number {
    return Math.round(value * 1e2) / 1e2;
}

/**
 * The regular monthly instalment of an Annuitätendarlehen.
 *
 * Rate = Betrag · (Sollzins + Tilgung) / 100 / 12 — the German convention, where the
 * quoted "2 % Tilgung" means 2 % of the *initial* amount in the first year.
 *
 * @param betrag Nettodarlehensbetrag in euro.
 * @param sollzins Nominal rate p.a. in percent.
 * @param tilgung Initial repayment rate p.a. in percent.
 * @returns The monthly instalment in euro, rounded to cents.
 */
export function annuitaet(betrag: number, sollzins: number, tilgung: number): number {
    return cent((betrag * (sollzins + tilgung)) / 100 / 12);
}

/**
 * Invert {@link annuitaet}: the largest loan a given monthly instalment carries.
 *
 * This is the number to compare against the Haushaltsrechnung — "I can pay X per
 * month, what does that buy me at this rate?".
 *
 * @param rate Affordable monthly instalment in euro.
 * @param sollzins Nominal rate p.a. in percent.
 * @param tilgung Initial repayment rate p.a. in percent.
 * @returns The loan amount in euro, rounded to cents.
 */
export function maxDarlehen(rate: number, sollzins: number, tilgung: number): number {
    if (sollzins + tilgung <= 0) throw new Error('Sollzins + Tilgung muss > 0 sein.');
    return cent((rate * 12 * 100) / (sollzins + tilgung));
}

/**
 * Simulate the full amortisation schedule.
 *
 * Runs month by month until the debt is repaid or `maxJahre` is reached — whichever
 * comes first. A loan whose instalment does not even cover the interest never
 * amortises; that is reported as `laufzeitMonate: null` rather than looping forever.
 *
 * @param input The loan parameters; see {@link DarlehenInput}.
 * @returns The schedule plus the aggregate figures; see {@link Tilgungsplan}.
 * @throws If the amount or rate is negative, or neither `tilgung` nor `rate` is given.
 */
export function tilgungsplan(input: DarlehenInput): Tilgungsplan {
    const { betrag, sollzins, zinsbindungJahre, sondertilgungProJahr = 0, maxJahre = 50 } = input;

    if (betrag <= 0) throw new Error('Darlehensbetrag muss > 0 sein.');
    if (sollzins < 0) throw new Error('Sollzins darf nicht negativ sein.');
    if (input.rate === undefined && input.tilgung === undefined) {
        throw new Error('Entweder --tilgung oder --rate angeben.');
    }

    const rate = input.rate ?? annuitaet(betrag, sollzins, input.tilgung ?? 0);
    const monatsZins = sollzins / 100 / 12;

    // An instalment below the first month's interest never repays anything. Say so
    // instead of simulating 600 months of growing debt.
    if (rate <= betrag * monatsZins && sondertilgungProJahr <= 0) {
        return {
            rate,
            zeilen: [],
            jahre: [],
            restschuldNachBindung: betrag,
            laufzeitMonate: null,
            summeZins: 0,
            summeTilgung: 0,
            gezahltBisBindung: null,
        };
    }

    const zeilen: TilgungsZeile[] = [];
    let restschuld = betrag;
    let summeZins = 0;
    let summeTilgung = 0;
    let laufzeitMonate: number | null = null;
    const maxMonate = Math.round(maxJahre * 12);

    const anlaufMonate = Math.round((input.tilgungsfreieAnlaufjahre ?? 0) * 12);

    for (let monat = 1; monat <= maxMonate && restschuld > 0; monat++) {
        const zins = restschuld * monatsZins;
        // During the tilgungsfreie Anlaufzeit only the interest is due, so the
        // debt stands still and the instalment jumps once the period ends.
        const zahlung = monat <= anlaufMonate ? zins : Math.min(rate, restschuld + zins);
        const tilgungsAnteil = zahlung - zins;
        restschuld -= tilgungsAnteil;

        // Sondertilgung at the end of each full year, capped at the remaining debt.
        let sonder = 0;
        if (sondertilgungProJahr > 0 && monat % 12 === 0 && restschuld > 0) {
            sonder = Math.min(sondertilgungProJahr, restschuld);
            restschuld -= sonder;
        }

        summeZins += zins;
        summeTilgung += tilgungsAnteil + sonder;

        // Kill sub-cent residue so the loop terminates cleanly.
        if (restschuld < 0.005) restschuld = 0;

        zeilen.push({
            monat,
            jahr: Math.ceil(monat / 12),
            rate: cent(zahlung),
            zins: cent(zins),
            tilgung: cent(tilgungsAnteil),
            sondertilgung: cent(sonder),
            restschuld: cent(restschuld),
        });

        if (restschuld === 0) {
            laufzeitMonate = monat;
            break;
        }
    }

    const jahre = aggregiereJahre(zeilen);

    let restschuldNachBindung: number | null = null;
    let gezahltBisBindung: number | null = null;
    if (zinsbindungJahre !== undefined && zinsbindungJahre > 0) {
        const bindungsMonate = Math.round(zinsbindungJahre * 12);
        const letzte = zeilen.find((z) => z.monat === bindungsMonate);
        // Repaid before the Zinsbindung ends ⇒ nothing left to refinance.
        restschuldNachBindung = letzte ? letzte.restschuld : 0;
        gezahltBisBindung = cent(
            zeilen
                .filter((z) => z.monat <= bindungsMonate)
                .reduce((sum, z) => sum + z.rate + z.sondertilgung, 0),
        );
    }

    return {
        rate,
        zeilen,
        jahre,
        restschuldNachBindung,
        laufzeitMonate,
        summeZins: cent(summeZins),
        summeTilgung: cent(summeTilgung),
        gezahltBisBindung,
    };
}

/** Fold the monthly rows into one row per year. */
function aggregiereJahre(zeilen: TilgungsZeile[]): JahresZeile[] {
    const jahre: JahresZeile[] = [];
    for (const z of zeilen) {
        let eintrag = jahre[z.jahr - 1];
        if (!eintrag) {
            eintrag = { jahr: z.jahr, rate: 0, zins: 0, tilgung: 0, sondertilgung: 0, restschuld: 0 };
            jahre[z.jahr - 1] = eintrag;
        }
        eintrag.rate += z.rate;
        eintrag.zins += z.zins;
        eintrag.tilgung += z.tilgung;
        eintrag.sondertilgung += z.sondertilgung;
        eintrag.restschuld = z.restschuld; // last month of the year wins
    }
    return jahre.map((j) => ({
        jahr: j.jahr,
        rate: cent(j.rate),
        zins: cent(j.zins),
        tilgung: cent(j.tilgung),
        sondertilgung: cent(j.sondertilgung),
        restschuld: cent(j.restschuld),
    }));
}

/**
 * Debt left after a given number of years.
 *
 * @param plan A computed {@link Tilgungsplan}.
 * @param jahre Number of years to look ahead.
 * @returns The remaining debt in euro; `0` once the loan is repaid.
 */
export function restschuldNach(plan: Tilgungsplan, jahre: number): number {
    const monat = Math.round(jahre * 12);
    const zeile = plan.zeilen.find((z) => z.monat === monat);
    if (zeile) return zeile.restschuld;
    // Past the end of the schedule ⇒ the loan was already repaid.
    return plan.laufzeitMonate !== null && monat >= plan.laufzeitMonate ? 0 : Number.NaN;
}
