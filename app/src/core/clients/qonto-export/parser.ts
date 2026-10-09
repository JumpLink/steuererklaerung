/**
 * Parser for Qonto XLS transaction export files.
 */

import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import type { QontoExportTransaction } from './types.ts';

/** Column indices in the Qonto export XLS (0-based). */
const COL = {
    STATUS: 0,
    SETTLED_UTC: 1,
    SETTLED_LOCAL: 2,
    OPERATION_UTC: 3,
    OPERATION_LOCAL: 4,
    TOTAL_AMOUNT: 5,
    DEBIT: 6,
    CREDIT: 7,
    BALANCE: 8,
    CURRENCY: 9,
    TOTAL_AMOUNT_LOCAL: 10,
    CURRENCY_LOCAL: 11,
    VAT_TOTAL: 12,
    TOTAL_EXCL_VAT: 13,
    ACCOUNT_NAME: 20,
    ACCOUNT_IBAN: 21,
    COUNTERPARTY_NAME: 22,
    COUNTERPARTY_IBAN: 23,
    PAYMENT_METHOD: 24,
    CARD_NAME: 25,
    INITIATED_BY: 26,
    INITIATOR_EMAIL: 27,
    TEAM: 28,
    TRANSACTION_ID: 32,
    REFERENCE: 33,
    NOTE: 34,
    BANK: 35,
    CASHFLOW_CATEGORY: 37,
    CASHFLOW_SUBCATEGORY: 38,
} as const;

function str(row: unknown[], idx: number): string {
    const v = row[idx];
    return v != null ? String(v).trim() : '';
}

function num(row: unknown[], idx: number): number {
    const v = row[idx];
    if (v == null || v === '') return 0;
    return typeof v === 'number' ? v : parseFloat(String(v)) || 0;
}

function numOrNull(row: unknown[], idx: number): number | null {
    const v = row[idx];
    if (v == null || v === '') return null;
    return typeof v === 'number' ? v : parseFloat(String(v)) || null;
}

function parseRow(row: unknown[]): QontoExportTransaction {
    return {
        status: str(row, COL.STATUS),
        settledAtUtc: str(row, COL.SETTLED_UTC),
        settledAtLocal: str(row, COL.SETTLED_LOCAL),
        operationDateUtc: str(row, COL.OPERATION_UTC),
        operationDateLocal: str(row, COL.OPERATION_LOCAL),
        totalAmount: num(row, COL.TOTAL_AMOUNT),
        debit: numOrNull(row, COL.DEBIT),
        credit: numOrNull(row, COL.CREDIT),
        balance: num(row, COL.BALANCE),
        currency: str(row, COL.CURRENCY),
        totalAmountLocal: num(row, COL.TOTAL_AMOUNT_LOCAL),
        currencyLocal: str(row, COL.CURRENCY_LOCAL),
        vatTotal: numOrNull(row, COL.VAT_TOTAL),
        totalExclVat: num(row, COL.TOTAL_EXCL_VAT),
        accountName: str(row, COL.ACCOUNT_NAME),
        accountIban: str(row, COL.ACCOUNT_IBAN),
        counterpartyName: str(row, COL.COUNTERPARTY_NAME),
        counterpartyIban: str(row, COL.COUNTERPARTY_IBAN),
        paymentMethod: str(row, COL.PAYMENT_METHOD),
        cardName: str(row, COL.CARD_NAME),
        initiatedBy: str(row, COL.INITIATED_BY),
        initiatorEmail: str(row, COL.INITIATOR_EMAIL),
        team: str(row, COL.TEAM),
        transactionId: str(row, COL.TRANSACTION_ID),
        reference: str(row, COL.REFERENCE),
        note: str(row, COL.NOTE),
        bank: str(row, COL.BANK),
        cashflowCategory: str(row, COL.CASHFLOW_CATEGORY),
        cashflowSubcategory: str(row, COL.CASHFLOW_SUBCATEGORY),
    };
}

/** Parse a date string like "07-11-2025 12:35:14" to "2025-11-07". */
function toIsoDate(dateStr: string): string {
    const match = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})/);
    if (!match) return '';
    return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseQontoExport(filePath: string): QontoExportTransaction[] {
    const buf = readFileSync(filePath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

    // Skip header row
    return rows
        .slice(1)
        .filter((row) => row.length > 0)
        .map(parseRow);
}

/** Get ISO date from a transaction's operation date. */
export function getTransactionDate(tx: QontoExportTransaction): string {
    return toIsoDate(tx.operationDateLocal || tx.operationDateUtc);
}
