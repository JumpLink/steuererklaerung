/**
 * Actions for reading and analyzing CAMT.052/053 XML exports.
 * Works with any bank that exports in ISO 20022 CAMT format.
 */

import { parseCamt, getTransactionDate } from '../clients/camt/index.ts';
import type { Transaction, CamtExportSummary, CamtSearchParams } from '../clients/camt/index.ts';

function flattenTransactions(inputPath: string): { transactions: Transaction[]; meta: ReturnType<typeof parseCamt> } {
    const meta = parseCamt(inputPath);
    const transactions = meta.statements.flatMap((s) => s.transactions);
    return { transactions, meta };
}

function matchesSearch(tx: Transaction, params: CamtSearchParams): boolean {
    if (params.query) {
        const q = params.query.toLowerCase();
        const haystack = [
            tx.remoteName,
            tx.purpose,
            tx.bookingText,
            tx.customerReference,
            tx.e2eReference,
            tx.additionalInformation,
            tx.remoteAccountNumber,
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        if (!haystack.includes(q)) return false;
    }

    const date = getTransactionDate(tx);
    if (params.dateFrom && date < params.dateFrom) return false;
    if (params.dateTo && date > params.dateTo) return false;

    if (params.minAmount != null && Math.abs(tx.amount) < params.minAmount) return false;
    if (params.maxAmount != null && Math.abs(tx.amount) > params.maxAmount) return false;

    if (params.type === 'income' && tx.amount <= 0) return false;
    if (params.type === 'expense' && tx.amount >= 0) return false;

    return true;
}

export function camtExportSummary(inputPath: string): CamtExportSummary {
    const { transactions, meta } = flattenTransactions(inputPath);

    const dates = transactions.map(getTransactionDate).filter(Boolean).sort();
    const totalIncome = transactions.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0);
    const totalExpenses = transactions.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    return {
        files: meta.files,
        account: meta.account,
        totalStatements: meta.statements.length,
        totalTransactions: transactions.length,
        dateRange: {
            from: dates[0] ?? '',
            to: dates[dates.length - 1] ?? '',
        },
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netAmount: Math.round((totalIncome - totalExpenses) * 100) / 100,
        currency: meta.account.currency || 'EUR',
    };
}

export function camtExportSearch(inputPath: string, params: CamtSearchParams = {}): Transaction[] {
    const { transactions } = flattenTransactions(inputPath);
    const filtered = transactions.filter((tx) => matchesSearch(tx, params));
    const limit = params.limit ?? 50;
    return filtered.slice(0, limit);
}

export function camtExportList(
    inputPath: string,
    params: { limit?: number; offset?: number } = {},
): { total: number; transactions: Transaction[] } {
    const { transactions } = flattenTransactions(inputPath);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return {
        total: transactions.length,
        transactions: transactions.slice(offset, offset + limit),
    };
}
