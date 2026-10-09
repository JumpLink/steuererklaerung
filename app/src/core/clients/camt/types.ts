/**
 * Types for CAMT.052/053 transaction exports.
 * Re-exports lib-fints Statement/Transaction types and adds search/summary types.
 */

export type { Statement, Transaction, Balance } from 'lib-fints';

export interface CamtAccount {
    iban: string;
    currency: string;
    ownerName: string;
    bankName: string;
    bic: string;
}

/** A statement's own metadata; every field is absent when the file does not carry it. */
export interface CamtStatementInfo {
    from?: string;
    to?: string;
    seq?: number;
    opening?: { date?: string; value: number };
    closing?: { date?: string; value: number };
}

export interface CamtExportSummary {
    files: string[];
    account: CamtAccount;
    totalStatements: number;
    totalTransactions: number;
    dateRange: { from: string; to: string };
    totalIncome: number;
    totalExpenses: number;
    netAmount: number;
    currency: string;
}

export interface CamtSearchParams {
    query?: string;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
    type?: 'income' | 'expense';
    limit?: number;
}
