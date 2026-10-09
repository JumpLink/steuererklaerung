/**
 * Kapitalbedarf — what the financing actually has to cover.
 *
 * The figure a bank cares about is not the purchase price but the *Darlehensbedarf*:
 * purchase price plus Kaufnebenkosten plus the renovation tranche, minus equity. The
 * Nebenkosten are the part people underestimate — Grunderwerbsteuer alone is 5 % in
 * Niedersachsen, and none of it can be financed against the property's value.
 */

import type { FinanzierungBedarf } from '../../config/schema/finanzierung.ts';

/** The Kaufnebenkosten, itemised. */
export interface NebenkostenErgebnis {
    grunderwerbsteuer: number;
    notarGrundbuch: number;
    makler: number;
    sonstige: number;
    summe: number;
}

/** The computed capital requirement. */
export interface BedarfErgebnis {
    /** Restschuld of the loan being redeemed. */
    abloesung: number;
    /** Amount that flows to the sellers on top of the Ablösung. */
    auszahlungVerkaeufer: number;
    /** Bemessungsgrundlage of the percentage Nebenkosten. */
    kaufpreis: number;
    nebenkosten: NebenkostenErgebnis;
    sanierung: number;
    eigenkapital: number;
    /** Kaufpreis + Nebenkosten + Sanierung − Eigenkapital. */
    darlehensbedarf: number;
}

/** Per-scenario overrides — the two levers that are actually negotiable. */
export interface BedarfOverrides {
    /** Replace the payout to the sellers (e.g. 70.000 → 50.000). */
    auszahlungVerkaeufer?: number;
    /** Replace the renovation tranche (e.g. phase it: 50.000 → 25.000). */
    sanierung?: number;
}

function round(value: number): number {
    return Math.round(value * 1e2) / 1e2;
}

/**
 * Compute the capital requirement from the configured Bedarf.
 *
 * @param bedarf The entity's `finanzierung.bedarf` block.
 * @param overrides Optional per-scenario replacements; see {@link BedarfOverrides}.
 * @returns The itemised requirement; see {@link BedarfErgebnis}.
 */
export function berechneBedarf(bedarf: FinanzierungBedarf, overrides: BedarfOverrides = {}): BedarfErgebnis {
    const auszahlungVerkaeufer = overrides.auszahlungVerkaeufer ?? bedarf.auszahlung_verkaeufer;
    const sanierung = overrides.sanierung ?? bedarf.sanierung;

    // Without an explicit Kaufpreis the purchase is "settle the loan + pay out the
    // sellers" — which is exactly how a family handover is usually priced.
    const kaufpreis = bedarf.kaufpreis ?? bedarf.abloesung + auszahlungVerkaeufer;

    const nk = bedarf.nebenkosten;
    const grunderwerbsteuer = round((kaufpreis * nk.grunderwerbsteuer_prozent) / 100);
    const notarGrundbuch = round((kaufpreis * nk.notar_grundbuch_prozent) / 100);
    const makler = round((kaufpreis * nk.makler_prozent) / 100);
    const nebenkosten: NebenkostenErgebnis = {
        grunderwerbsteuer,
        notarGrundbuch,
        makler,
        sonstige: nk.sonstige,
        summe: round(grunderwerbsteuer + notarGrundbuch + makler + nk.sonstige),
    };

    return {
        abloesung: bedarf.abloesung,
        auszahlungVerkaeufer,
        kaufpreis,
        nebenkosten,
        sanierung,
        eigenkapital: bedarf.eigenkapital,
        darlehensbedarf: round(kaufpreis + nebenkosten.summe + sanierung - bedarf.eigenkapital),
    };
}
