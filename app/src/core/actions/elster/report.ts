/**
 * USt-VA report generation and formatting, extracted from commands/elster.ts.
 * Fetches Qonto transactions for comparison and formats the report output.
 */

import { getDefaultBankAccountId, listTransactions } from '../../clients/qonto/index.ts';
import type { Transaction } from '../../clients/qonto/types.ts';
import type { ElsterConfig, ElsterPeriod } from '../../config/index.ts';
import type { UstvaAggregateWithDetails } from '../../elster/index.ts';
import { validateUstvaDetails, type UstvaDetailsValidationResult } from './validate.ts';

/** Qonto tx amount in EUR (API may return amount or amount_cents). */
function qontoAmountEur(tx: Transaction): number {
    const withAmount = tx as Transaction & { amount?: number };
    if (typeof withAmount.amount === 'number') return withAmount.amount;
    return (tx.amount_cents ?? 0) / 100;
}

/** Qonto tx VAT in EUR if present. */
function qontoVatEur(tx: Transaction): number | null {
    const withVat = tx as Transaction & { vat_amount?: number; vat_amount_cents?: number };
    if (typeof withVat.vat_amount === 'number') return withVat.vat_amount;
    if (typeof withVat.vat_amount_cents === 'number') return withVat.vat_amount_cents / 100;
    return null;
}

function qontoLabel(tx: Transaction): string {
    const withLabel = tx as Transaction & { label?: string };
    return withLabel.label ?? tx.note ?? '—';
}

export function formatReportPeriod(period: ElsterPeriod): string {
    if (period.quarter != null) return `Q${period.quarter}/${period.year}`;
    if (period.month != null) return `${String(period.month).padStart(2, '0')}/${period.year}`;
    return String(period.year);
}

export async function fetchQontoTransactionsForPeriod(
    dateFrom: string,
    dateTo: string,
): Promise<{ credits: Transaction[]; debits: Transaction[] } | null> {
    const bankAccountId = getDefaultBankAccountId();
    if (!bankAccountId) return null;
    const settledFrom = `${dateFrom}T00:00:00.000Z`;
    const settledTo = `${dateTo}T23:59:59.999Z`;
    const all = await listTransactions({
        bankAccountId,
        settled_at_from: settledFrom,
        settled_at_to: settledTo,
    });
    const credits = all.filter((t) => t.side === 'credit');
    const debits = all.filter((t) => t.side === 'debit');
    return { credits, debits };
}

export interface UstvaReportJsonOutput {
    aggregate: UstvaAggregateWithDetails['aggregate'];
    outgoing: UstvaAggregateWithDetails['outgoing'];
    incoming: UstvaAggregateWithDetails['incoming'];
    dateFrom: string;
    dateTo: string;
    validation: UstvaDetailsValidationResult;
    qonto: {
        credits: Array<{ settled_at: string | null; amount: number; vat_amount: number | null; label: string }>;
        debits: Array<{ settled_at: string | null; amount: number; vat_amount: number | null; label: string }>;
    } | null;
}

export async function buildReportJson(result: UstvaAggregateWithDetails): Promise<UstvaReportJsonOutput> {
    const validation = validateUstvaDetails(result);
    const qonto = await fetchQontoTransactionsForPeriod(result.dateFrom, result.dateTo);
    return {
        ...result,
        validation,
        qonto: qonto
            ? {
                  credits: qonto.credits.map((t) => ({
                      settled_at: t.settled_at ?? t.emitted_at,
                      amount: qontoAmountEur(t),
                      vat_amount: qontoVatEur(t),
                      label: qontoLabel(t),
                  })),
                  debits: qonto.debits.map((t) => ({
                      settled_at: t.settled_at ?? t.emitted_at,
                      amount: qontoAmountEur(t),
                      vat_amount: qontoVatEur(t),
                      label: qontoLabel(t),
                  })),
              }
            : null,
    };
}

/** Resolve display currency: non-EUR currencies shown as-is, null/EUR → 'EUR'. */
function displayCurrency(invoiceCurrency: string | null | undefined): string {
    if (!invoiceCurrency) return 'EUR';
    const upper = invoiceCurrency.toUpperCase();
    return upper === 'EUR' ? 'EUR' : invoiceCurrency;
}

function currencySuffix(currency: string): string {
    return currency === 'EUR' ? ' €' : ` ${currency}`;
}

export async function printReport(result: UstvaAggregateWithDetails, config: ElsterConfig): Promise<void> {
    const periodLabel = formatReportPeriod(config.period);
    console.log(`USt-VA report for ${periodLabel} (${result.dateFrom} – ${result.dateTo})\n`);
    console.log('Summary (used in XML):');
    console.log(`  kz81 (Netto 19 %):  ${result.aggregate.net_19.toFixed(2)} €`);
    console.log(`  kz86 (Netto 7 %):   ${result.aggregate.net_7.toFixed(2)} €`);
    console.log(`  kz66 (Vorsteuer):   ${result.aggregate.vat_in.toFixed(2)} €\n`);

    console.log('Outgoing invoices (paid in period, qonto_settled_at):');
    if (result.outgoing.length === 0) {
        console.log('  (none)');
    } else {
        for (const d of result.outgoing) {
            const curr = displayCurrency(d.invoice_currency);
            const suffix = currencySuffix(curr);
            const net = d.total_net != null ? `${d.total_net.toFixed(2)}${suffix}` : '—';
            const vat = d.tax_amount != null ? `${d.tax_amount.toFixed(2)}${suffix}` : '—';
            const rate = d.tax_rate != null ? `${d.tax_rate} %` : '—';
            console.log(`  #${d.id}  ${d.date_used ?? '—'}  Netto: ${net}  USt: ${vat}  (${rate})  ${d.title ?? '—'}`);
        }
    }

    console.log('\nIncoming invoices (date in period):');
    if (result.incoming.length === 0) {
        console.log('  (none)');
    } else {
        for (const d of result.incoming) {
            const curr = displayCurrency(d.invoice_currency);
            const suffix = currencySuffix(curr);
            const vat = d.tax_amount != null ? `${d.tax_amount.toFixed(2)}${suffix}` : '—';
            console.log(`  #${d.id}  ${d.date_used ?? '—'}  Vorsteuer: ${vat}  ${d.title ?? '—'}`);
        }
    }

    const detailsValidation = validateUstvaDetails(result);
    printValidation(detailsValidation);

    const qonto = await fetchQontoTransactionsForPeriod(result.dateFrom, result.dateTo);
    if (qonto) {
        printQontoComparison(qonto);
    } else {
        console.log(
            '\n(Qonto comparison skipped: set QONTO_PRODUCTION_DEFAULT_BANK_ACCOUNT_ID or QONTO_DEFAULT_BANK_ACCOUNT_ID in .env to include Qonto transactions.)',
        );
    }
}

function printValidation(v: UstvaDetailsValidationResult): void {
    console.log('\n--- Validation (required custom fields) ---');
    if (v.missingRequiredOutgoing.length > 0) {
        console.log(`  Outgoing (total_net, tax_amount required). Missing: #${v.missingRequiredOutgoing.join(', #')}`);
    } else {
        console.log('  Outgoing: all have total_net and tax_amount.');
    }
    if (v.missingRequiredIncoming.length > 0) {
        console.log(`  Incoming (tax_amount required). Missing: #${v.missingRequiredIncoming.join(', #')}`);
    } else {
        console.log('  Incoming: all have tax_amount.');
    }
    console.log('\n--- Qonto vs invoice amount (from document fields) ---');
    console.log(
        '  (If one invoice is attached to multiple Qonto transactions (e.g. fee breakdown), the stored amount may be a partial; mismatch can be ignored.)',
    );
    if (v.missingQontoFields.length > 0) {
        for (const f of v.missingQontoFields) {
            console.log(
                `  #${f.id} ${f.title ?? '—'}: Qonto-Betrag oder -Währung fehlt auf dem Beleg – run sync match-qonto-paperless.`,
            );
        }
    }
    const seenCurrencyIds = new Set<number>();
    if (v.currencySkipped.length > 0) {
        for (const c of v.currencySkipped) {
            if (seenCurrencyIds.has(c.id)) continue;
            seenCurrencyIds.add(c.id);
            console.log(
                `  #${c.id} ${c.title ?? '—'}: invoice ${c.invoiceCurrency}, Qonto ${c.qontoCurrency} – amount comparison skipped (different currencies).`,
            );
        }
    }
    const seenMismatchIds = new Set<number>();
    if (v.qontoMismatches.length > 0) {
        for (const m of v.qontoMismatches) {
            if (seenMismatchIds.has(m.id)) continue;
            seenMismatchIds.add(m.id);
            console.log(
                `  Mismatch #${m.id} ${m.title ?? '—'}: Qonto ${m.qontoAmount.toFixed(2)} € vs invoice ${m.invoiceAmount.toFixed(2)} €`,
            );
        }
    } else if (v.currencySkipped.length === 0 && v.missingQontoFields.length === 0) {
        console.log('  All documents with Qonto link match invoice amount (within 0.01 €).');
    }
}

function printQontoComparison(qonto: { credits: Transaction[]; debits: Transaction[] }): void {
    const creditSum = qonto.credits.reduce((s, t) => s + qontoAmountEur(t), 0);
    const creditVatSum = qonto.credits.reduce((s, t) => s + (qontoVatEur(t) ?? 0), 0);
    const debitSum = qonto.debits.reduce((s, t) => s + qontoAmountEur(t), 0);
    const debitVatSum = qonto.debits.reduce((s, t) => s + (qontoVatEur(t) ?? 0), 0);

    console.log('\n--- Qonto transactions (same period, for comparison) ---');
    console.log('\nCredits (Einnahmen):');
    if (qonto.credits.length === 0) {
        console.log('  (none)');
    } else {
        for (const t of qonto.credits) {
            const date = (t.settled_at ?? t.emitted_at ?? '').slice(0, 10) || '—';
            const vat = qontoVatEur(t);
            const vatStr = vat != null ? `  USt: ${vat.toFixed(2)} €` : '';
            console.log(`  ${date}  ${qontoAmountEur(t).toFixed(2)} €${vatStr}  ${qontoLabel(t)}`);
        }
        console.log(`  → Sum: ${creditSum.toFixed(2)} €  (USt from Qonto: ${creditVatSum.toFixed(2)} €)`);
    }
    console.log('\nDebits (Ausgaben / Vorsteuer):');
    if (qonto.debits.length === 0) {
        console.log('  (none)');
    } else {
        for (const t of qonto.debits) {
            const date = (t.settled_at ?? t.emitted_at ?? '').slice(0, 10) || '—';
            const vat = qontoVatEur(t);
            const vatStr = vat != null ? `  Vorsteuer: ${vat.toFixed(2)} €` : '';
            console.log(`  ${date}  ${qontoAmountEur(t).toFixed(2)} €${vatStr}  ${qontoLabel(t)}`);
        }
        console.log(`  → Sum: ${debitSum.toFixed(2)} €  (Vorsteuer from Qonto: ${debitVatSum.toFixed(2)} €)`);
    }
}
