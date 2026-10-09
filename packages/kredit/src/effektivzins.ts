/**
 * Effektiver Jahreszins — the rate that makes two offers comparable.
 *
 * Why this is not just the Sollzins: the Sollzins prices the *debt*, the Effektivzins
 * prices the *deal*. A Disagio or an upfront fee shrinks what actually lands in your
 * account while you still owe (and pay interest on) the full amount, so two quotes
 * with the same Sollzins can cost noticeably different money.
 *
 * The computation follows the PAngV idea: find the rate at which the discounted
 * payments equal the actual payout. Without fees it collapses to the monthly
 * compounding of the Sollzins, which is a useful sanity check on the implementation.
 */

import { cent, tilgungsplan } from './tilgungsplan.ts';
import type { DarlehenInput, EffektivzinsKosten } from './types.ts';

/** Net present value of a monthly cashflow at a monthly rate. */
function npv(monatsZins: number, cashflows: number[]): number {
    let sum = 0;
    for (let t = 0; t < cashflows.length; t++) {
        sum += cashflows[t]! / (1 + monatsZins) ** t;
    }
    return sum;
}

/**
 * The effective annual rate of a loan, including payout-reducing costs.
 *
 * @param input The loan parameters; see {@link DarlehenInput}.
 * @param kosten Disagio and upfront fees; omit for a plain loan.
 * @returns The effective rate p.a. in percent, rounded to two decimals.
 * @throws If the loan never amortises, so there is no finite cashflow to price.
 */
export function effektivzins(input: DarlehenInput, kosten: EffektivzinsKosten = {}): number {
    const { disagioProzent = 0, gebuehren = 0 } = kosten;
    const plan = tilgungsplan(input);

    if (plan.zeilen.length === 0) {
        throw new Error('Darlehen tilgt nie — kein Effektivzins berechenbar.');
    }

    // What actually arrives on the account.
    const auszahlung = input.betrag * (1 - disagioProzent / 100) - gebuehren;
    if (auszahlung <= 0) throw new Error('Auszahlung ist null oder negativ.');

    // t=0 payout, then one entry per month. A loan still running at the end of the
    // simulation is settled with its remaining debt, so the cashflow always closes.
    const cashflows: number[] = [auszahlung];
    for (const z of plan.zeilen) cashflows.push(-(z.rate + z.sondertilgung));
    const rest = plan.zeilen[plan.zeilen.length - 1]!.restschuld;
    if (rest > 0) cashflows[cashflows.length - 1]! -= rest;

    // NPV RISES monotonically in the rate: a higher rate discounts the instalments more
    // heavily, so their present value shrinks towards zero while the payout stays fixed.
    // At rate 0 the NPV is negative (you repay more than you borrowed) and it approaches
    // the payout from below, so there is exactly one root — bracket it and bisect.
    if (npv(0, cashflows) >= 0) return 0; // repaid no more than borrowed ⇒ no cost of credit

    let lo = 0; // NPV(lo) < 0
    let hi = 1; // 100 % per month — NPV is positive long before this
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (npv(mid, cashflows) < 0) lo = mid;
        else hi = mid;
    }
    const monatsZins = (lo + hi) / 2;

    // Monthly → annual, compounded.
    return Math.round(((1 + monatsZins) ** 12 - 1) * 100 * 1e2) / 1e2;
}

/**
 * Total cost of credit: everything paid minus everything borrowed.
 *
 * @param input The loan parameters.
 * @param kosten Disagio and upfront fees.
 * @returns Interest plus fees over the full term, in euro.
 */
export function gesamtkosten(input: DarlehenInput, kosten: EffektivzinsKosten = {}): number {
    const { disagioProzent = 0, gebuehren = 0 } = kosten;
    const plan = tilgungsplan(input);
    const disagio = input.betrag * (disagioProzent / 100);
    return cent(plan.summeZins + disagio + gebuehren);
}
