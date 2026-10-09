/**
 * Fold Amazon article details onto the matching Amazon bank charges, so the EÜR
 * can classify by item (a Nintendo game → private, a document scanner → business)
 * instead of the opaque "AMZN Mktp DE". Matched on amount + a small date window
 * (the bank books a day or two after the Amazon payment). Pure function.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import type { AmazonPayment } from '../../clients/amazon/parser.ts';

/** Is this bank booking an Amazon charge? */
function isAmazon(t: UnifiedTransaction): boolean {
    return /amzn|amazon/i.test(`${t.counterparty ?? ''} ${t.purpose ?? ''}`);
}

/** Whole-day distance between two YYYY-MM-DD dates. */
function daysApart(a: string, b: string): number {
    return Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}

/**
 * Return copies of `camtTxs` where each Amazon charge has its article list folded
 * into `purpose` (within `⟦ … ⟧`). Match: same absolute amount and a booking date
 * within `windowDays` of the Amazon payment. Idempotent (the `⟦` tag marks it).
 */
export function enrichCamtFromAmazon(
    camtTxs: UnifiedTransaction[],
    payments: AmazonPayment[],
    windowDays = 4,
): { enriched: UnifiedTransaction[]; matched: number } {
    const byAmount = new Map<string, AmazonPayment[]>();
    for (const p of payments) {
        const k = p.amount.toFixed(2);
        const arr = byAmount.get(k);
        if (arr) arr.push(p);
        else byAmount.set(k, [p]);
    }
    let matched = 0;
    const enriched = camtTxs.map((t) => {
        if (!isAmazon(t) || (t.purpose ?? '').includes('⟦')) return t;
        const cands = byAmount.get(Math.abs(t.amount).toFixed(2));
        const p = cands?.find((c) => daysApart(c.date, t.bookingDate) <= windowDays);
        if (!p || p.items.length === 0) return t;
        matched++;
        return { ...t, purpose: `${t.purpose ?? ''} ⟦${p.items.join(' · ')}⟧`.trim() };
    });
    return { enriched, matched };
}
