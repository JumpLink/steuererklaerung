import { describe, expect, it } from '@gjsify/unit';
import type { DmsDocument } from '@steuererklaerung/dms';
import type { EuerTxDetailRow } from '../../../src/core/elster/euer-transactions.ts';
import {
    filterDocuments,
    isBelegGap,
    groupBelegGap,
    nextOpenId,
    openDocIds,
    reviewProgressLabel,
    stepOpenId,
} from '../../../src/core/presenters/belege.ts';

// @gjsify/unit's toEqual is `==` (reference equality for arrays/objects), so array results are asserted
// as their joined-id string via toBe.
const ids = (docs: { id: string }[]) => docs.map((d) => d.id).join(',');

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
    await describe('presenters/belege — filterDocuments', async () => {
        const docs = [
            doc({
                id: '1',
                title: 'Adobe Rechnung',
                correspondent: 'Adobe',
                direction: 'incoming',
                created: '2025-03-10',
                linkedTxIds: ['a'],
            }),
            doc({
                id: '2',
                title: 'Ausgangsrechnung',
                invoiceNumber: 'RE-2025-1',
                direction: 'outgoing',
                created: '2025-07-01',
                linkedTxIds: [],
                ocrText: 'Leistung Beratung',
            }),
            doc({
                id: '3',
                title: 'Kassenbon',
                tags: ['Bewirtung'],
                direction: 'incoming',
                created: '2025-12-24',
                linkedTxIds: [],
            }),
        ];

        await it('no criteria → returns every document unchanged', async () => {
            expect(filterDocuments(docs, {}).length).toBe(3);
        });

        await it('query matches title, correspondent, invoiceNumber, OCR text and tags (case-insensitive)', async () => {
            expect(ids(filterDocuments(docs, { query: 'adobe' }))).toBe('1'); // correspondent + title
            expect(ids(filterDocuments(docs, { query: 'RE-2025' }))).toBe('2'); // invoiceNumber
            expect(ids(filterDocuments(docs, { query: 'beratung' }))).toBe('2'); // ocrText
            expect(ids(filterDocuments(docs, { query: 'bewirtung' }))).toBe('3'); // tag
        });

        await it('from/to bound by the created date (inclusive)', async () => {
            expect(ids(filterDocuments(docs, { from: '2025-07-01' }))).toBe('2,3');
            expect(ids(filterDocuments(docs, { to: '2025-07-01' }))).toBe('1,2');
            expect(ids(filterDocuments(docs, { from: '2025-04-01', to: '2025-11-30' }))).toBe('2');
        });

        await it('direction filters incoming/outgoing; an unknown value is ignored', async () => {
            expect(ids(filterDocuments(docs, { direction: 'outgoing' }))).toBe('2');
            expect(ids(filterDocuments(docs, { direction: 'incoming' }))).toBe('1,3');
            expect(filterDocuments(docs, { direction: 'sideways' }).length).toBe(3); // ignored
        });

        await it('linked yes/no partitions by whether any tx is linked', async () => {
            expect(ids(filterDocuments(docs, { linked: 'yes' }))).toBe('1');
            expect(ids(filterDocuments(docs, { linked: 'no' }))).toBe('2,3');
        });

        await it('criteria compose (AND) and never mutate the input array', async () => {
            const before = ids(docs);
            expect(ids(filterDocuments(docs, { direction: 'incoming', linked: 'no' }))).toBe('3');
            expect(ids(docs)).toBe(before); // input untouched
        });
    });

    await describe('presenters/belege — Beleg gap', async () => {
        await it('isBelegGap: an unlinked Vorsteuer expense is a gap; income / tiny-VAT / linked are not', async () => {
            const linked = new Set<string>(['linked']);
            expect(isBelegGap(row({ id: 'gap', kind: 'expense', vat: -19 }), linked)).toBe(true);
            expect(isBelegGap(row({ id: 'inc', kind: 'income', vat: 19 }), linked)).toBe(false); // income
            expect(isBelegGap(row({ id: 'linked', kind: 'expense', vat: -19 }), linked)).toBe(false); // covered
            expect(isBelegGap(row({ id: 'novat', kind: 'expense', vat: 0 }), linked)).toBe(false); // no Vorsteuer
            expect(isBelegGap(row({ id: 'tiny', kind: 'expense', vat: -0.004 }), linked)).toBe(false); // below threshold
        });

        await it('groupBelegGap: buckets by month (sorted), sums |vat| per month and overall', async () => {
            const detail = [
                row({ id: 'a', bookingDate: '2025-03-05', vat: -19 }),
                row({ id: 'b', bookingDate: '2025-03-20', vat: -10 }),
                row({ id: 'c', bookingDate: '2025-01-15', vat: -5 }),
                row({ id: 'd', bookingDate: '2025-06-01', vat: -19, kind: 'income' }), // income → excluded
                row({ id: 'e', bookingDate: '2025-06-02', vat: -7 }),
            ];
            const res = groupBelegGap(detail, new Set<string>());
            expect(res.months.map((m) => m.month).join(',')).toBe('1,3,6'); // sorted; income (d) excluded
            expect(res.months.find((m) => m.month === 3)?.rows.length).toBe(2);
            expect(res.months.find((m) => m.month === 3)?.vat).toBe(29); // |−19| + |−10|
            expect(res.totalCount).toBe(4); // a,b,c,e (d excluded)
            expect(res.totalVat).toBe(41); // 19 + 10 + 5 + 7
        });

        await it('groupBelegGap: excludes rows already covered by a linked document', async () => {
            const detail = [row({ id: 'x', vat: -19 }), row({ id: 'y', vat: -19 })];
            const res = groupBelegGap(detail, new Set<string>(['x']));
            expect(res.totalCount).toBe(1);
            expect(res.months[0]?.rows[0]?.id).toBe('y');
        });
    });

    await describe('presenters/belege — review-queue navigation', async () => {
        const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        const none = new Set<string>();

        await it('reviewProgressLabel formats "X von N geprüft"', async () => {
            expect(reviewProgressLabel(8, 0)).toBe('0 von 8 geprüft');
            expect(reviewProgressLabel(8, 3)).toBe('3 von 8 geprüft');
        });

        await it('openDocIds keeps list order and drops confirmed ids', async () => {
            expect(openDocIds(queue, none).join(',')).toBe('a,b,c,d');
            expect(openDocIds(queue, new Set(['b', 'd'])).join(',')).toBe('a,c');
        });

        await it('nextOpenId lands below the confirmed row, wraps to the top open one, else null', async () => {
            expect(nextOpenId(queue, new Set(['b']), 'b')).toBe('c'); // next below
            expect(nextOpenId(queue, new Set(['c', 'd']), 'd')).toBe('a'); // nothing below → first open
            expect(nextOpenId(queue, new Set(['a', 'b', 'c', 'd']), 'd')).toBe(null); // all done
            expect(nextOpenId(queue, none)).toBe('a'); // no anchor → first open
        });

        await it('stepOpenId steps among OPEN rows only, clamped at both ends', async () => {
            const done = new Set(['b']);
            expect(stepOpenId(queue, done, 'a', 1)).toBe('c'); // skips the done b
            expect(stepOpenId(queue, done, 'c', -1)).toBe('a');
            expect(stepOpenId(queue, done, 'a', -1)).toBe('a'); // clamped, no wrap
            expect(stepOpenId(queue, done, 'd', 1)).toBe('d'); // clamped at the end
            expect(stepOpenId(queue, done, 'b', 1)).toBe('a'); // done current → first open
            expect(stepOpenId(queue, done, null, 1)).toBe('a');
            expect(stepOpenId(queue, new Set(['a', 'b', 'c', 'd']), 'a', 1)).toBe(null);
        });
    });
};
