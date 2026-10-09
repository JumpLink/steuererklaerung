/**
 * Domain types for the loan kernel.
 *
 * Everything here is objektfrei: no borrower, no property, no account — only the
 * parameters a bank quote consists of. That is deliberate, so this package can be
 * extracted into a public one later without touching a single private figure.
 *
 * Convention: interest and repayment rates are **percent per year** (3.9 = 3.9 %),
 * amounts are **euro**, and periods are **months** unless a field says `Jahre`.
 */

/** One bank quote / one financing variant to compute. */
export interface DarlehenInput {
    /** Nettodarlehensbetrag — what actually gets paid out. */
    betrag: number;
    /** Nominal interest rate p.a. in percent (Sollzins), e.g. `3.9`. */
    sollzins: number;
    /**
     * Anfängliche Tilgung p.a. in percent, e.g. `2`. Together with {@link sollzins}
     * this fixes the annuity: Rate = Betrag · (Sollzins + Tilgung) / 100 / 12.
     * Ignored when {@link rate} is given.
     */
    tilgung?: number;
    /** Fixed monthly instalment — alternative to {@link tilgung}. Wins if both are set. */
    rate?: number;
    /** Zinsbindung in years. Drives {@link Tilgungsplan.restschuldNachBindung}. */
    zinsbindungJahre?: number;
    /**
     * Tilgungsfreie Anlaufjahre — years at the start where only interest is paid
     * and the debt does not shrink. Standard on KfW programmes (1–5 years) and
     * the reason a promotional loan looks cheaper than it is: the instalment
     * **steps up** when the period ends, and the whole principal is still there.
     * Modelling it is what makes a mix of KfW and bank money honest.
     */
    tilgungsfreieAnlaufjahre?: number;
    /** Sondertilgung paid at the end of each full year (many contracts allow 5 % p.a.). */
    sondertilgungProJahr?: number;
    /** Safety stop for the simulation in years; default 50. */
    maxJahre?: number;
}

/** One month of the amortisation schedule. */
export interface TilgungsZeile {
    /** 1-based month index over the whole term. */
    monat: number;
    /** 1-based year index (`Math.ceil(monat / 12)`). */
    jahr: number;
    /** Instalment actually paid this month (the last one is usually smaller). */
    rate: number;
    /** Interest share of {@link rate}. */
    zins: number;
    /** Repayment share of {@link rate}. */
    tilgung: number;
    /** Extra repayment booked at the end of this month, if any. */
    sondertilgung: number;
    /** Debt left after this month. */
    restschuld: number;
}

/** One calendar year of the schedule, aggregated from {@link TilgungsZeile}. */
export interface JahresZeile {
    jahr: number;
    rate: number;
    zins: number;
    tilgung: number;
    sondertilgung: number;
    /** Debt left at the end of the year. */
    restschuld: number;
}

/** The computed amortisation schedule for one {@link DarlehenInput}. */
export interface Tilgungsplan {
    /** The regular monthly instalment (Annuität). */
    rate: number;
    zeilen: TilgungsZeile[];
    jahre: JahresZeile[];
    /**
     * Debt left when the Zinsbindung ends — the number that decides how big the
     * Anschlussfinanzierung will be. `null` when no Zinsbindung was given.
     */
    restschuldNachBindung: number | null;
    /** Months until the debt is gone; `null` when it is not repaid within `maxJahre`. */
    laufzeitMonate: number | null;
    /** Total interest paid over the simulated term. */
    summeZins: number;
    /** Total repayment (regular + Sondertilgung) over the simulated term. */
    summeTilgung: number;
    /** Everything paid until the end of the Zinsbindung; `null` without a Zinsbindung. */
    gezahltBisBindung: number | null;
}

/** Costs that make the Effektivzins differ from the Sollzins. */
export interface EffektivzinsKosten {
    /** Disagio / Damnum in percent of {@link DarlehenInput.betrag} — reduces the payout. */
    disagioProzent?: number;
    /** One-off fees deducted at payout (Schätzkosten, Bearbeitung …), in euro. */
    gebuehren?: number;
}
