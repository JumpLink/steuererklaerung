/**
 * USt-VA validation logic extracted from commands/elster.ts.
 * Validates document custom fields and compares Qonto vs invoice amounts.
 */

import type { UstvaAggregateWithDetails, UstvaDocumentDetail } from '../../elster/index.ts';
import { DEFAULTS } from '../../constants.ts';

const QONTO_INVOICE_AMOUNT_TOLERANCE = DEFAULTS.AMOUNT_TOLERANCE_EUR;

export interface UstvaDetailsValidationResult {
    missingRequiredOutgoing: number[];
    missingRequiredIncoming: number[];
    qontoMismatches: Array<{
        id: number;
        title: string | null;
        qontoAmount: number;
        invoiceAmount: number;
    }>;
    currencySkipped: Array<{
        id: number;
        title: string | null;
        invoiceCurrency: string;
        qontoCurrency: string;
    }>;
    missingQontoFields: Array<{
        id: number;
        title: string | null;
    }>;
}

function invoiceAmount(d: UstvaDocumentDetail): number | null {
    if (d.total_gross != null && !Number.isNaN(d.total_gross)) return d.total_gross;
    if (d.total_net != null && !Number.isNaN(d.total_net) && d.tax_amount != null && !Number.isNaN(d.tax_amount))
        return Math.round((d.total_net + d.tax_amount) * 100) / 100;
    return null;
}

function normalizeCurrency(c: string | null | undefined): string {
    if (c == null || typeof c !== 'string') return '';
    return c.trim().toUpperCase();
}

function validateQontoFromDocFields(
    d: UstvaDocumentDetail,
    qontoMismatches: UstvaDetailsValidationResult['qontoMismatches'],
    currencySkipped: UstvaDetailsValidationResult['currencySkipped'],
    missingQontoFields: UstvaDetailsValidationResult['missingQontoFields'],
): void {
    const txId = d.qonto_transaction_id;
    if (!txId) return;
    if (d.qonto_transaction_amount == null || !d.qonto_currency) {
        missingQontoFields.push({ id: d.id, title: d.title ?? null });
        return;
    }
    const invCurrency = normalizeCurrency(d.invoice_currency);
    const qontoCurrency = normalizeCurrency(d.qonto_currency);
    if (invCurrency && qontoCurrency && invCurrency !== qontoCurrency) {
        currencySkipped.push({
            id: d.id,
            title: d.title ?? null,
            invoiceCurrency: invCurrency,
            qontoCurrency,
        });
        return;
    }
    const invAmount = invoiceAmount(d);
    if (invAmount == null) return;
    const qAbs = Math.abs(d.qonto_transaction_amount);
    if (Math.abs(qAbs - invAmount) <= QONTO_INVOICE_AMOUNT_TOLERANCE) return;
    qontoMismatches.push({
        id: d.id,
        title: d.title ?? null,
        qontoAmount: d.qonto_transaction_amount,
        invoiceAmount: invAmount,
    });
}

/**
 * Validate USt-VA document details: required custom fields and Qonto vs invoice amounts.
 */
export function validateUstvaDetails(result: UstvaAggregateWithDetails): UstvaDetailsValidationResult {
    const missingRequiredOutgoing: number[] = [];
    const missingRequiredIncoming: number[] = [];
    const qontoMismatches: UstvaDetailsValidationResult['qontoMismatches'] = [];
    const currencySkipped: UstvaDetailsValidationResult['currencySkipped'] = [];
    const missingQontoFields: UstvaDetailsValidationResult['missingQontoFields'] = [];

    for (const d of result.outgoing) {
        if (d.total_net == null || d.tax_amount == null) missingRequiredOutgoing.push(d.id);
        validateQontoFromDocFields(d, qontoMismatches, currencySkipped, missingQontoFields);
    }
    for (const d of result.incoming) {
        if (d.tax_amount == null) missingRequiredIncoming.push(d.id);
        validateQontoFromDocFields(d, qontoMismatches, currencySkipped, missingQontoFields);
    }

    return {
        missingRequiredOutgoing,
        missingRequiredIncoming,
        qontoMismatches,
        currencySkipped,
        missingQontoFields,
    };
}
