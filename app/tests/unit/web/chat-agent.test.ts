import { describe, it, expect } from '@gjsify/unit';
import { selectTransactions, type Row } from '../../../src/core/actions/assistant/chat-agent.ts';

const rows: Row[] = [
    {
        id: 'a',
        bookingDate: '2025-02-10',
        counterparty: 'Hetzner',
        purpose: 'Server',
        amount: -119,
        kind: 'expense',
        source: 'document',
        category: 'EDV',
        net: -100,
        vat: -19,
        gross: -119,
        receipt: { net: -100, gross: -119, vat: -19 },
    },
    {
        id: 'b',
        bookingDate: '2025-03-05',
        counterparty: 'Kunde GmbH',
        purpose: 'Rechnung 1',
        amount: 1190,
        kind: 'income',
        source: 'rule',
        category: 'Erlöse',
        net: 1000,
        vat: 190,
        gross: 1190,
        receipt: null,
    },
    {
        id: 'c',
        bookingDate: '2025-03-20',
        counterparty: 'Amazon',
        purpose: 'Büro',
        amount: -59.5,
        kind: 'expense',
        source: 'unclassified',
        category: 'Sonstiges',
        net: -50,
        vat: -9.5,
        gross: -59.5,
        receipt: null,
    },
    {
        id: 'd',
        bookingDate: '2025-06-01',
        counterparty: 'Bahn',
        purpose: 'Reise',
        amount: -238,
        kind: 'expense',
        source: 'document',
        category: 'Reise',
        net: -200,
        vat: -38,
        gross: -238,
        receipt: { net: -200, gross: -238, vat: -38 },
    },
];

const ids = (a: Parameters<typeof selectTransactions>[1]) => selectTransactions(rows, a).rows.map((r) => r.id);

export default async () => {
    await describe('chat-agent selectTransactions', async () => {
        await it('default sort is |net| descending', async () => {
            expect(ids({})).toStrictEqual(['b', 'd', 'a', 'c']);
        });
        await it('filters by kind', async () => {
            expect(ids({ kind: 'expense' })).toStrictEqual(['d', 'a', 'c']);
        });
        await it('filters by classification source', async () => {
            expect(ids({ classification: 'unclassified' })).toStrictEqual(['c']);
        });
        await it('filters by booking month', async () => {
            expect(ids({ month: 3 })).toStrictEqual(['b', 'c']);
        });
        await it('full-text matches counterparty / purpose / category', async () => {
            expect(ids({ query: 'amazon' })).toStrictEqual(['c']);
            expect(ids({ query: 'reise' })).toStrictEqual(['d']);
        });
        await it('withoutReceiptOnly = Vorsteuer-expense without a receipt', async () => {
            expect(ids({ withoutReceiptOnly: true })).toStrictEqual(['c']);
        });
        await it('filters by minimum |net|', async () => {
            expect(ids({ minAbsAmount: 150 })).toStrictEqual(['b', 'd']);
        });
        await it('sorts by date when asked', async () => {
            expect(ids({ sort: 'date' })).toStrictEqual(['a', 'b', 'c', 'd']);
        });
        await it('limits the rows but reports the full total', async () => {
            const r = selectTransactions(rows, { limit: 2 });
            expect(r.total).toBe(4);
            expect(r.shown).toBe(2);
            expect(r.rows.map((x) => x.id)).toStrictEqual(['b', 'd']);
        });
        await it('compact rows carry hasReceipt', async () => {
            const r = selectTransactions(rows, { kind: 'expense', sort: 'date' });
            expect(r.rows.map((x) => x.hasReceipt)).toStrictEqual([true, false, true]);
        });
    });
};
