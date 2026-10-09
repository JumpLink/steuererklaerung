/**
 * Actions for reading and analyzing Qonto XLS transaction exports.
 */

import { parseQontoExport, getTransactionDate } from '../clients/qonto-export/index.ts';
import type {
    QontoExportTransaction,
    QontoExportSummary,
    QontoExportSearchParams,
} from '../clients/qonto-export/index.ts';

const DEFAULT_EXPORT = 'exports/qonto/2025-11-07_Qonto_Transaktionen_Export.xls';

function resolveFile(file?: string): string {
    return file ?? DEFAULT_EXPORT;
}

function matchesSearch(tx: QontoExportTransaction, params: QontoExportSearchParams): boolean {
    if (params.query) {
        const q = params.query.toLowerCase();
        const haystack = [
            tx.counterpartyName,
            tx.reference,
            tx.note,
            tx.cashflowCategory,
            tx.cashflowSubcategory,
            tx.paymentMethod,
            tx.initiatedBy,
            tx.transactionId,
        ]
            .join(' ')
            .toLowerCase();
        if (!haystack.includes(q)) return false;
    }

    const date = getTransactionDate(tx);

    if (params.dateFrom && date < params.dateFrom) return false;
    if (params.dateTo && date > params.dateTo) return false;

    if (params.minAmount != null && Math.abs(tx.totalAmount) < params.minAmount) return false;
    if (params.maxAmount != null && Math.abs(tx.totalAmount) > params.maxAmount) return false;

    if (params.category) {
        const cat = params.category.toLowerCase();
        const txCat = (tx.cashflowCategory + ' ' + tx.cashflowSubcategory).toLowerCase();
        if (!txCat.includes(cat)) return false;
    }

    if (params.type === 'income' && tx.credit == null) return false;
    if (params.type === 'expense' && tx.debit == null) return false;

    return true;
}

export function qontoExportSearch(params: QontoExportSearchParams & { file?: string }): QontoExportTransaction[] {
    const txs = parseQontoExport(resolveFile(params.file));
    const filtered = txs.filter((tx) => matchesSearch(tx, params));
    const limit = params.limit ?? 50;
    return filtered.slice(0, limit);
}

export function qontoExportSummary(file?: string): QontoExportSummary {
    const filePath = resolveFile(file);
    const txs = parseQontoExport(filePath);

    const dates = txs.map(getTransactionDate).filter(Boolean).sort();
    const totalIncome = txs.reduce((sum, tx) => sum + (tx.credit ?? 0), 0);
    const totalExpenses = txs.reduce((sum, tx) => sum + (tx.debit ?? 0), 0);

    // Category breakdown
    const catMap = new Map<string, { count: number; total: number }>();
    for (const tx of txs) {
        const cat = tx.cashflowCategory || '(keine Kategorie)';
        const entry = catMap.get(cat) ?? { count: 0, total: 0 };
        entry.count++;
        entry.total += tx.totalAmount;
        catMap.set(cat, entry);
    }
    const categorySummary = [...catMap.entries()]
        .map(([category, { count, total }]) => ({ category, count, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => a.total - b.total);

    return {
        file: filePath,
        totalTransactions: txs.length,
        dateRange: {
            from: dates[0] ?? '',
            to: dates[dates.length - 1] ?? '',
        },
        accountName: txs[0]?.accountName ?? '',
        accountIban: txs[0]?.accountIban ?? '',
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netAmount: Math.round((totalIncome - totalExpenses) * 100) / 100,
        currency: txs[0]?.currency ?? 'EUR',
        categorySummary,
    };
}

export function qontoExportList(params: { file?: string; limit?: number; offset?: number } = {}): {
    total: number;
    transactions: QontoExportTransaction[];
} {
    const txs = parseQontoExport(resolveFile(params.file));
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return {
        total: txs.length,
        transactions: txs.slice(offset, offset + limit),
    };
}
