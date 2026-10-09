import { describe, it, expect } from '@gjsify/unit';
import {
    criteriaFromDmsDocument,
    suggestDocumentsForTransaction,
    suggestTransactionsForDocument,
} from '../../../src/core/lib/transactions/link-candidates.ts';
import type { DmsDocument } from '@steuererklaerung/dms';
import type { UnifiedTransaction } from '@steuererklaerung/store';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'tx',
        source: 'camt',
        accountKey: 'camt:acc',
        bookingDate: '2025-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}

function doc(over: Partial<DmsDocument>): DmsDocument {
    return {
        id: 'doc',
        dms: 'builtin',
        title: 'Rechnung',
        correspondent: 'Hetzner Online GmbH',
        documentType: 'incoming_invoice',
        direction: 'incoming',
        created: '2025-03-08',
        added: '2025-03-08',
        tags: [],
        invoiceNumber: null,
        net: null,
        gross: 119,
        vat: 19,
        linkedTxIds: [],
        mimeType: 'application/pdf',
        pageCount: 1,
        ocrText: null,
        ocrSource: null,
        aiNote: null,
        ...over,
    };
}

export default async () => {
    await describe('criteriaFromDmsDocument', async () => {
        await it('derives gross/direction/date/correspondent from a document', async () => {
            const c = criteriaFromDmsDocument(doc({}));
            expect(c?.grossAmount).toBe(119);
            expect(c?.direction).toBe('incoming');
            expect(c?.invoiceDate).toBe('2025-03-08');
            expect(c?.counterpartyName).toBe('Hetzner Online GmbH');
        });

        await it('falls back to net + vat when gross is missing', async () => {
            const c = criteriaFromDmsDocument(doc({ gross: null, net: 100, vat: 19 }));
            expect(c?.grossAmount).toBe(119);
        });

        await it('returns null without a direction or an amount', async () => {
            expect(criteriaFromDmsDocument(doc({ direction: null }))).toBeNull();
            expect(criteriaFromDmsDocument(doc({ gross: null, net: null }))).toBeNull();
        });
    });

    await describe('suggestDocumentsForTransaction', async () => {
        await it('ranks the exact-amount, nearest-date incoming invoice first for a debit', async () => {
            const debit = tx({ id: 'd', amount: -119, bookingDate: '2025-03-10', counterparty: 'Hetzner Online GmbH' });
            const docs = [
                doc({ id: 'match', gross: 119, created: '2025-03-08' }),
                doc({ id: 'far', gross: 119, created: '2025-01-01' }),
                doc({ id: 'wrong-amount', gross: 200, created: '2025-03-09' }),
            ];
            const cands = suggestDocumentsForTransaction(debit, docs);
            expect(cands[0].documentId).toBe('match');
            expect(cands[0].score).toBeGreaterThan(0.6);
            expect(cands[0].reasons).toContain('Betrag exakt');
            expect(cands[0].reasons).toContain('Korrespondent ähnlich');
            // The 200-EUR invoice is outside the amount tolerance → not a candidate at all.
            expect(cands.some((c) => c.documentId === 'wrong-amount')).toBe(false);
        });

        await it('only offers incoming invoices for a debit (direction filter)', async () => {
            const debit = tx({ amount: -119 });
            const outgoing = doc({ id: 'out', direction: 'outgoing', gross: 119 });
            expect(suggestDocumentsForTransaction(debit, [outgoing])).toHaveLength(0);
        });

        await it('only offers outgoing invoices for a credit', async () => {
            const credit = tx({ amount: 119, bookingDate: '2025-03-10' });
            const docs = [
                doc({ id: 'out', direction: 'outgoing', gross: 119, created: '2025-03-09' }),
                doc({ id: 'in', direction: 'incoming', gross: 119, created: '2025-03-09' }),
            ];
            const cands = suggestDocumentsForTransaction(credit, docs);
            expect(cands.map((c) => c.documentId)).toStrictEqual(['out']);
        });

        await it('skips documents already linked to a transaction by default', async () => {
            const debit = tx({ amount: -119 });
            const linked = doc({ id: 'used', gross: 119, linkedTxIds: ['someOther'] });
            expect(suggestDocumentsForTransaction(debit, [linked])).toHaveLength(0);
            // …unless explicitly asked to include them.
            expect(suggestDocumentsForTransaction(debit, [linked], { excludeLinked: false })).toHaveLength(1);
        });

        await it('reports German date reasons relative to the booking', async () => {
            const debit = tx({ amount: -119, bookingDate: '2025-03-10' });
            const cands = suggestDocumentsForTransaction(debit, [doc({ id: 's', gross: 119, created: '2025-03-10' })]);
            expect(cands[0].reasons).toContain('gleiches Datum');
        });
    });

    await describe('suggestTransactionsForDocument', async () => {
        await it('ranks the matching debit for an incoming invoice', async () => {
            const invoice = doc({ id: 'inv', direction: 'incoming', gross: 119, created: '2025-03-08' });
            const txs = [
                tx({ id: 'hit', amount: -119, bookingDate: '2025-03-10', counterparty: 'Hetzner Online GmbH' }),
                tx({ id: 'credit', amount: 119, bookingDate: '2025-03-10' }),
            ];
            const cands = suggestTransactionsForDocument(invoice, txs);
            expect(cands[0].transactionId).toBe('hit');
            expect(cands.some((c) => c.transactionId === 'credit')).toBe(false);
            expect(cands[0].score).toBeGreaterThan(0.6);
        });
    });
};
