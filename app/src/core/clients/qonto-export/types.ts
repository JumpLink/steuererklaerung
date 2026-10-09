/**
 * Types for parsed Qonto XLS transaction exports.
 */

export interface QontoExportTransaction {
    status: string;
    settledAtUtc: string;
    settledAtLocal: string;
    operationDateUtc: string;
    operationDateLocal: string;
    totalAmount: number;
    debit: number | null;
    credit: number | null;
    balance: number;
    currency: string;
    totalAmountLocal: number;
    currencyLocal: string;
    vatTotal: number | null;
    totalExclVat: number;
    accountName: string;
    accountIban: string;
    counterpartyName: string;
    counterpartyIban: string;
    paymentMethod: string;
    cardName: string;
    initiatedBy: string;
    initiatorEmail: string;
    team: string;
    transactionId: string;
    reference: string;
    note: string;
    bank: string;
    cashflowCategory: string;
    cashflowSubcategory: string;
}

export interface QontoExportSummary {
    file: string;
    totalTransactions: number;
    dateRange: { from: string; to: string };
    accountName: string;
    accountIban: string;
    totalIncome: number;
    totalExpenses: number;
    netAmount: number;
    currency: string;
    categorySummary: Array<{ category: string; count: number; total: number }>;
}

export interface QontoExportSearchParams {
    query?: string;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
    category?: string;
    type?: 'income' | 'expense';
    limit?: number;
}
