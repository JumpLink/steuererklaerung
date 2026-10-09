import { describe, expect, it } from '@gjsify/unit';
import type { DmsDocument } from '@steuererklaerung/dms';
import type { EuerTxDetailRow } from '../../../src/core/elster/euer-transactions.ts';
import { buildDocByTx, joinReceipts, enrichRows } from '../../../src/core/presenters/buchungen.ts';

function doc(over: Partial<DmsDocument>): DmsDocument {
    return {
        id: '1',
        dms: 'builtin',
        title: 'Rechnung',
        correspondent: null,
        documentType: null,
        direction: 'incoming',
        created: '2025-06-01',
        added: '2025-06-02',
        tags: [],
        invoiceNumber: null,
        net: null,
        gross: null,
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

function row(over: Partial<EuerTxDetailRow>): EuerTxDetailRow {
    return {
        id: 't1',
        accountKey: 'camt:DE123',
        bookingDate: '2025-06-01',
        amount: -119,
        kind: 'expense',
        source: 'rule',
        category: '4210 Miete/Raumkosten',
        kz: '',
        net: -100,
        vat: -19,
        gross: -119,
        ...over,
    };
}

export default async () => {
    await describe('presenters/buchungen — receipt join', async () => {
        await it('buildDocByTx fans a doc out over every linked tx id, skips unlinked docs', async () => {
            const map = buildDocByTx([
                doc({ id: '7', invoiceNumber: 'RE-1', net: 100, gross: 119, vat: 19, linkedTxIds: ['a', 'b'] }),
                doc({ id: '8', linkedTxIds: [] }), // no link → skipped
            ]);
            expect(map.size).toBe(2); // a + b, from doc 7
            expect(map.get('a')?.docId).toBe(7);
            expect(map.get('a')?.invoiceNumber).toBe('RE-1');
            expect(map.get('b')?.vat).toBe(19);
            expect(map.has('c')).toBe(false);
        });

        await it('a later doc for the same tx id wins (last write)', async () => {
            const map = buildDocByTx([doc({ id: '1', linkedTxIds: ['x'] }), doc({ id: '2', linkedTxIds: ['x'] })]);
            expect(map.get('x')?.docId).toBe(2);
        });

        await it('joinReceipts attaches the matched receipt or null', async () => {
            const map = buildDocByTx([doc({ id: '9', linkedTxIds: ['t1'] })]);
            const joined = joinReceipts([row({ id: 't1' }), row({ id: 't2' })], map);
            expect(joined[0].receipt?.docId).toBe(9);
            expect(joined[1].receipt).toBe(null);
        });

        await it('enrichRows joins + adds the display account label (and pairs transfers)', async () => {
            const map = buildDocByTx([]);
            const rows = enrichRows(
                [
                    // Two legs of an internal transfer across two own accounts, same date + |amount|.
                    row({
                        id: 'out',
                        accountKey: 'camt:DE111',
                        amount: -500,
                        category: '1360 Interne Überweisung',
                        net: -500,
                        vat: 0,
                        gross: -500,
                    }),
                    row({
                        id: 'in',
                        accountKey: 'camt:DE222',
                        amount: 500,
                        kind: 'income',
                        category: '1360 Interne Überweisung',
                        net: 500,
                        vat: 0,
                        gross: 500,
                    }),
                ],
                map,
                { labels: { 'camt:DE111': 'Hauptkonto' } },
            );
            const out = rows.find((r) => r.id === 'out');
            const inn = rows.find((r) => r.id === 'in');
            expect(out?.receipt).toBe(null);
            expect(out?.account).toBe('Hauptkonto'); // label applied
            expect(inn?.account?.startsWith('camt …')).toBe(true); // fallback label (source + IBAN tail)
            // The two legs are paired into one transfer group.
            expect(out?.transfer?.direction).toBe('out');
            expect(inn?.transfer?.direction).toBe('in');
            expect(out?.transfer?.groupId).toBe(inn?.transfer?.groupId);
        });
    });
};
