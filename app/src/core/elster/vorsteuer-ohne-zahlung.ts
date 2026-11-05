/**
 * Vorsteuer of incoming invoices settled WITHOUT a bank payment (config `adjustments.vorsteuer_ohne_zahlung`).
 *
 * The USt-VA and USt-Jahr read Vorsteuer from payments, so an invoice cleared by Verrechnung never shows
 * up there. § 15 Abs. 1 Nr. 1 UStG makes the deduction due in the period in which Leistung and Rechnung
 * have both been received, regardless of payment — so these items are folded in by their `datum`.
 * docs/references/tax-sources.md, „Vorsteuer ohne Zahlung". Pure.
 */

import type { ElsterVorsteuerOhneZahlung } from '../config/index.ts';
import { round2 } from '../lib/money.ts';
import type { UstvaAggregate } from './ustva-aggregate.ts';

/** The items whose `datum` lies in `von`..`bis` (both inclusive, YYYY-MM-DD). */
export function vorsteuerOhneZahlungImZeitraum(
    items: readonly ElsterVorsteuerOhneZahlung[] | undefined,
    von: string,
    bis: string,
): ElsterVorsteuerOhneZahlung[] {
    return (items ?? []).filter((i) => i.datum >= von && i.datum <= bis);
}

/** The items of calendar `year`. */
export function vorsteuerOhneZahlungDesJahres(
    items: readonly ElsterVorsteuerOhneZahlung[] | undefined,
    year: number,
): ElsterVorsteuerOhneZahlung[] {
    return vorsteuerOhneZahlungImZeitraum(items, `${year}-01-01`, `${year}-12-31`);
}

/** Σ of the deductible VAT. */
export function summeVorsteuerOhneZahlung(items: readonly ElsterVorsteuerOhneZahlung[]): number {
    return round2(items.reduce((s, i) => s + i.vorsteuer, 0));
}

/** `aggregate` with the Vorsteuer of `items` added — the caller has already narrowed them to the period. */
export function mitVorsteuerOhneZahlung(
    aggregate: UstvaAggregate,
    items: readonly ElsterVorsteuerOhneZahlung[],
): UstvaAggregate {
    if (items.length === 0) return aggregate;
    return {
        ...aggregate,
        vat_in: round2(aggregate.vat_in + summeVorsteuerOhneZahlung(items)),
        incoming_count: aggregate.incoming_count + items.length,
    };
}
