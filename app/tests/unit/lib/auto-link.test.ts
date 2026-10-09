import { describe, expect, it } from '@gjsify/unit';
import type { DmsDocument } from '@steuererklaerung/dms';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { planAutoLinks } from '../../../src/core/lib/transactions/auto-link.ts';

// @gjsify/unit's toEqual is `==`, so lists are asserted as joined strings via toBe.
function doc(over: Partial<DmsDocument>): DmsDocument {
    return {
        id: 'd1',
        dms: 'builtin',
        title: 'Rechnung',
        correspondent: 'ACME GmbH',
        documentType: null,
        direction: 'incoming',
        created: '2025-06-01',
        added: '2025-06-01',
        tags: [],
        invoiceNumber: null,
        net: null,
        gross: 119,
        vat: null,
        linkedTxIds: [],
        mimeType: 'application/pdf',
        pageCount: 1,
        ocrText: null,
        ocrSource: null,
        aiNote: null,
        ...over,
    };
}

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 't1',
        source: 'camt',
        accountKey: 'camt:DE123',
        bookingDate: '2025-06-01',
        amount: -119,
        currency: 'EUR',
        counterparty: 'ACME GmbH',
        ...over,
    } as UnifiedTransaction;
}

export default async () => {
    await describe('lib/transactions/auto-link — planAutoLinks', async () => {
        await it('plans the unambiguous hit (exact amount + date) and reports its reasons', async () => {
            const plan = planAutoLinks([tx({})], [doc({})]);
            expect(plan.planned.length).toBe(1);
            expect(plan.planned[0].txId).toBe('t1');
            expect(plan.planned[0].documentId).toBe('d1');
            expect(plan.planned[0].score >= 0.6).toBe(true);
            expect(plan.planned[0].reasons.includes('Betrag exakt')).toBe(true);
            expect(plan.ambiguous.length).toBe(0);
            expect(plan.unmatched.length).toBe(0);
        });

        await it('leaves a too-close race for hand-review (nur eindeutige Treffer)', async () => {
            // Two same-amount receipts 0 vs. 6 days off — the lead stays under 0.15.
            const plan = planAutoLinks(
                [tx({})],
                [doc({ id: 'a', created: '2025-06-01' }), doc({ id: 'b', created: '2025-06-07' })],
            );
            expect(plan.planned.length).toBe(0);
            expect(plan.ambiguous.join(',')).toBe('t1');
        });

        await it('reports a booking without any candidate as unmatched', async () => {
            const plan = planAutoLinks([tx({ amount: -42 })], [doc({})]);
            expect(plan.planned.length).toBe(0);
            expect(plan.unmatched.join(',')).toBe('t1');
        });

        await it('claims each receipt once, chronologically (one doc, two bookings)', async () => {
            const plan = planAutoLinks(
                [tx({ id: 'later', bookingDate: '2025-06-10' }), tx({ id: 'earlier', bookingDate: '2025-06-01' })],
                [doc({})],
            );
            expect(plan.planned.length).toBe(1);
            expect(plan.planned[0].txId).toBe('earlier');
            expect(plan.unmatched.join(',')).toBe('later');
        });

        await it('never offers an already-linked receipt', async () => {
            const plan = planAutoLinks([tx({})], [doc({ linkedTxIds: ['other-tx'] })]);
            expect(plan.planned.length).toBe(0);
            expect(plan.unmatched.join(',')).toBe('t1');
        });

        await it('gates on the RAW score — a 30-day rival above the display clamp stays a clear win', async () => {
            // Same amount + name: raw ~110 (same day) vs ~90 (30-day gap) — raw lead 20 ≥ 15 is
            // confident, but the clamped 0..1 display scores (1.0 vs 0.9) would call it ambiguous.
            const plan = planAutoLinks(
                [tx({})],
                [doc({ id: 'exact', created: '2025-06-01' }), doc({ id: 'monthoff', created: '2025-07-01' })],
            );
            expect(plan.planned.length).toBe(1);
            expect(plan.planned[0].documentId).toBe('exact');
            expect(plan.ambiguous.length).toBe(0);
        });

        await it('mutual check over allTxs: a receipt is not claimed when its true payment lies outside the gap set', async () => {
            // Gap booking T1 (19 days off) would confidently claim D — but D's real payment T2
            // (same day) is outside the worklist. With allTxs the doc-side check sees T2 and refuses.
            const t1 = tx({ id: 'T1', bookingDate: '2025-06-20' });
            const t2 = tx({ id: 'T2', bookingDate: '2025-06-01' });
            const d = doc({ id: 'D', created: '2025-06-01' });
            const without = planAutoLinks([t1], [d]);
            expect(without.planned.length).toBe(1); // blind to T2 — would mispair
            const withAll = planAutoLinks([t1], [d], { allTxs: [t1, t2] });
            expect(withAll.planned.length).toBe(0);
            expect(withAll.ambiguous.join(',')).toBe('T1');
        });

        await it('mutual best match: an earlier booking cannot steal the receipt of a better later one', async () => {
            // Receipt D (06-07) belongs to booking B (same day); booking A (06-05) also matches D
            // confidently from its side — without the mutual check the earlier A would claim D.
            const plan = planAutoLinks(
                [tx({ id: 'A', bookingDate: '2025-06-05' }), tx({ id: 'B', bookingDate: '2025-06-07' })],
                [doc({ id: 'D', created: '2025-06-07' })],
            );
            expect(plan.planned.length).toBe(1);
            expect(plan.planned[0].txId).toBe('B');
            expect(plan.planned[0].documentId).toBe('D');
            expect(plan.ambiguous.join(',')).toBe('A');
        });
    });
};
