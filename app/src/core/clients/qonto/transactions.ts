/**
 * Qonto API – Transactions.
 * GET /v2/transactions, GET /v2/transactions/:id
 */

import { get, listAll } from './request.ts';
import type { Transaction } from './types.ts';

/** Format datetime for Qonto API: ISO 8601 without milliseconds (e.g. 2025-12-20T10:00:00Z). */
function formatDateTime(value: string): string {
    return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface ListTransactionsParams {
    bankAccountId?: string;
    iban?: string;
    status?: string[];
    updated_at_from?: string;
    updated_at_to?: string;
    created_at_from?: string;
    created_at_to?: string;
    emitted_at_from?: string;
    emitted_at_to?: string;
    settled_at_from?: string;
    settled_at_to?: string;
    side?: 'credit' | 'debit';
    operation_type?: string[];
    with_attachments?: boolean;
    sort_by?: string;
    includes?: string[];
}

function buildTransactionsQuery(params: ListTransactionsParams): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (params.bankAccountId) q.bank_account_id = params.bankAccountId;
    if (params.iban) q.iban = params.iban;
    // Array params: use plain key name — buildQuery() in request.ts appends [] automatically
    if (params.status?.length) q.status = params.status;
    if (params.updated_at_from) q.updated_at_from = formatDateTime(params.updated_at_from);
    if (params.updated_at_to) q.updated_at_to = formatDateTime(params.updated_at_to);
    if (params.created_at_from) q.created_at_from = formatDateTime(params.created_at_from);
    if (params.created_at_to) q.created_at_to = formatDateTime(params.created_at_to);
    if (params.emitted_at_from) q.emitted_at_from = formatDateTime(params.emitted_at_from);
    if (params.emitted_at_to) q.emitted_at_to = formatDateTime(params.emitted_at_to);
    if (params.settled_at_from) q.settled_at_from = formatDateTime(params.settled_at_from);
    if (params.settled_at_to) q.settled_at_to = formatDateTime(params.settled_at_to);
    if (params.side) q.side = params.side;
    if (params.operation_type?.length) q.operation_type = params.operation_type;
    if (typeof params.with_attachments === 'boolean') q.with_attachments = params.with_attachments;
    if (params.sort_by) q.sort_by = params.sort_by;
    if (params.includes?.length) q.includes = params.includes;
    return q;
}

/**
 * List transactions (all pages) with optional filters.
 * Requires either bankAccountId or iban. Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listTransactions(params: ListTransactionsParams): Promise<Transaction[]> {
    if (!params.bankAccountId && !params.iban) {
        throw new Error('listTransactions requires bankAccountId or iban');
    }
    const query = buildTransactionsQuery(params);
    return listAll<Transaction>('transactions', query);
}

export interface GetTransactionOptions {
    includes?: string[];
}

/**
 * Get a single transaction by id.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getTransaction(transactionId: string, options: GetTransactionOptions = {}): Promise<Transaction> {
    const query: Record<string, unknown> = {};
    if (options.includes?.length) query.includes = options.includes;
    const res = await get<{ transaction: Transaction }>(`transactions/${transactionId}`, query);
    return res.transaction;
}
