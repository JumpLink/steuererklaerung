import { describe, it, expect } from '@gjsify/unit';
import {
    createSnapshot,
    getSignoff,
    insertSignoff,
    latestSignoff,
    listSignoffs,
    migrate,
    openLedger,
    revokeSignoff,
    type CreateSignoffInput,
    type CreateSnapshotInput,
    type FilingSignoff,
    type FilingSnapshot,
} from '@steuererklaerung/store';
import {
    assertSnapshotSignable,
    computeSubmissionGate,
    evaluateSignoffValidity,
    type SignoffEvalInputs,
} from '../../../src/core/actions/elster/signoffs.ts';
import { computeFingerprintFromInputs, type FingerprintInputs } from '../../../src/core/actions/elster/fingerprint.ts';

const AT = '2026-07-09T10:00:00.000Z';

/** A ready-to-insert sign-off; override any field. */
function signoffInput(over: Partial<CreateSignoffInput> = {}): CreateSignoffInput {
    return {
        snapshotId: 'snap_test',
        entityId: 'gbr',
        year: 2025,
        formType: 'euer',
        fingerprint: 'v1:aaaa',
        signedBy: 'max',
        note: null,
        crossChecksClean: true,
        ...over,
    };
}

/** A ready-to-insert snapshot (for assertSnapshotSignable, which needs a full FilingSnapshot). */
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

/** Minimal sign-off core the pure evaluators read (snapshot binding + revoked + verdict). */
function signoffCore(
    over: Partial<Pick<FilingSignoff, 'snapshotId' | 'fingerprint' | 'revoked' | 'crossChecksClean'>> = {},
): NonNullable<SignoffEvalInputs['signoff']> {
    return { snapshotId: SNAP_ID, fingerprint: 'v1:aaaa', revoked: false, crossChecksClean: true, ...over };
}

/** The snapshot every fixture below binds to unless it deliberately binds elsewhere. */
const SNAP_ID = 'snap_fixture';

/** A snapshot core for the pure evaluators — id + fingerprint is all they read. */
function snapCore(
    over: Partial<Pick<FilingSnapshot, 'id' | 'fingerprint'>> = {},
): NonNullable<SignoffEvalInputs['snapshot']> {
    return { id: SNAP_ID, fingerprint: 'v1:aaaa', ...over };
}

/** Minimal fingerprint inputs (only the identity fields hashed) — for the realistic drift test. */
function fpInputs(over: Partial<FingerprintInputs> = {}): FingerprintInputs {
    return {
        year: 2025,
        entityId: 'gbr',
        accountKeys: ['camt:DE00'],
        txs: [{ id: 'camt_abc', amount: -100, bookingDate: '2025-03-01', category: undefined, source: 'camt' }],
        overrides: new Map(),
        ...over,
    };
}

export default async () => {
    await describe('filing_signoffs repo (append-only + revoke-only mutation)', async () => {
        await it('inserts a sign-off and reads it back with the verdict + fingerprint intact', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = insertSignoff(
                db,
                signoffInput({ snapshotId: 'snap_1', fingerprint: 'v1:cafe', note: 'geprüft', crossChecksClean: true }),
                AT,
            );
            expect(saved.id.startsWith('signoff_')).toBe(true);
            expect(saved.revoked).toBe(false);
            expect(saved.crossChecksClean).toBe(true);
            expect(saved.fingerprint).toBe('v1:cafe');
            expect(saved.signedAt).toBe(AT);
            expect(saved.signedBy).toBe('max');
            const read = getSignoff(db, saved.id);
            expect(read?.snapshotId).toBe('snap_1');
            expect(read?.note).toBe('geprüft');
            db.close();
        });

        await it('never overwrites: re-inserting the same id throws (append-only PK)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = insertSignoff(db, signoffInput({ fingerprint: 'v1:orig' }), AT);
            expect(() => insertSignoff(db, signoffInput({ id: saved.id, fingerprint: 'v1:tampered' }), AT)).toThrow();
            // The original row is unchanged.
            expect(getSignoff(db, saved.id)?.fingerprint).toBe('v1:orig');
            db.close();
        });

        await it('revoke flips `revoked` only — the substantive fields stay frozen (append-only)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const s = insertSignoff(
                db,
                signoffInput({ snapshotId: 'snap_x', fingerprint: 'v1:frozen', note: 'ok', crossChecksClean: true }),
                AT,
            );
            const revoked = revokeSignoff(db, s.id);
            expect(revoked?.revoked).toBe(true);
            // Every substantive field survived the revoke untouched.
            expect(revoked?.snapshotId).toBe('snap_x');
            expect(revoked?.fingerprint).toBe('v1:frozen');
            expect(revoked?.signedBy).toBe('max');
            expect(revoked?.note).toBe('ok');
            expect(revoked?.crossChecksClean).toBe(true);
            expect(revoked?.signedAt).toBe(AT);
            db.close();
        });

        await it('revoke on an unknown id is a no-op returning null', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(revokeSignoff(db, 'signoff_missing')).toBeNull();
            db.close();
        });

        await it('lists newest-first, filters by form, and latestSignoff returns the newest', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const euer1 = insertSignoff(db, signoffInput({ formType: 'euer' }), '2026-07-01T09:00:00.000Z');
            const gewst = insertSignoff(db, signoffInput({ formType: 'gewst' }), '2026-07-02T09:00:00.000Z');
            const euer2 = insertSignoff(
                db,
                signoffInput({ formType: 'euer', fingerprint: 'v1:newer' }),
                '2026-07-03T09:00:00.000Z',
            );

            const all = listSignoffs(db, { entityId: 'gbr', year: 2025 });
            expect(all.map((s) => s.id)).toStrictEqual([euer2.id, gewst.id, euer1.id]); // newest first

            const euerOnly = listSignoffs(db, { entityId: 'gbr', year: 2025, formType: 'euer' });
            expect(euerOnly.map((s) => s.id)).toStrictEqual([euer2.id, euer1.id]);

            expect(latestSignoff(db, { entityId: 'gbr', year: 2025, formType: 'euer' })?.id).toBe(euer2.id);
            expect(latestSignoff(db, { entityId: 'gbr', year: 2025, formType: 'uste' })).toBeNull(); // none
            expect(listSignoffs(db, { entityId: 'gbr', year: 2024 })).toStrictEqual([]); // other year
            db.close();
        });
    });

    await describe('assertSnapshotSignable (never sign off drifted data)', async () => {
        await it('refuses when there is no snapshot', async () => {
            expect(() => assertSnapshotSignable(null, false)).toThrow();
        });

        await it('refuses a stale (drifted) snapshot', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const snap = createSnapshot(db, snapshotInput(), AT);
            expect(() => assertSnapshotSignable(snap, true)).toThrow();
            db.close();
        });

        await it('passes a fresh snapshot', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const snap = createSnapshot(db, snapshotInput(), AT);
            let ok = true;
            try {
                assertSnapshotSignable(snap, false);
            } catch {
                ok = false;
            }
            expect(ok).toBe(true);
            db.close();
        });
    });

    await describe('evaluateSignoffValidity (snapshot binding)', async () => {
        await it('is valid right after signing (bound, non-revoked, no drift)', async () => {
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a' }),
            });
            expect(v.valid).toBe(true);
            expect(v.stale).toBe(false);
            expect(v.reason).toBeNull();
        });

        await it('is INVALID + stale after a fingerprint-changing edit (drift)', async () => {
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:b',
                signoff: signoffCore({ fingerprint: 'v1:a' }),
            });
            expect(v.valid).toBe(false);
            expect(v.stale).toBe(true);
            expect(v.reason?.includes('Drift')).toBe(true);
        });

        await it('is invalidated by a revoke', async () => {
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a', revoked: true }),
            });
            expect(v.valid).toBe(false);
            expect(v.reason?.includes('widerrufen')).toBe(true);
        });

        await it("is invalid when a frozen snapshot's fingerprint no longer matches the copy", async () => {
            // A snapshot is immutable, so for one and the same id the copied fingerprint must
            // still match. A disagreement means a frozen row was rewritten — refuse, do not
            // reason about it.
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:new' }),
                currentFingerprint: 'v1:new',
                signoff: signoffCore({ fingerprint: 'v1:old' }),
            });
            expect(v.valid).toBe(false);
            expect(v.reason?.includes('Snapshot-Stand')).toBe(true);
        });

        await it('reports no snapshot / no sign-off distinctly', async () => {
            const noSnap = evaluateSignoffValidity({ snapshot: null, currentFingerprint: null, signoff: null });
            expect(noSnap.valid).toBe(false);
            expect(noSnap.reason?.includes('Snapshot')).toBe(true);

            const noSignoff = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: null,
            });
            expect(noSignoff.valid).toBe(false);
            expect(noSignoff.reason?.includes('Freigabe')).toBe(true);
        });

        await it('stays valid but flags dirty cross-checks in the reason', async () => {
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a', crossChecksClean: false }),
            });
            expect(v.valid).toBe(true);
            expect(v.reason?.includes('Querprüfungen')).toBe(true);
        });
    });

    await describe('computeSubmissionGate (the submission gate)', async () => {
        await it('unlocks only when a valid, non-stale, clean sign-off exists', async () => {
            const gate = computeSubmissionGate({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a', crossChecksClean: true }),
            });
            expect(gate.unlocked).toBe(true);
            expect(gate.blockers).toStrictEqual([]);
        });

        await it('blocks when the cross-checks were dirty at sign-off', async () => {
            const gate = computeSubmissionGate({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a', crossChecksClean: false }),
            });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('Querprüfungen'))).toBe(true);
        });

        await it('blocks with "no snapshot" when nothing is captured', async () => {
            const gate = computeSubmissionGate({ snapshot: null, currentFingerprint: null, signoff: null });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('Kein Filing-Snapshot'))).toBe(true);
        });

        await it('blocks with "no sign-off" when a fresh snapshot is unsigned', async () => {
            const gate = computeSubmissionGate({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: null,
            });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('Keine Freigabe'))).toBe(true);
        });

        await it('blocks with "snapshot stale" once the data drifted (not double-listing the sign-off)', async () => {
            const gate = computeSubmissionGate({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:b',
                signoff: signoffCore({ fingerprint: 'v1:a', crossChecksClean: true }),
            });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('veraltet'))).toBe(true);
        });

        await it('blocks a revoked sign-off', async () => {
            const gate = computeSubmissionGate({
                snapshot: snapCore({ fingerprint: 'v1:a' }),
                currentFingerprint: 'v1:a',
                signoff: signoffCore({ fingerprint: 'v1:a', revoked: true, crossChecksClean: true }),
            });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('widerrufen'))).toBe(true);
        });
    });

    await describe('end-to-end drift binding (real fingerprints → gate re-locks)', async () => {
        await it('a sign-off is valid at capture and the gate re-locks after a fingerprint-changing edit', async () => {
            const captureFp = computeFingerprintFromInputs(fpInputs());
            const changedFp = computeFingerprintFromInputs(
                fpInputs({
                    txs: [
                        {
                            id: 'camt_abc',
                            amount: -200,
                            bookingDate: '2025-03-01',
                            category: undefined,
                            source: 'camt',
                        },
                    ],
                }),
            );
            expect(captureFp === changedFp).toBe(false);

            const snapshot = snapCore({ fingerprint: captureFp });
            const signoff = signoffCore({ fingerprint: captureFp, crossChecksClean: true });

            // Right after capture, the live fingerprint matches → valid + unlocked.
            expect(evaluateSignoffValidity({ snapshot, currentFingerprint: captureFp, signoff }).valid).toBe(true);
            expect(computeSubmissionGate({ snapshot, currentFingerprint: captureFp, signoff }).unlocked).toBe(true);

            // After a booking edit, the live fingerprint drifts → invalid + gate re-locked.
            const drifted = evaluateSignoffValidity({ snapshot, currentFingerprint: changedFp, signoff });
            expect(drifted.valid).toBe(false);
            expect(drifted.stale).toBe(true);
            const gate = computeSubmissionGate({ snapshot, currentFingerprint: changedFp, signoff });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('veraltet'))).toBe(true);
        });
    });

    /**
     * The case the fingerprint comparison could not see.
     *
     * The fingerprint hashes the INPUTS — transactions, overrides, config — and deliberately not
     * our computation. So a CODE fix that changes a declared figure produces a new snapshot with
     * an IDENTICAL fingerprint. It happened: fixing the document-to-payment apportioning moved an
     * Anlage-EÜR profit from 837,56 € to 838,61 €, same fingerprint, and the gate reported the old
     * sign-off as still binding — ready to transmit a number nobody had approved.
     */
    await describe('sign-off binds to the SNAPSHOT, not to its inputs', async () => {
        const signedOld = signoffCore({ snapshotId: 'snap_alt', fingerprint: 'v1:same' });
        const newSnapshot = snapCore({ id: 'snap_neu', fingerprint: 'v1:same' });

        await it('re-locks the gate when a new snapshot carries the same fingerprint', async () => {
            const gate = computeSubmissionGate({
                snapshot: newSnapshot,
                currentFingerprint: 'v1:same',
                signoff: signedOld,
            });
            expect(gate.unlocked).toBe(false);
            expect(gate.blockers.some((b) => b.includes('veralteten Snapshot-Stand'))).toBe(true);
        });

        await it('reports the sign-off as invalid for that snapshot', async () => {
            const v = evaluateSignoffValidity({
                snapshot: newSnapshot,
                currentFingerprint: 'v1:same',
                signoff: signedOld,
            });
            expect(v.valid).toBe(false);
            // NOT drift: the underlying data is unchanged, which is exactly why the fingerprint
            // check stayed silent. Reporting it as drift would send the reader hunting for a
            // booking edit that never happened.
            expect(v.stale).toBe(false);
        });

        await it('stays valid for the snapshot it was actually signed for — the discriminator', async () => {
            // Without this, a check that always blocks would pass the two tests above.
            const v = evaluateSignoffValidity({
                snapshot: snapCore({ id: 'snap_alt', fingerprint: 'v1:same' }),
                currentFingerprint: 'v1:same',
                signoff: signedOld,
            });
            expect(v.valid).toBe(true);
            expect(
                computeSubmissionGate({
                    snapshot: snapCore({ id: 'snap_alt', fingerprint: 'v1:same' }),
                    currentFingerprint: 'v1:same',
                    signoff: signedOld,
                }).unlocked,
            ).toBe(true);
        });
    });
};
