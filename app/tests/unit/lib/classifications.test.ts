import { describe, it, expect, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    openLedger,
    migrate,
    getClassification,
    getClassifications,
    getManualOverrides,
    getDecisionLog as getDecisionLogRepo,
    setClassification,
    removeClassification,
    type UnifiedTransaction,
} from '@steuererklaerung/store';
import {
    aggregateEuerByTransactions,
    type TxDocInfo,
    type EuerManualOverride,
} from '../../../src/core/elster/euer-transactions.ts';
import { resolveEuerFigure, parseFigureRef } from '../../../src/core/actions/elster/explain.ts';
import {
    recordClassificationDecision,
    getClassificationDecision,
    getDecisionLog,
    removeClassificationDecision,
    loadManualOverrides,
} from '../../../src/core/actions/classifications.ts';

const AT = '2026-07-09T10:00:00.000Z';

let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: `t${n++}`, source: 'camt', accountKey: 'camt:a', bookingDate: '2025-06-01', amount: -10, currency: 'EUR', ...over };
}

export default async () => {
    // ── Store repo: persist + read back + decision log ────────────────────────────────
    await describe('classifications store repo', async () => {
        await it('inserts a decision, reads it back, and appends a decision-log row', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = setClassification(
                db,
                'qonto:tx-1',
                { category: '4930 Bürobedarf', note: 'Drucker-Toner, betrieblich', source: 'manual', status: 'confirmed', decidedBy: 'max' },
                AT,
            );
            expect(saved.category).toBe('4930 Bürobedarf');
            expect(saved.source).toBe('manual');
            expect(saved.status).toBe('confirmed');
            expect(saved.note).toBe('Drucker-Toner, betrieblich');
            expect(saved.decidedBy).toBe('max');
            expect(saved.decidedAt).toBe(AT);

            const read = getClassification(db, 'qonto:tx-1');
            expect(read?.category).toBe('4930 Bürobedarf');

            const log = getDecisionLogRepo(db, 'qonto:tx-1');
            expect(log).toHaveLength(1);
            expect(log[0].action).toBe('classification.set');
            expect(log[0].transactionId).toBe('qonto:tx-1');
            db.close();
        });

        await it('merge-upserts: a later note-only patch preserves the category and appends a 2nd log row', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            setClassification(db, 'tx-2', { category: '4210 Miete/Raumkosten', source: 'manual' }, AT);
            const merged = setClassification(db, 'tx-2', { note: 'Büromiete Juni' }, '2026-07-09T11:00:00.000Z');
            expect(merged.category).toBe('4210 Miete/Raumkosten'); // preserved
            expect(merged.note).toBe('Büromiete Juni');
            expect(merged.source).toBe('manual'); // preserved
            expect(getDecisionLogRepo(db, 'tx-2')).toHaveLength(2);
            db.close();
        });

        await it('getManualOverrides returns only source=manual rows that carry a category', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            setClassification(db, 'm-cat', { category: '4930 Bürobedarf', source: 'manual' }, AT);
            setClassification(db, 'm-note', { note: 'nur Begründung', source: 'manual' }, AT); // no category → excluded
            setClassification(db, 'r-row', { category: '4806 Hosting/Cloud', source: 'rule' }, AT); // not manual → excluded
            const overrides = getManualOverrides(db);
            expect([...overrides.keys()].sort()).toStrictEqual(['m-cat']);
            expect(overrides.get('m-cat')?.category).toBe('4930 Bürobedarf');
            // scoped query honours the id filter
            expect(getManualOverrides(db, ['r-row', 'm-note']).size).toBe(0);
            db.close();
        });

        await it('removes a decision and appends a classification.remove log row', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            setClassification(db, 'tx-3', { category: '4930 Bürobedarf', source: 'manual' }, AT);
            expect(removeClassification(db, 'tx-3', AT)).toBe(true);
            expect(getClassification(db, 'tx-3')).toBeNull();
            expect(removeClassification(db, 'tx-3', AT)).toBe(false); // already gone
            const log = getDecisionLogRepo(db, 'tx-3');
            expect(log.map((e) => e.action)).toStrictEqual(['classification.set', 'classification.remove']);
            db.close();
        });

        await it('handles a fresh/empty classifications table gracefully', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(getClassification(db, 'nope')).toBeNull();
            expect(getClassifications(db).size).toBe(0);
            expect(getManualOverrides(db).size).toBe(0);
            expect(getDecisionLogRepo(db, 'nope')).toStrictEqual([]);
            db.close();
        });
    });

    // ── Aggregate honours manual overrides ────────────────────────────────────────────
    await describe('aggregateEuerByTransactions — manual overrides', async () => {
        // A rule-neutral private draw + one income booking. Overriding the draw to an expense must
        // move it out of "neutral" into "expenses" and shift expenseNet + profit accordingly.
        const buildTxs = (): UnifiedTransaction[] => [
            tx({ id: 'inc', amount: 1190, purpose: 'RE-00037 Verkaufserlöse', counterparty: 'Kunde' }),
            tx({ id: 'priv', amount: -119, purpose: 'Privatentnahme', counterparty: 'Max Mustermann' }),
        ];
        const docs = new Map<string, TxDocInfo>();

        await it('(a) a manual override changes the tx category and shifts the category/total nets', async () => {
            const baseline = aggregateEuerByTransactions(buildTxs(), docs, 2025, { detail: true });
            expect(baseline.totals.profit).toBe(1000); // income 1000 − expenses 0
            expect(baseline.neutral.some((c) => c.category === '1800 Privatentnahme')).toBe(true);
            expect(baseline.expenses.length).toBe(0);

            const overrides = new Map<string, EuerManualOverride>([
                ['priv', { category: '4930 Bürobedarf', note: 'Drucker-Toner', decidedBy: 'max' }],
            ]);
            const withOverride = aggregateEuerByTransactions(buildTxs(), docs, 2025, { detail: true, overrides });

            // The draw is now an expense: 119 gross / 1.19 = 100 net → expenseNet 100, profit 900.
            expect(withOverride.totals.expenseNet).toBe(100);
            expect(withOverride.totals.profit).toBe(900);
            expect(withOverride.expenses.some((c) => c.category === '4930 Bürobedarf' && c.net === 100)).toBe(true);
            // …and it left the neutral bucket.
            expect(withOverride.neutral.some((c) => c.category === '1800 Privatentnahme')).toBe(false);
            expect(withOverride.totals.incomeNet).toBe(1000); // income untouched

            // Coverage moved from a rule to a manual classification.
            expect(withOverride.coverage.classifiedByManual).toBe(1);
            expect(baseline.coverage.classifiedByManual).toBe(0);

            // The detail row carries source='manual' + the Begründung / decided_by.
            const row = withOverride.detail?.find((r) => r.id === 'priv');
            expect(row?.source).toBe('manual');
            expect(row?.category).toBe('4930 Bürobedarf');
            expect(row?.note).toBe('Drucker-Toner');
            expect(row?.decidedBy).toBe('max');
        });

        await it('(b) with NO / empty / non-matching overrides the aggregate is byte-identical', async () => {
            const noOpt = aggregateEuerByTransactions(buildTxs(), docs, 2025, { detail: true });
            const emptyMap = aggregateEuerByTransactions(buildTxs(), docs, 2025, { detail: true, overrides: new Map() });
            const nonMatching = aggregateEuerByTransactions(buildTxs(), docs, 2025, {
                detail: true,
                overrides: new Map<string, EuerManualOverride>([['does-not-exist', { category: '4930 Bürobedarf' }]]),
            });
            expect(JSON.stringify(emptyMap)).toBe(JSON.stringify(noOpt));
            expect(JSON.stringify(nonMatching)).toBe(JSON.stringify(noOpt));
        });

        await it('a manual override wins over a linked document (source=document)', async () => {
            const withDoc = new Map<string, TxDocInfo>([
                ['exp1', { category: '4806 Hosting/Cloud', netEur: 100, vatEur: 19, currency: 'EUR' }],
            ]);
            const txs = [tx({ id: 'exp1', amount: -119 })];
            const baseline = aggregateEuerByTransactions(txs, withDoc, 2025, { detail: true });
            expect(baseline.detail?.[0].source).toBe('document');
            expect(baseline.expenses[0].category).toBe('4806 Hosting/Cloud');

            const overrides = new Map<string, EuerManualOverride>([['exp1', { category: '4930 Bürobedarf' }]]);
            const withOverride = aggregateEuerByTransactions(txs, withDoc, 2025, { detail: true, overrides });
            expect(withOverride.detail?.[0].source).toBe('manual');
            expect(withOverride.expenses[0].category).toBe('4930 Bürobedarf');
            // net re-derived from the category's implied 19% (not the doc): 119/1.19 = 100.
            expect(withOverride.totals.expenseNet).toBe(100);
            expect(withOverride.coverage.classifiedByDocument).toBe(0);
            expect(withOverride.coverage.classifiedByManual).toBe(1);
        });

        await it('(d) explainFigure surfaces source=manual for an overridden tx', async () => {
            const overrides = new Map<string, EuerManualOverride>([
                ['priv', { category: '4930 Bürobedarf', note: 'Drucker-Toner', decidedBy: 'max' }],
            ]);
            const agg = aggregateEuerByTransactions(buildTxs(), docs, 2025, { detail: true, overrides });
            const ex = resolveEuerFigure(agg, parseFigureRef('euer:2025:expense:4930'));
            expect(ex.contributors).toHaveLength(1);
            const c = ex.contributors[0];
            expect(c.provenance.source).toBe('manual');
            expect(c.provenance.decidedBy).toBe('max');
            expect(c.provenance.note).toBe('Drucker-Toner');
            expect(ex.provenanceMix.manual).toBe(1);
        });
    });

    // ── Core action + loadManualOverrides (store-backed, temp ledger DB) ───────────────
    await describe('recordClassificationDecision action + loadManualOverrides', async () => {
        let dir: string;
        let prevPath: string | undefined;

        const useTempLedger = () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-cls-'));
            prevPath = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        };
        afterEach(async () => {
            if (prevPath === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prevPath;
            if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        });

        await it('(c) persists a decision, reads it back, and it appears in the decision log', async () => {
            useTempLedger();
            const saved = recordClassificationDecision({
                transactionId: 'qonto:abc',
                category: '4930 Bürobedarf',
                note: 'Toner',
                decidedBy: 'max',
            });
            expect(saved.source).toBe('manual'); // default
            expect(saved.status).toBe('confirmed'); // default when a category is set
            expect(getClassificationDecision('qonto:abc')?.category).toBe('4930 Bürobedarf');
            const log = getDecisionLog('qonto:abc');
            expect(log).toHaveLength(1);
            expect(log[0].action).toBe('classification.set');
        });

        await it('loadManualOverrides maps persisted manual decisions into the aggregate override map', async () => {
            useTempLedger();
            recordClassificationDecision({ transactionId: 'qonto:abc', category: '4930 Bürobedarf', note: 'Toner' });
            recordClassificationDecision({ transactionId: 'qonto:def', note: 'nur Begründung' }); // no category → not an override
            const overrides = loadManualOverrides(['qonto:abc', 'qonto:def']);
            expect([...overrides.keys()]).toStrictEqual(['qonto:abc']);
            expect(overrides.get('qonto:abc')).toStrictEqual({ category: '4930 Bürobedarf', note: 'Toner', decidedBy: null });
        });

        // Beleg-Eingang confirm-pane semantics: ACCEPT (aiNoteAccepted, NO category) records a confirmed
        // decision but is NOT a manual override → the EÜR/USt number does NOT move; correcting the
        // category IS an override → it moves. The pane relies on exactly this distinction.
        await it('an accepted AI decision without a category is not a manual override', async () => {
            useTempLedger();
            recordClassificationDecision({ transactionId: 'qonto:acc', aiNoteAccepted: true, documentId: 42 }); // ACCEPT
            recordClassificationDecision({ transactionId: 'qonto:ovr', category: '4946 Fremdleistungen', aiNoteAccepted: true }); // OVERRIDE
            const overrides = loadManualOverrides(['qonto:acc', 'qonto:ovr']);
            expect([...overrides.keys()]).toStrictEqual(['qonto:ovr']);
        });

        await it('loadManualOverrides returns an empty map (no DB created) on a fresh store', async () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-cls-'));
            prevPath = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(dir, 'does-not-exist.db');
            expect(loadManualOverrides().size).toBe(0);
            expect(existsSync(join(dir, 'does-not-exist.db'))).toBe(false); // side-effect-free read
        });

        await it('rejects a decision with nothing to record; removes an override', async () => {
            useTempLedger();
            expect(() => recordClassificationDecision({ transactionId: 'x' })).toThrow();
            expect(() => recordClassificationDecision({ transactionId: '' , note: 'y' })).toThrow();
            recordClassificationDecision({ transactionId: 'qonto:rm', category: '4930 Bürobedarf' });
            expect(removeClassificationDecision('qonto:rm')).toBe(true);
            expect(getClassificationDecision('qonto:rm')).toBeNull();
        });
    });
};
