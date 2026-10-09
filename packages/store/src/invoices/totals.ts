/**
 * Pure invoice arithmetic. All sums are computed in integer cents to avoid binary-float drift,
 * then emitted as rounded EUR numbers. VAT is computed PER RATE on that rate's summed net (the
 * German §14 per-rate ausweis), NOT per line — so the tax shown equals the sum of the printed
 * rate blocks and satisfies the EN 16931 BR-CO arithmetic rules for an XRechnung.
 */

import type { InvoiceItemInput, StoredInvoiceItem, VatBreakdownEntry } from './types.ts';

/** Kleinbetragsrechnung threshold (§33 UStDV): gross ≤ 250 € relaxes recipient/§14 fields. */
export const KLEINBETRAG_LIMIT_EUR = 250;

const toCents = (eur: number): number => Math.round(eur * 100);
const toEur = (cents: number): number => cents / 100;

/** Line net in cents = quantity × unitPriceNet, rounded to the cent. */
function lineNetCents(item: Pick<InvoiceItemInput, 'quantity' | 'unitPriceNet'>): number {
    return Math.round(item.quantity * item.unitPriceNet * 100);
}

/**
 * Freeze one item's totals (net/vat/gross) for storage. VAT here is the per-line value for
 * display; the authoritative tax total is the per-rate {@link computeInvoiceTotals} sum.
 */
export function computeItemTotals(item: InvoiceItemInput): StoredInvoiceItem {
    const netCents = lineNetCents(item);
    const vatCents = Math.round(netCents * item.vatRate);
    return {
        title: item.title,
        description: item.description ?? null,
        quantity: item.quantity,
        unit: item.unit ?? null,
        unitPriceNet: item.unitPriceNet,
        vatRate: item.vatRate,
        net: toEur(netCents),
        vat: toEur(vatCents),
        gross: toEur(netCents + vatCents),
    };
}

/**
 * Totals with a per-VAT-rate breakdown. Net is summed per rate in cents, VAT is rounded once
 * per rate on that net (not per line), and the grand totals are the sums of the rate blocks —
 * so gross = net + vat exactly and the printed rate lines reconcile.
 */
export function computeInvoiceTotals(items: ReadonlyArray<Pick<InvoiceItemInput, 'quantity' | 'unitPriceNet' | 'vatRate'>>): {
    net: number;
    vat: number;
    gross: number;
    byRate: VatBreakdownEntry[];
} {
    const netByRate = new Map<number, number>();
    for (const it of items) {
        netByRate.set(it.vatRate, (netByRate.get(it.vatRate) ?? 0) + lineNetCents(it));
    }
    const byRate: VatBreakdownEntry[] = [];
    let netTotal = 0;
    let vatTotal = 0;
    // Highest rate first for a stable, conventional ordering of the tax block.
    for (const rate of [...netByRate.keys()].sort((a, b) => b - a)) {
        const netCents = netByRate.get(rate) as number;
        const vatCents = Math.round(netCents * rate);
        netTotal += netCents;
        vatTotal += vatCents;
        byRate.push({ rate, net: toEur(netCents), vat: toEur(vatCents), gross: toEur(netCents + vatCents) });
    }
    return { net: toEur(netTotal), vat: toEur(vatTotal), gross: toEur(netTotal + vatTotal), byRate };
}

/** True when the gross total qualifies for the §33 UStDV Kleinbetragsrechnung simplification. */
export function isKleinbetragsrechnung(gross: number): boolean {
    return toCents(gross) <= KLEINBETRAG_LIMIT_EUR * 100;
}
