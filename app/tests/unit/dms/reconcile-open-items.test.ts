import { describe, it, expect } from '@gjsify/unit';
import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';
import type { LinkCandidate } from '../../../src/core/actions/link-candidates.ts';
import {
    reconcileOpenItems,
    RECONCILE_MIN_SCORE,
    type ReconcileDeps,
} from '../../../src/core/actions/dms/reconcile-open-items.ts';

function doc(id: string, over: Partial<DmsDocument> = {}): DmsDocument {
    return {
        id,
        dms: 'paperless',
        title: `Rechnung ${id}`,
        correspondent: null,
        documentType: null,
        direction: 'incoming',
        created: '2026-01-01',
        added: '2026-01-01',
        tags: [],
        invoiceNumber: null,
        net: null,
        gross: null,
        vat: null,
        linkedTxIds: [],
        mimeType: null,
        pageCount: null,
        ocrText: null,
        ocrSource: null,
        aiNote: null,
        paymentStatus: 'offen',
        ...over,
    };
}

function cand(txId: string, rawScore: number): LinkCandidate {
    return {
        transactionId: txId,
        score: Math.min(1, rawScore / 100),
        rawScore,
        reasons: [],
        amount: -10,
        date: '2026-01-02',
    };
}

/** Fake DMS + candidate source; records every write. */
function setup(docs: DmsDocument[], candidates: Record<string, LinkCandidate[]>) {
    const state = {
        docs: new Map(docs.map((d) => [d.id, d])),
        links: [] as string[],
    };
    const provider = {
        kind: 'paperless',
        list: async () => [...state.docs.values()],
        get: async (id: string) => state.docs.get(id) ?? null,
        getFile: async () => null,
        setMetadata: async (id: string, meta: Partial<DmsDocument>) => {
            state.docs.set(id, { ...state.docs.get(id)!, ...meta });
        },
    } as DmsProvider;
    const deps: ReconcileDeps = {
        provider,
        listOpen: async () => docs.map((d) => ({ id: Number(d.id), title: d.title })),
        suggest: async (id) => candidates[id] ?? [],
        link: async (id, tx) => {
            state.links.push(`${id}:${tx}`);
        },
    };
    return { state, deps };
}

export default async () => {
    await describe('dms/reconcile-open-items', async () => {
        await it('applies a unique match at or above the threshold', async () => {
            const { state, deps } = setup([doc('1')], {
                '1': [cand('tx-a', RECONCILE_MIN_SCORE), cand('tx-b', RECONCILE_MIN_SCORE - 1)],
            });
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('link');
            expect(res.applied).toBe(1);
            expect(state.links.join(',')).toBe('1:tx-a');
            expect(state.docs.get('1')!.paymentStatus).toBe('bezahlt');
        });

        await it('skips an ambiguous document (two strong candidates)', async () => {
            const { state, deps } = setup([doc('1')], {
                '1': [cand('tx-a', 120), cand('tx-b', 90)],
            });
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('ambiguous');
            expect(state.links.length).toBe(0);
            expect(state.docs.get('1')!.paymentStatus).toBe('offen');
        });

        await it('skips a best candidate below the threshold', async () => {
            const { state, deps } = setup([doc('1')], {
                '1': [cand('tx-a', RECONCILE_MIN_SCORE - 1)],
            });
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('below-threshold');
            expect(state.links.length).toBe(0);
        });

        await it('skips a document that is already paid', async () => {
            const { state, deps } = setup([doc('1', { paymentStatus: 'bezahlt' })], {
                '1': [cand('tx-a', 150)],
            });
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('already-paid');
            expect(state.links.length).toBe(0);
        });

        await it('marks documents sharing their only candidate as ambiguous and applies nothing', async () => {
            const { state, deps } = setup([doc('1'), doc('2'), doc('3')], {
                '1': [cand('tx-a', 120)],
                '2': [cand('tx-a', 100)],
                '3': [cand('tx-b', 100)],
            });
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('ambiguous');
            expect(res.entries[0].reason).toBe('shared-transaction');
            expect(res.entries[0].competingDocumentIds!.join(',')).toBe('2');
            expect(res.entries[1].decision).toBe('ambiguous');
            expect(res.entries[2].decision).toBe('link');
            expect(res.toLink).toBe(1);
            expect(state.links.join(',')).toBe('3:tx-b');
            expect(state.docs.get('1')!.paymentStatus).toBe('offen');
            expect(state.docs.get('2')!.paymentStatus).toBe('offen');
        });

        await it('skips a transaction already linked to another document', async () => {
            const { state, deps } = setup([doc('1')], { '1': [cand('tx-a', 120)] });
            deps.linkedTransactions = async () => new Map([['tx-a', ['9']]]);
            const res = await reconcileOpenItems('firma', { apply: true }, deps);
            expect(res.entries[0].decision).toBe('ambiguous');
            expect(res.entries[0].reason).toBe('transaction-linked');
            expect(state.links.length).toBe(0);
        });

        await it('warns when the entity has no store accounts', async () => {
            const { deps } = setup([doc('1')], {});
            deps.accountCount = () => 0;
            const res = await reconcileOpenItems('firma', {}, deps);
            expect(res.warning !== undefined).toBe(true);
            expect(res.entries[0].decision).toBe('no-candidate');
        });

        await it('honours a minScore override', async () => {
            const { deps } = setup([doc('1')], { '1': [cand('tx-a', 40)] });
            expect((await reconcileOpenItems('firma', {}, deps)).entries[0].decision).toBe('below-threshold');
            const res = await reconcileOpenItems('firma', { minScore: 30 }, deps);
            expect(res.minScore).toBe(30);
            expect(res.entries[0].decision).toBe('link');
        });

        await it('writes nothing in a dry run but returns the plan', async () => {
            const { state, deps } = setup([doc('1')], { '1': [cand('tx-a', 150)] });
            const res = await reconcileOpenItems('firma', {}, deps);
            expect(res.dryRun).toBe(true);
            expect(res.toLink).toBe(1);
            expect(res.applied).toBe(0);
            expect(res.entries[0].transactionId).toBe('tx-a');
            expect(state.links.length).toBe(0);
            expect(state.docs.get('1')!.paymentStatus).toBe('offen');
        });
    });
};
