import { describe, it, expect } from '@gjsify/unit';
import {
    createSnapshot,
    getSnapshot,
    latestSnapshot,
    listSnapshots,
    markSnapshotSubmitted,
    markSnapshotValidated,
    markSuperseded,
    migrate,
    openLedger,
    type CreateSnapshotInput,
} from '@steuererklaerung/store';
import type { ElsterConfig } from '../../../src/core/config/index.ts';
import {
    computeFingerprintFromInputs,
    type FingerprintInputs,
    type FingerprintOverride,
} from '../../../src/core/actions/elster/fingerprint.ts';

const AT = '2026-07-09T10:00:00.000Z';

/** A minimal scoped transaction (only the identity fields the fingerprint hashes). */
function tx(over: Partial<FingerprintInputs['txs'][number]> = {}): FingerprintInputs['txs'][number] {
    return {
        id: 'camt_abc',
        amount: -100,
        bookingDate: '2025-03-01',
        category: undefined,
        source: 'camt',
        ...over,
    };
}

/** A minimal figure-relevant ELSTER config; override the parts under test. */
function elster(over: Partial<ElsterConfig> = {}): ElsterConfig {
    return {
        tax_number: '18/815/08152',
        schema_version: 2025,
        period: { year: 2025, quarter: 1 },
        output_directory: '/tmp/out',
        ust_dauerfristverlaengerung: false,
        taxation_basis: 'ist',
        test_mode: true,
        exclude_tags: [],
        include_tags: [],
        entity_id: 'artcode',
        gesellschafter: [],
        account_labels: {},
        ...over,
    } as ElsterConfig;
}

/** Assemble fingerprint inputs from txs + overrides + config. */
function inputs(
    txs: FingerprintInputs['txs'],
    overrides: Array<[string, FingerprintOverride]> = [],
    over: Partial<FingerprintInputs> = {},
): FingerprintInputs {
    return {
        year: 2025,
        entityId: 'gbr',
        accountKeys: ['camt:DE00'],
        txs,
        overrides: new Map(overrides),
        elster: elster(),
        ...over,
    };
}

/** A ready-to-insert snapshot; override any field. */
function snapshotInput(over: Partial<CreateSnapshotInput> = {}): CreateSnapshotInput {
    return {
        entityId: 'gbr',
        year: 2025,
        formType: 'euer',
        fingerprint: 'v1:aaaa',
        xml: '<Elster>euer</Elster>',
        figures: { headline: { profit: 1234.56 } },
        ...over,
    };
}

export default async () => {
    await describe('computeInputFingerprint (pure)', async () => {
        await it('is stable + deterministic across identical inputs', async () => {
            const a = computeFingerprintFromInputs(inputs([tx()]));
            const b = computeFingerprintFromInputs(inputs([tx()]));
            expect(a).toBe(b);
            expect(a.startsWith('v1:')).toBe(true);
        });

        await it('is independent of transaction ORDER (sorts internally)', async () => {
            const t1 = tx({ id: 'camt_1', amount: -10 });
            const t2 = tx({ id: 'camt_2', amount: -20 });
            expect(computeFingerprintFromInputs(inputs([t1, t2]))).toBe(computeFingerprintFromInputs(inputs([t2, t1])));
        });

        await it('flips when a transaction amount / date / category / id changes', async () => {
            const base = computeFingerprintFromInputs(inputs([tx()]));
            expect(computeFingerprintFromInputs(inputs([tx({ amount: -100.01 })]))).not.toBe(base);
            expect(computeFingerprintFromInputs(inputs([tx({ bookingDate: '2025-03-02' })]))).not.toBe(base);
            expect(computeFingerprintFromInputs(inputs([tx({ category: '4930 Bürobedarf' })]))).not.toBe(base);
            expect(computeFingerprintFromInputs(inputs([tx({ id: 'camt_xyz' })]))).not.toBe(base);
        });

        await it('flips when a transaction is added or removed', async () => {
            const one = computeFingerprintFromInputs(inputs([tx()]));
            const two = computeFingerprintFromInputs(inputs([tx(), tx({ id: 'camt_def', amount: -5 })]));
            expect(one).not.toBe(two);
        });

        await it('flips when a MANUAL override is added or changed', async () => {
            const none = computeFingerprintFromInputs(inputs([tx()]));
            const withOverride = computeFingerprintFromInputs(
                inputs([tx()], [['camt_abc', { category: '4930 Bürobedarf' }]]),
            );
            expect(withOverride).not.toBe(none);
            // Changing the override target flips it again.
            const reCategorised = computeFingerprintFromInputs(
                inputs([tx()], [['camt_abc', { category: '4980 Sonstiges' }]]),
            );
            expect(reCategorised).not.toBe(withOverride);
            // Changing only the Begründung note also flips it.
            const withNote = computeFingerprintFromInputs(
                inputs([tx()], [['camt_abc', { category: '4930 Bürobedarf', note: 'privat veranlasst' }]]),
            );
            expect(withNote).not.toBe(withOverride);
        });

        await it('flips when a figure-relevant config adjustment changes', async () => {
            const base = computeFingerprintFromInputs(inputs([tx()]));
            const withAfa = computeFingerprintFromInputs(
                inputs([tx()], [], {
                    elster: elster({ adjustments: { afa_override: 500 } as ElsterConfig['adjustments'] }),
                }),
            );
            expect(withAfa).not.toBe(base);
        });

        await it('ignores cwd/env-derived + non-figure config keys (output dir, test_mode, period, schema_version)', async () => {
            const base = computeFingerprintFromInputs(inputs([tx()]));
            const noisy = computeFingerprintFromInputs(
                inputs([tx()], [], {
                    elster: elster({
                        output_directory: '/somewhere/else',
                        test_mode: false,
                        schema_version: 2099,
                        period: { year: 2025, quarter: 4 },
                    }),
                }),
            );
            expect(noisy).toBe(base);
        });
    });

    await describe('filing_snapshots repo (append-only + immutable)', async () => {
        await it('inserts a snapshot and reads it back with figures parsed + fingerprint intact', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = createSnapshot(db, snapshotInput({ fingerprint: 'v1:cafe' }), AT);
            expect(saved.id.startsWith('snap_')).toBe(true);
            expect(saved.status).toBe('draft');
            expect(saved.fingerprint).toBe('v1:cafe');
            expect(saved.createdAt).toBe(AT);
            expect(saved.transferTicket).toBeNull();
            const read = getSnapshot(db, saved.id);
            expect(read?.xml).toBe('<Elster>euer</Elster>');
            expect(read?.figures).toStrictEqual({ headline: { profit: 1234.56 } });
            db.close();
        });

        await it('never overwrites: re-inserting the same id throws (append-only)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = createSnapshot(db, snapshotInput(), AT);
            expect(() => createSnapshot(db, snapshotInput({ id: saved.id, xml: '<tampered/>' }), AT)).toThrow();
            // The original row is unchanged.
            expect(getSnapshot(db, saved.id)?.xml).toBe('<Elster>euer</Elster>');
            db.close();
        });

        await it('status transitions never mutate xml / figures / fingerprint', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const s = createSnapshot(db, snapshotInput({ fingerprint: 'v1:frozen' }), AT);

            const validated = markSnapshotValidated(db, s.id);
            expect(validated?.status).toBe('validated');

            const submitted = markSnapshotSubmitted(db, s.id, { transferTicket: 'T-123', serverProtocol: 'P-9' });
            expect(submitted?.status).toBe('submitted');
            expect(submitted?.transferTicket).toBe('T-123');
            expect(submitted?.serverProtocol).toBe('P-9');
            // source/submittedAt were not passed → default to their (null) existing values.
            expect(submitted?.submissionSource).toBeNull();
            expect(submitted?.submittedAt).toBeNull();

            const superseded = markSuperseded(db, s.id);
            expect(superseded?.status).toBe('superseded');

            // The frozen payload survived every status change untouched.
            const final = getSnapshot(db, s.id);
            expect(final?.xml).toBe('<Elster>euer</Elster>');
            expect(final?.figures).toStrictEqual({ headline: { profit: 1234.56 } });
            expect(final?.fingerprint).toBe('v1:frozen');
            db.close();
        });

        await it('records the submission source + date (web-form) on submit', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const s = createSnapshot(db, snapshotInput(), AT);
            expect(getSnapshot(db, s.id)?.submissionSource).toBeNull();
            const submitted = markSnapshotSubmitted(db, s.id, {
                transferTicket: 'ep1963i9uaqkaw',
                source: 'web-form',
                submittedAt: '2026-07-14',
            });
            expect(submitted?.status).toBe('submitted');
            expect(submitted?.transferTicket).toBe('ep1963i9uaqkaw');
            expect(submitted?.submissionSource).toBe('web-form');
            expect(submitted?.submittedAt).toBe('2026-07-14');
            db.close();
        });

        await it('mark* on an unknown id is a no-op returning null', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(markSnapshotValidated(db, 'snap_missing')).toBeNull();
            expect(markSnapshotSubmitted(db, 'snap_missing')).toBeNull();
            db.close();
        });

        await it('lists newest-first, filters by form, and latestSnapshot returns the newest', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const euer1 = createSnapshot(db, snapshotInput({ formType: 'euer' }), '2026-07-01T09:00:00.000Z');
            const gewst = createSnapshot(db, snapshotInput({ formType: 'gewst' }), '2026-07-02T09:00:00.000Z');
            const euer2 = createSnapshot(
                db,
                snapshotInput({ formType: 'euer', fingerprint: 'v1:newer' }),
                '2026-07-03T09:00:00.000Z',
            );

            const all = listSnapshots(db, 'gbr', 2025);
            expect(all.map((s) => s.id)).toStrictEqual([euer2.id, gewst.id, euer1.id]); // newest first

            const euerOnly = listSnapshots(db, 'gbr', 2025, 'euer');
            expect(euerOnly.map((s) => s.id)).toStrictEqual([euer2.id, euer1.id]);

            expect(latestSnapshot(db, 'gbr', 2025, 'euer')?.id).toBe(euer2.id);
            expect(latestSnapshot(db, 'gbr', 2025, 'uste')).toBeNull(); // none captured
            expect(listSnapshots(db, 'gbr', 2024)).toStrictEqual([]); // other year
            db.close();
        });
    });

    await describe('snapshot staleness (fingerprint drift binding)', async () => {
        await it('is fresh right after capture and stale after the data changes', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            // Capture: freeze the fingerprint of the current inputs into the snapshot.
            const captureFp = computeFingerprintFromInputs(inputs([tx()]));
            const snap = createSnapshot(db, snapshotInput({ fingerprint: captureFp }), AT);

            // Right after capture, recomputing over the SAME inputs matches → not stale.
            const sameFp = computeFingerprintFromInputs(inputs([tx()]));
            expect(snap.fingerprint === sameFp).toBe(true);

            // A later edit (reclassify a booking) changes the inputs → the recomputed fp differs → stale.
            const changedFp = computeFingerprintFromInputs(
                inputs([tx()], [['camt_abc', { category: '4930 Bürobedarf' }]]),
            );
            expect(snap.fingerprint === changedFp).toBe(false);
            db.close();
        });
    });
};
