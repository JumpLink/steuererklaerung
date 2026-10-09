import { describe, it, expect } from '@gjsify/unit';
import { aggregateEuer, SKR03_TO_EUER } from '../../../src/core/elster/euer-aggregate.ts';
import type { Document } from '@steuererklaerung/paperless';
import type { SyncConfig } from '../../../src/core/config/index.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

// Minimal config: only the fields aggregateEuer reads.
const CF = {
    qonto_settled_at: 31,
    total_net: 43,
    total_gross: 44,
    tax_amount: 45,
    accounting_category: 36,
};
const config = {
    custom_field_ids: CF,
    document_type_ids: { incoming_invoice: 10, outgoing_invoice: 11 },
    select_field_options: { accounting_category: {} },
} as unknown as SyncConfig;

let nextId = 1;
function doc(opts: {
    type: 'incoming' | 'outgoing';
    settled?: string;
    category?: string;
    net?: number;
    tax?: number;
    gross?: number;
}): Document {
    const fields: Array<{ field: number; value: unknown }> = [];
    if (opts.settled) fields.push({ field: CF.qonto_settled_at, value: opts.settled });
    if (opts.category) fields.push({ field: CF.accounting_category, value: opts.category });
    if (opts.net != null) fields.push({ field: CF.total_net, value: `EUR${opts.net.toFixed(2)}` });
    if (opts.tax != null) fields.push({ field: CF.tax_amount, value: `EUR${opts.tax.toFixed(2)}` });
    if (opts.gross != null) fields.push({ field: CF.total_gross, value: `EUR${opts.gross.toFixed(2)}` });
    return {
        id: nextId++,
        document_type: opts.type === 'incoming' ? 10 : 11,
        created: '2025-06-01',
        custom_fields: fields,
    } as unknown as Document;
}

export default async () => {
    await describe('SKR03_TO_EUER', async () => {
        await it('classifies the revenue and expense categories by kind', async () => {
            expect(SKR03_TO_EUER['8400 Erlöse 19% USt'].kind).toBe('income');
            expect(SKR03_TO_EUER['4946 Fremdleistungen'].kind).toBe('expense');
            expect(SKR03_TO_EUER['1800 Privatentnahme'].kind).toBe('neutral');
        });
    });

    await describe('aggregateEuer', async () => {
        await it('sums income and expenses on a cash basis and computes profit + VAT', async () => {
            const docs = [
                doc({ type: 'outgoing', settled: '2025-03-10', category: '8400 Erlöse 19% USt', net: 1000, tax: 190, gross: 1190 }),
                doc({ type: 'outgoing', settled: '2025-09-01', category: '8400 Erlöse 19% USt', net: 500, tax: 95, gross: 595 }),
                doc({ type: 'incoming', settled: '2025-04-01', category: '4946 Fremdleistungen', net: 200, tax: 38, gross: 238 }),
                doc({ type: 'incoming', settled: '2025-05-01', category: '4806 Hosting/Cloud', net: 100, tax: 19, gross: 119 }),
            ];
            const agg = aggregateEuer(docs, config, 2025);
            expect(agg.totals.incomeNet).toBe(1500);
            expect(agg.totals.outputVat).toBe(285);
            expect(agg.totals.expenseNet).toBe(300);
            expect(agg.totals.inputVat).toBe(57);
            expect(agg.totals.profit).toBe(1200);
            expect(agg.totals.vatPayable).toBe(228);
            expect(agg.coverage.counted).toBe(4);
            // Two distinct expense categories, one income category.
            expect(agg.income).toHaveLength(1);
            expect(agg.income[0].count).toBe(2);
            expect(agg.expenses).toHaveLength(2);
        });

        await it('excludes documents paid outside the year as coverage gaps', async () => {
            const docs = [
                doc({ type: 'incoming', settled: '2024-12-30', category: '4806 Hosting/Cloud', net: 100, tax: 19 }),
                doc({ type: 'incoming', category: '4806 Hosting/Cloud', net: 50, tax: 9.5 }), // no payment date
            ];
            const agg = aggregateEuer(docs, config, 2025);
            expect(agg.coverage.counted).toBe(0);
            expect(agg.coverage.withoutPaymentDate).toHaveLength(2);
            expect(agg.totals.expenseNet).toBe(0);
        });

        await it('reports uncategorized documents and keeps neutral categories out of profit', async () => {
            const docs = [
                doc({ type: 'incoming', settled: '2025-02-01', net: 80, tax: 15.2 }), // no category
                doc({ type: 'incoming', settled: '2025-02-02', category: '1800 Privatentnahme', net: 300, tax: 0 }),
                doc({ type: 'outgoing', settled: '2025-02-03', category: '8400 Erlöse 19% USt', net: 1000, tax: 190 }),
            ];
            const agg = aggregateEuer(docs, config, 2025);
            expect(agg.coverage.uncategorized).toHaveLength(1);
            expect(agg.neutral.map((n) => n.category)).toContain('1800 Privatentnahme');
            expect(agg.totals.profit).toBe(1000); // neutral excluded
        });

        await it('flags a direction mismatch (incoming doc tagged as revenue)', async () => {
            const docs = [doc({ type: 'incoming', settled: '2025-03-01', category: '8400 Erlöse 19% USt', net: 100, tax: 19 })];
            const agg = aggregateEuer(docs, config, 2025);
            expect(agg.coverage.directionMismatch).toHaveLength(1);
        });

        await it('adds an informational cash-flow cross-check from store transactions', async () => {
            const docs = [doc({ type: 'outgoing', settled: '2025-03-10', category: '8400 Erlöse 19% USt', net: 1000, tax: 190, gross: 1190 })];
            const txs: UnifiedTransaction[] = [
                { id: 't1', source: 'camt', accountKey: 'camt:a', bookingDate: '2025-03-10', amount: 1190, currency: 'EUR' },
                { id: 't2', source: 'camt', accountKey: 'camt:a', bookingDate: '2025-04-01', amount: -238, currency: 'EUR' },
            ];
            const agg = aggregateEuer(docs, config, 2025, txs);
            expect(agg.crossCheck?.storeIncomeGross).toBe(1190);
            expect(agg.crossCheck?.incomeGrossDelta).toBe(0);
            expect(agg.crossCheck?.storeExpenseGross).toBe(238);
        });
    });
};
