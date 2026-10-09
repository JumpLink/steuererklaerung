import { describe, it, expect } from '@gjsify/unit';
import { aggregateEuerByTransactions, type TxDocInfo } from '../../../src/core/elster/euer-transactions.ts';
import {
    parseFigureRef,
    formatFigureRef,
    resolveEuerFigure,
    listEuerFigureRefs,
} from '../../../src/core/actions/elster/explain.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: `t${n++}`,
        source: 'camt',
        accountKey: 'camt:a',
        bookingDate: '2025-06-01',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

/**
 * A representative aggregate: one doc-linked income, two Reisekosten expenses (one via a linked
 * document, one via the keyword rule), a rule-classified bank fee, and a year-end AfA adjustment.
 */
function fixture() {
    const docs = new Map<string, TxDocInfo>([
        ['inc1', { documentId: 501, category: '8400 Erlöse 19% USt', netEur: 1000, vatEur: 190, currency: 'EUR' }],
        ['exp1', { documentId: 502, category: '4670 Reisekosten', netEur: 100, vatEur: 19, currency: 'EUR' }],
    ]);
    const txs: UnifiedTransaction[] = [
        tx({ id: 'inc1', amount: 1190, counterparty: 'Kunde', purpose: 'RE-2025-1' }), // via Beleg (income)
        tx({ id: 'exp1', amount: -119, counterparty: 'Bahn', purpose: 'ICE' }), // via Beleg (Reisekosten)
        tx({ id: 'trav', amount: -238, purpose: 'NONREF Reisekosten Bahn 9999' }), // via Regel (Reisekosten, 200 net)
        tx({ id: 'fee', counterparty: 'Qonto', purpose: 'Gebühr', amount: -11.9 }), // via Regel (bank fee)
    ];
    return aggregateEuerByTransactions(txs, docs, 2025, {
        detail: true,
        adjustments: { afa: 300, afaCount: 1 },
    });
}

export default async () => {
    await describe('parseFigureRef / formatFigureRef', async () => {
        await it('parses the compact form with the year supplied out of band', async () => {
            const ref = parseFigureRef('euer:expense:4670', { year: 2025 });
            expect(ref).toStrictEqual({ domain: 'euer', year: 2025, kind: 'expense', id: '4670' });
            expect(formatFigureRef(ref)).toBe('euer:2025:expense:4670');
        });
        await it('parses the self-contained form with an embedded year', async () => {
            expect(parseFigureRef('euer:2025:income:8400')).toStrictEqual({
                domain: 'euer',
                year: 2025,
                kind: 'income',
                id: '8400',
            });
        });
        await it('canonicalises total aliases', async () => {
            expect(parseFigureRef('euer:2025:total:profit').id).toBe('gewinn');
            expect(parseFigureRef('euer:2025:total:einnahmen').id).toBe('betriebseinnahmen');
            expect(parseFigureRef('euer:2025:total:zahllast').id).toBe('ust-zahllast');
        });
        await it('rejects malformed / unknown refs', async () => {
            expect(() => parseFigureRef('nope')).toThrow();
            expect(() => parseFigureRef('bwa:2025:total:x')).toThrow();
            expect(() => parseFigureRef('euer:total:gewinn')).toThrow(); // no year anywhere
            expect(() => parseFigureRef('euer:2025:total:bogus')).toThrow();
        });
    });

    await describe('resolveEuerFigure — category', async () => {
        await it('sums the contributing rows to the category net, with provenance', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:expense:4670'));
            const cat = agg.expenses.find((c) => c.category === '4670 Reisekosten');
            expect(cat).toBeDefined();
            // THE invariant: Σ contributors.net === the category net in the euer report.
            const sum = ex.contributors.reduce((s, r) => s + r.net, 0);
            expect(Math.round(sum * 100) / 100).toBe(cat?.net);
            expect(ex.value).toBe(cat?.net); // 100 (Beleg) + 200 (Regel) = 300
            expect(ex.contributors).toHaveLength(2);
            // Provenance is populated: one via document (with documentId), one via rule.
            const byDoc = ex.contributors.find((r) => r.provenance.source === 'document');
            const byRule = ex.contributors.find((r) => r.provenance.source === 'rule');
            expect(byDoc?.provenance.documentId).toBe(502);
            expect(byRule?.provenance.rule).toContain('Keyword');
            expect(ex.provenanceMix).toStrictEqual({ document: 1, rule: 1, manual: 0, unclassified: 0 });
            expect(ex.formula).toContain('Buchungen');
        });

        await it('resolves an income category by its SKR03 token', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:income:8400'));
            const sum = ex.contributors.reduce((s, r) => s + r.net, 0);
            expect(Math.round(sum * 100) / 100).toBe(agg.income.find((c) => c.category === '8400 Erlöse 19% USt')?.net);
            expect(ex.contributors[0]?.provenance.source).toBe('document');
        });

        await it('throws for an unknown category', async () => {
            expect(() => resolveEuerFigure(fixture(), parseFigureRef('euer:2025:expense:9999'))).toThrow();
        });
    });

    await describe('resolveEuerFigure — totals', async () => {
        await it('Betriebseinnahmen sums its rows to incomeNet', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:total:betriebseinnahmen'));
            const sum = ex.contributors.reduce((s, r) => s + r.net, 0);
            expect(Math.round(sum * 100) / 100).toBe(agg.totals.incomeNet);
            expect(ex.value).toBe(agg.totals.incomeNet);
            // Children drill down into the income categories.
            expect(ex.children.length).toBe(agg.income.length);
        });

        await it('Betriebsausgaben includes the AfA year-end adjustment', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:total:betriebsausgaben'));
            const sum = ex.contributors.reduce((s, r) => s + r.net, 0);
            expect(Math.round(sum * 100) / 100).toBe(agg.totals.expenseNet);
            expect(ex.contributors.some((r) => r.category === '4830 Abschreibungen (AfA)')).toBe(true);
            expect(ex.meta.adjustmentsApplied).toBe(true);
        });

        await it('Gewinn is the difference of the two child totals', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:total:gewinn'));
            expect(ex.value).toBe(agg.totals.profit);
            expect(ex.children.map((c) => c.op)).toStrictEqual(['+', '-']);
            expect(ex.children[0]?.ref).toBe('euer:2025:total:betriebseinnahmen');
        });

        await it('USt-Zahllast is vereinnahmte USt − Vorsteuer', async () => {
            const agg = fixture();
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:total:ust-zahllast'));
            expect(ex.value).toBe(agg.totals.vatPayable);
            expect(ex.children[0]?.value).toBe(agg.totals.outputVat);
            expect(ex.children[1]?.value).toBe(agg.totals.inputVat);
        });
    });

    await describe('listEuerFigureRefs', async () => {
        await it('lists every category + the four totals with drillable refs', async () => {
            const refs = listEuerFigureRefs(fixture());
            expect(refs.some((r) => r.ref === 'euer:2025:expense:4670')).toBe(true);
            expect(refs.some((r) => r.ref === 'euer:2025:income:8400')).toBe(true);
            for (const id of ['betriebseinnahmen', 'betriebsausgaben', 'gewinn', 'ust-zahllast']) {
                expect(refs.some((r) => r.ref === `euer:2025:total:${id}`)).toBe(true);
            }
        });
    });
};
