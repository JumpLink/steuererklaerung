/**
 * Restore card merchants onto CAMT-imported transactions from a Qonto XLS export.
 *
 * A closed account arrives via a CAMT53 export, which drops the card merchant (only
 * "NONREF … <card-no>" survives). Qonto's "Vollständiger Datenexport"
 * carries `counterpartyName` for every booking. We match the two on
 * (IBAN, booking date, signed amount) and fold the merchant into the stored
 * transaction — restoring data the CAMT export lost, NOT assigning a category.
 *
 * Pure function (no I/O); the action maps Qonto export rows to {@link MerchantRow}.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';

/** A merchant fact for one booking, distilled from a Qonto export row. */
export interface MerchantRow {
    iban: string;
    /**
     * Candidate booking dates YYYY-MM-DD — both the settlement and the operation
     * date, because a card charge settles a day or two after the operation and CAMT
     * books it on the settlement date.
     */
    dates: string[];
    /** Signed amount in EUR (debit negative). */
    amount: number;
    merchant: string;
    /** e.g. "Karte" for card payments. */
    method?: string;
}

const key = (iban: string | undefined, date: string, amount: number): string =>
    `${iban ?? ''}|${date}|${amount.toFixed(2)}`;

/**
 * Return copies of `camtTxs` with the matching Qonto merchant folded into
 * `counterparty` (when absent) and appended to `purpose`. Match key is
 * IBAN + booking date + signed amount (the booking date is matched against both
 * the settlement and the operation date); the first merchant per key wins.
 */
export function enrichCamtFromMerchants(
    camtTxs: UnifiedTransaction[],
    merchants: MerchantRow[],
): { enriched: UnifiedTransaction[]; matched: number } {
    const idx = new Map<string, MerchantRow>();
    for (const m of merchants) {
        if (!m.merchant) continue;
        for (const date of m.dates) {
            const k = key(m.iban, date, m.amount);
            if (!idx.has(k)) idx.set(k, m);
        }
    }
    let matched = 0;
    const enriched = camtTxs.map((t) => {
        const m = idx.get(key(t.iban, t.bookingDate, t.amount));
        if (!m) return t;
        matched++;
        // Idempotent: don't re-append on a second run (the ‹…› tag marks an enriched purpose).
        if ((t.purpose ?? '').includes('‹')) return { ...t, counterparty: t.counterparty || m.merchant };
        const tag = m.method === 'Karte' ? `${m.merchant} (Karte)` : m.merchant;
        return {
            ...t,
            counterparty: t.counterparty || m.merchant,
            purpose: `${t.purpose ?? ''} ‹${tag}›`.trim(),
        };
    });
    return { enriched, matched };
}
