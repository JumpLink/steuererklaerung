/**
 * Qonto → unified normalizer. Lives in the CLI (not @steuererklaerung/store) because it is the
 * only normalizer coupled to a REST-client raw type (`clients/qonto`); the store package
 * stays client-free. Sync-time only — the read path consumes already-normalized NDJSON.
 */

import type { Transaction as QontoTransaction } from '../../clients/qonto/index.ts';
import { toIsoDate, type UnifiedTransaction } from '@steuererklaerung/store';

/**
 * The other side's IBAN, from whichever subject object the transaction carries (transfer, income,
 * direct debit, …). Card payments and fees have none. Rows synced before this existed have none
 * either until a full re-sync — the IBAN-Wechsel check then treats them as „ohne IBAN".
 */
export function qontoCounterpartyIban(tx: QontoTransaction): string | undefined {
    for (const s of [tx.transfer, tx.income, tx.swift_income, tx.direct_debit, tx.direct_debit_collection]) {
        const nr = s?.counterparty_account_number?.trim();
        if (nr && (s?.counterparty_account_number_format ?? 'IBAN').toUpperCase() === 'IBAN') return nr;
    }
    return undefined;
}

/** Normalize a Qonto transaction into the unified shape (amount made signed via side). */
export function normalizeQonto(
    accountKey: string,
    iban: string | undefined,
    tx: QontoTransaction,
): UnifiedTransaction {
    const abs = (tx.amount_cents ?? 0) / 100;
    return {
        id: tx.id,
        source: 'qonto',
        accountKey,
        iban,
        bookingDate: toIsoDate(tx.settled_at) ?? toIsoDate(tx.emitted_at) ?? '',
        valueDate: toIsoDate(tx.emitted_at),
        amount: tx.side === 'debit' ? -abs : abs,
        currency: tx.currency ?? 'EUR',
        counterparty: tx.label || undefined,
        counterpartyIban: qontoCounterpartyIban(tx),
        purpose: tx.reference || undefined,
        reference: tx.reference || undefined,
        type: tx.operation_type || undefined,
        category: tx.category || undefined,
    };
}
