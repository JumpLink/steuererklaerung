/**
 * §13b UStG — Steuerschuldnerschaft des Leistungsempfängers (reverse charge on the INPUT side).
 *
 * When a German business buys a service from a foreign supplier that invoices net ("VAT reverse
 * charged"), the recipient owes the German VAT AND deducts it as Vorsteuer in the same period — so
 * it is **zahllastneutral** for a fully-deductible business, but must still be declared. This module
 * is the single shared classifier + accumulator both VAT pipelines feed (USt-VA `ustva-aggregate`
 * and the transaction-driven annual `euer-transactions`), so CLI/web/app all report §13b identically.
 *
 * Split by supplier country:
 *   - EU business, sonstige Leistung (§3a Abs. 2) → §13b Abs. 1 → UStVA Kz 46 (Basis) / Kz 47 (Steuer)
 *   - third-country business ("andere Leistungen") → §13b Abs. 2 → UStVA Kz 84 (Basis) / Kz 85 (Steuer)
 * The owed tax is always deductible as Vorsteuer aus §13b-Leistungen → UStVA Kz 67 (= Kz 47 + Kz 85).
 *
 * Not covered (deliberately, and surfaced for review instead of silently mis-booked): reverse-charge
 * on GOODS (that is innergemeinschaftlicher Erwerb, different Kennziffern), and domestic §13b cases
 * (Bauleistungen etc.). See the {@link classifyReverseCharge} `review` reason.
 */

import { round2 } from '../lib/money.ts';

/** EU member states (ISO 3166-1 alpha-2) as of 2025, excluding DE (domestic ≠ §13b Abs. 1). */
const EU_COUNTRIES = new Set([
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
]);

/** Greek VAT prefix is "EL", not the ISO "GR"; accept both. */
export function isEuCountry(code: string | null | undefined): boolean {
    if (!code) return false;
    const c = code.trim().toUpperCase();
    return c === 'EL' || EU_COUNTRIES.has(c);
}

/** The §13b input a single incoming invoice contributes (before summing). */
export interface ReverseChargeItem {
    /** §13b Abs. 1 (EU service) → Kz 46/47, or Abs. 2 (third country) → Kz 84/85. */
    kind: 'abs1' | 'abs2';
    /** Bemessungsgrundlage (net). */
    base: number;
    /** Owed German VAT on the base (also deductible as Vorsteuer). */
    tax: number;
}

/** Fields a classifier needs from an incoming invoice (from the linked Paperless doc). */
export interface ReverseChargeInput {
    reverseCharge?: boolean | null;
    supplierCountry?: string | null;
    saleType?: 'GOODS' | 'SERVICES' | null;
    /** Net amount (Bemessungsgrundlage) in EUR. */
    net?: number | null;
    /** The German VAT rate that applies to the reverse-charged supply (default 19 %). */
    rate?: number;
}

export type ReverseChargeResult =
    | { item: ReverseChargeItem; review?: undefined }
    | { item: null; review: string | null };

/**
 * Classify one incoming invoice for §13b. Returns a {@link ReverseChargeItem} when it is a covered
 * reverse-charge service, `{ item: null, review }` with a reason when it looks like §13b but is not
 * cleanly covered (so the caller can surface it for a human check), or `{ item: null, review: null }`
 * when it is plainly not §13b (domestic / no reverse-charge flag).
 */
export function classifyReverseCharge(input: ReverseChargeInput): ReverseChargeResult {
    const country = input.supplierCountry?.trim().toUpperCase() ?? '';
    const isForeign = country !== '' && country !== 'DE';
    // The reverse-charge signal: the extracted flag, or a foreign net invoice with 0 % German VAT.
    const flagged = input.reverseCharge === true;
    if (!flagged && !isForeign) return { item: null, review: null };

    const net = input.net ?? 0;
    if (net <= 0) return { item: null, review: null };
    const rate = input.rate ?? 0.19;

    // GOODS from the EU is innergemeinschaftlicher Erwerb, not §13b — flag rather than mis-book.
    if (input.saleType === 'GOODS' && isEuCountry(country)) {
        return { item: null, review: `EU-Wareneinkauf (${country}) — i.g. Erwerb, nicht §13b; separat prüfen.` };
    }
    // Reverse-charge flagged but no country → can't decide Abs. 1 vs Abs. 2.
    if (flagged && country === '') {
        return { item: null, review: 'Reverse-Charge ohne Lieferantenland — Abs. 1 vs. Abs. 2 unklar.' };
    }

    const base = round2(net);
    const tax = round2(base * rate);
    const kind: 'abs1' | 'abs2' = isEuCountry(country) ? 'abs1' : 'abs2';
    return { item: { kind, base, tax } };
}

/** Running §13b totals, summed from per-invoice {@link ReverseChargeItem}s. */
export interface ReverseChargeTotals {
    /** §13b Abs. 1 (EU) — Kz 46 base / Kz 47 tax. */
    abs1Base: number;
    abs1Tax: number;
    /** §13b Abs. 2 (third country) — Kz 84 base / Kz 85 tax. */
    abs2Base: number;
    abs2Tax: number;
    /** Deductible Vorsteuer aus §13b-Leistungen — Kz 67 (= abs1Tax + abs2Tax when fully deductible). */
    deductibleVat: number;
    /** Count of invoices classified as §13b (for the review/coverage line). */
    count: number;
}

export function emptyReverseChargeTotals(): ReverseChargeTotals {
    return { abs1Base: 0, abs1Tax: 0, abs2Base: 0, abs2Tax: 0, deductibleVat: 0, count: 0 };
}

/** Fold one classified item into the running totals (mutates + returns for convenience). */
export function addReverseChargeItem(totals: ReverseChargeTotals, item: ReverseChargeItem): ReverseChargeTotals {
    if (item.kind === 'abs1') {
        totals.abs1Base = round2(totals.abs1Base + item.base);
        totals.abs1Tax = round2(totals.abs1Tax + item.tax);
    } else {
        totals.abs2Base = round2(totals.abs2Base + item.base);
        totals.abs2Tax = round2(totals.abs2Tax + item.tax);
    }
    totals.deductibleVat = round2(totals.deductibleVat + item.tax);
    totals.count += 1;
    return totals;
}

/** Whether any §13b was booked (drives whether to emit the Kennziffern / show the datasheet lines). */
export function hasReverseCharge(t: ReverseChargeTotals): boolean {
    return t.count > 0 && (t.abs1Base !== 0 || t.abs2Base !== 0);
}
