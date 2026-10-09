/**
 * Enrich PayPal-routed bank charges with the real merchant from imported PayPal
 * data, so the EÜR classifier can see "DeepSeek" / "YouTube Music" instead of the
 * opaque bank purpose "<bankref>/PP.1555.PP/…".
 *
 * The bank prints PayPal's reference number in its purpose; the imported `paypal:`
 * transactions carry the same number in `reference`. We match on it and append the
 * PayPal merchant + item to the bank transaction's purpose (a non-persisted,
 * report-time overlay — the raw store is untouched). Pure function (no I/O).
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';

/** Index PayPal transactions by their bank reference (the number the bank stores). */
export function buildPaypalRefMap(paypalTxs: UnifiedTransaction[]): Map<string, UnifiedTransaction> {
    const map = new Map<string, UnifiedTransaction>();
    for (const t of paypalTxs) {
        if (t.reference) map.set(t.reference, t);
    }
    return map;
}

/** The PayPal reference embedded in a bank purpose, if any (a 12–15 digit run). */
function bankRefOf(purpose: string | undefined): string | undefined {
    return /(\d{12,15})/.exec(purpose ?? '')?.[1];
}

/**
 * Return copies of `txs` where any PayPal-routed charge (its embedded reference is
 * a known PayPal transaction) gets the merchant + item folded into `counterparty`
 * and `purpose`. Non-PayPal transactions pass through unchanged.
 */
export function enrichWithPaypal(
    txs: UnifiedTransaction[],
    paypalTxs: UnifiedTransaction[],
): UnifiedTransaction[] {
    const map = buildPaypalRefMap(paypalTxs);
    if (map.size === 0) return txs;
    return txs.map((t) => {
        const ref = bankRefOf(t.purpose);
        const pp = ref ? map.get(ref) : undefined;
        if (!pp) return t;
        const merchant = pp.counterparty ?? '';
        const item = pp.purpose ?? '';
        return {
            ...t,
            counterparty: t.counterparty || merchant || undefined,
            purpose: `${t.purpose ?? ''} ‹PayPal: ${merchant} ${item}›`.trim(),
        };
    });
}
