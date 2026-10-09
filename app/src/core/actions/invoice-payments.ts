/**
 * Suggest the bank transaction that settled a self-issued outgoing invoice. Reuses the receipt↔
 * transaction matcher (lib/transactions/reconcile.ts) — its Verwendungszweck invoice-number match
 * is exactly the "which credit paid this invoice?" engine — restricted to CREDITS (money in) on
 * the entity's own accounts. Read-only; the caller passes the chosen txId to markOutgoingInvoicePaid.
 */

import { searchAccountKeys, transactionsSummary } from '@steuererklaerung/store';
import { loadManifest, resolveWorkspaceEntities } from '../config/index.ts';
import { findStoreMatches } from '../lib/transactions/reconcile.ts';
import { getOutgoingInvoice } from './outgoing-invoices.ts';

/** One candidate settling transaction for an open invoice. */
export interface PaymentCandidate {
    txId: string;
    bookingDate: string;
    amount: number;
    counterparty: string;
    accountKey: string;
    /** Match score (higher = better) + why, from the reconcile engine. */
    score: number;
    reasons: string[];
}

/** The store account keys that belong to one workspace entity. */
export function entityAccountKeys(entityId: string, path?: string): string[] {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const resolved = resolveWorkspaceEntities(storeKeys, loadManifest(path));
    return resolved.find((e) => e.id === entityId)?.accountKeys ?? [];
}

/**
 * Candidate transactions that likely paid the given OPEN invoice (newest/best first). Matches by
 * gross ≈ credit amount, booking on/after the issue date, and the invoice number in the purpose.
 */
export async function findPaymentCandidates(
    entityId: string,
    invoiceId: string,
    opts: { path?: string; maxDayGap?: number } = {},
): Promise<PaymentCandidate[]> {
    const invoice = await getOutgoingInvoice(entityId, invoiceId, opts.path);
    if (!invoice) return [];

    const keys = entityAccountKeys(entityId, opts.path);
    // Credits only, from the issue date onward (a payment never precedes the invoice).
    const from = invoice.issueDate ?? undefined;
    const pool = searchAccountKeys(keys, { from }).filter((t) => t.amount > 0);

    const ranked = findStoreMatches(
        {
            grossAmount: Math.abs(invoice.totals.gross),
            currency: invoice.currency ?? 'EUR',
            direction: 'outgoing',
            invoiceDate: invoice.issueDate ?? undefined,
            dueDate: invoice.dueDate ?? undefined,
            invoiceNumber: invoice.number ?? undefined,
            counterpartyName: invoice.recipient?.name ?? undefined,
        },
        pool,
        { maxDayGap: opts.maxDayGap ?? 90 },
    );

    return ranked.slice(0, 5).map((c) => ({
        txId: c.transaction.id,
        bookingDate: c.transaction.bookingDate,
        amount: c.transaction.amount,
        counterparty: c.transaction.counterparty ?? '',
        accountKey: c.transaction.accountKey,
        score: c.score,
        reasons: c.reasons,
    }));
}
