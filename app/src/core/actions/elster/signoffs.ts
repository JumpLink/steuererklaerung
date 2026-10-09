/**
 * Fingerprint-bound filing sign-offs (S9) — the submission gate for the ELSTER "Absenden" flow.
 *
 * A sign-off is an explicit human RELEASE recorded against an immutable {@link FilingSnapshot}: it
 * binds to that snapshot's input fingerprint + captures the machine cross-check verdict at release
 * time (see filings/signoffs.ts). Its whole point is to go **stale automatically** — the moment the
 * scoped data drifts, the live recomputed fingerprint no longer equals the frozen one and the
 * release is no longer valid. Submission must be blocked unless a valid, non-stale sign-off exists
 * AND the cross-checks were clean.
 *
 * Layered like the snapshots + cross-checks actions: PURE evaluators ({@link evaluateSignoffValidity},
 * {@link computeSubmissionGate}, {@link assertSnapshotSignable}) — unit-testable on hand-built
 * fixtures, no I/O — plus thin store-scoped orchestrators (signOffFiling / getSignoffStatus /
 * evaluateSubmissionGate / revokeFilingSignoff) that gather inputs and delegate. Entity → account
 * scope + config resolution is REUSED from the snapshots action (resolveEntityScope), never
 * duplicated; the fingerprint + cross-checks come from their own actions.
 */

import {
    insertSignoff,
    getSignoff,
    latestSignoff,
    listSignoffs,
    revokeSignoff,
    type FilingSignoff,
    type FilingSnapshot,
    type LedgerDatabase,
    ledgerDbPath,
    migrate,
    openLedger,
} from '@steuererklaerung/store';
import { loadPaperlessConfig } from '../../config/index.ts';
import {
    computeCrossChecks,
    summarizeCrossChecks,
    type CrossCheckResult,
    type CrossCheckSummary,
} from './cross-checks.ts';
import { computeInputFingerprint } from './fingerprint.ts';
import { assertFormType, getFilingSnapshot, latestFilingSnapshot, resolveEntityScope } from './snapshots.ts';

export type { FilingSignoff } from '@steuererklaerung/store';

/** Open + migrate + close the ledger around a synchronous `fn` (mirrors actions/snapshots.ts). */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

// ── Pure evaluators (no I/O — the testable core) ────────────────────────────

/** The already-gathered inputs a sign-off verdict is computed from (pure — no I/O). */
export interface SignoffEvalInputs {
    /**
     * The latest immutable snapshot for the entity/year/form (null = none captured yet).
     * `id` is part of the shape because the sign-off binds to THAT document, not to its inputs —
     * see {@link signoffBindsToSnapshot}. Narrowing this to `fingerprint` alone is what hid the
     * binding defect: the only comparison in reach was the one that cannot see a figure change.
     */
    snapshot: Pick<FilingSnapshot, 'id' | 'fingerprint'> | null;
    /** The live recomputed input fingerprint for the same scope (null when there is no snapshot). */
    currentFingerprint: string | null;
    /** The latest sign-off for the entity/year/form (revoked or not; null = none). */
    signoff: Pick<FilingSignoff, 'snapshotId' | 'fingerprint' | 'revoked' | 'crossChecksClean'> | null;
}

/** The fingerprint-binding verdict of a sign-off against the current data. */
export interface SignoffValidity {
    /** The sign-off is still validly BOUND: non-revoked, bound to the latest snapshot, no drift since. */
    valid: boolean;
    /** The latest snapshot has drifted since capture (live fingerprint ≠ the snapshot's frozen one). */
    stale: boolean;
    /** German explanation of any invalidity (or a note when valid but the cross-checks were dirty). */
    reason: string | null;
}

/**
 * Does this sign-off still bind to this snapshot?
 *
 * Compared by snapshot ID, not by fingerprint. The fingerprint hashes the INPUTS — transactions,
 * overrides, config (see fingerprint.ts, deliberately) — so it does NOT change when OUR
 * COMPUTATION does. A real case: fixing the document-to-payment apportioning moved an Anlage-EÜR
 * profit from 837,56 € to 838,61 € and produced a new snapshot with the SAME fingerprint. Both
 * callers below compared fingerprints, found them equal, reported the release as valid, and would
 * have sent a figure nobody approved under a sign-off for the old one. A sign-off approves ONE
 * frozen document; only its identity can express that.
 *
 * The fingerprint copy is still checked, as a CORRUPTION guard: a snapshot is immutable, so for
 * one and the same id the fingerprint the sign-off copied must still match. If it does not,
 * something rewrote a frozen row and nothing here should be trusted. Both conditions together are
 * strictly stronger than either alone.
 *
 * One predicate for both callers on purpose — the drifted copy is the one that gets read.
 */
function signoffBindsToSnapshot(
    signoff: Pick<FilingSignoff, 'snapshotId' | 'fingerprint'>,
    snapshot: Pick<FilingSnapshot, 'id' | 'fingerprint'>,
): boolean {
    return signoff.snapshotId === snapshot.id && signoff.fingerprint === snapshot.fingerprint;
}

const STALE_BINDING_REASON = 'Freigabe bezieht sich auf einen veralteten Snapshot-Stand — bitte neu freigeben.';

/**
 * The PURE sign-off verdict. `valid` is the FINGERPRINT-BINDING check only (a non-revoked sign-off
 * bound to the latest snapshot with no drift since) — cross-check cleanliness is a SEPARATE gate
 * condition (see {@link computeSubmissionGate}), so a release can be validly bound yet still be
 * blocked from submission by dirty cross-checks (surfaced here as a `reason` note).
 */
export function evaluateSignoffValidity(inputs: SignoffEvalInputs): SignoffValidity {
    const { snapshot, currentFingerprint, signoff } = inputs;
    const stale = snapshot != null && currentFingerprint != null && snapshot.fingerprint !== currentFingerprint;

    if (!snapshot) {
        return { valid: false, stale: false, reason: 'Kein Filing-Snapshot vorhanden.' };
    }
    if (!signoff) {
        return { valid: false, stale, reason: 'Keine Freigabe (sign-off) vorhanden.' };
    }
    if (signoff.revoked) {
        return { valid: false, stale, reason: 'Freigabe wurde widerrufen.' };
    }
    if (!signoffBindsToSnapshot(signoff, snapshot)) {
        return { valid: false, stale, reason: STALE_BINDING_REASON };
    }
    if (stale) {
        return {
            valid: false,
            stale,
            reason: 'Daten haben sich seit der Freigabe geändert (Drift) — neu erfassen und freigeben.',
        };
    }
    return {
        valid: true,
        stale: false,
        reason: signoff.crossChecksClean
            ? null
            : 'Freigabe gültig, aber die Querprüfungen waren dabei nicht sauber (Fehler) — vor der Abgabe klären.',
    };
}

/** The submission-gate verdict: unlocked only when there are no blockers. */
export interface SubmissionGate {
    /** True ⇒ submission is allowed (no blockers). */
    unlocked: boolean;
    /** Human German list of everything currently blocking submission (empty ⇒ unlocked). */
    blockers: string[];
}

/**
 * The PURE submission gate: enumerate every current blocker (no snapshot / snapshot drifted / no
 * valid sign-off / cross-checks not clean). `unlocked` iff the list is empty. Kept non-redundant —
 * a drifted snapshot reports the drift (not also "sign-off stale"), since re-capturing is the fix.
 * ERiC availability is deliberately NOT checked here (it is a send-time concern, see
 * `evaluateSubmissionGate`).
 */
export function computeSubmissionGate(inputs: SignoffEvalInputs): SubmissionGate {
    const { snapshot, currentFingerprint, signoff } = inputs;
    const stale = snapshot != null && currentFingerprint != null && snapshot.fingerprint !== currentFingerprint;
    const blockers: string[] = [];

    if (!snapshot) {
        blockers.push('Kein Filing-Snapshot vorhanden — zuerst einen Snapshot erfassen.');
    } else if (stale) {
        blockers.push(
            'Snapshot veraltet — die zugrunde liegenden Daten haben sich seit der Erfassung geändert; neu erfassen.',
        );
    }

    if (snapshot) {
        if (!signoff) {
            blockers.push('Keine Freigabe (sign-off) vorhanden.');
        } else if (signoff.revoked) {
            blockers.push('Freigabe wurde widerrufen — bitte neu freigeben.');
        } else if (!stale && !signoffBindsToSnapshot(signoff, snapshot)) {
            // A newer snapshot replaced the one this release was bound to (drift is reported above).
            blockers.push(STALE_BINDING_REASON);
        }
    }

    // Cross-check cleanliness is bound into the sign-off (captured against the same fingerprint), so a
    // non-drifted valid sign-off reflects the current data — no re-fetch needed to gate on it.
    if (signoff && !signoff.crossChecksClean) {
        blockers.push('Querprüfungen waren bei der Freigabe nicht sauber (Fehler) — vor der Abgabe klären.');
    }

    return { unlocked: blockers.length === 0, blockers };
}

/**
 * Guard: a snapshot must EXIST and be FRESH (not drifted) before it can be signed off. Never sign off
 * drifted data — re-snapshot first. Throws a clear German error otherwise; a no-op when signable.
 */
export function assertSnapshotSignable(snapshot: FilingSnapshot | null, stale: boolean): void {
    if (!snapshot) {
        throw new Error(
            'Kein Filing-Snapshot vorhanden — zuerst einen Snapshot erfassen (elster snapshot), dann freigeben.',
        );
    }
    if (stale) {
        throw new Error(
            'Snapshot ist veraltet (Daten haben sich seit der Erfassung geändert) — vor der Freigabe neu erfassen (elster snapshot).',
        );
    }
}

// ── Store-scoped orchestrators (the I/O layer) ──────────────────────────────

/** Whether the given snapshot has drifted (live fingerprint ≠ frozen) — resolves scope + recomputes. */
function snapshotStale(snapshot: FilingSnapshot): boolean {
    const scope = resolveEntityScope(snapshot.entityId);
    const current = computeInputFingerprint(loadPaperlessConfig(), {
        entity: snapshot.entityId,
        year: snapshot.year,
        accountKeys: scope.accountKeys,
        elster: scope.elster,
        est: scope.est,
    });
    return snapshot.fingerprint !== current;
}

/** The result of {@link signOffFiling}: the created sign-off + the captured cross-check verdict. */
export interface SignOffResult {
    signoff: FilingSignoff;
    /** The machine cross-check verdict recorded at sign-off time (null if the checks could not run). */
    crossChecks: { summary: CrossCheckSummary; results: CrossCheckResult[] } | null;
}

/**
 * Record an explicit human RELEASE of a filing snapshot. Resolves the target snapshot (explicit
 * `snapshotId`, else the latest for the entity/year/form); REFUSES (throws) when there is no snapshot
 * or the snapshot is already stale (never sign off drifted data — re-snapshot first). Recomputes the
 * cross-checks, records their clean/dirty verdict, and writes an append-only sign-off carrying the
 * snapshot's fingerprint. Returns the created sign-off + the verdict.
 */
export async function signOffFiling(opts: {
    entity: string;
    year: number;
    formType: string;
    /**
     * Sub-year scope for a PERIODIC form (USt-VA): `2025-Q1`. Omit for the annual forms, whose
     * snapshots and sign-offs all carry a null period. Passing it is what keeps a Q1 release from
     * reading as covering Q2.
     */
    period?: string | null;
    snapshotId?: string;
    signedBy?: string;
    note?: string;
}): Promise<SignOffResult> {
    const form = assertFormType(opts.formType);
    const config = loadPaperlessConfig();
    const scope = resolveEntityScope(opts.entity);

    // Resolve the target snapshot: an explicit id wins, else the latest for this entity/year/form.
    const snapshot = opts.snapshotId
        ? getFilingSnapshot(opts.snapshotId)
        : latestFilingSnapshot(opts.entity, opts.year, form, opts.period);

    if (opts.snapshotId && snapshot) {
        if (snapshot.entityId !== opts.entity || snapshot.year !== opts.year || snapshot.formType !== form) {
            throw new Error(
                `Snapshot '${opts.snapshotId}' passt nicht zu ${opts.entity}/${opts.year}/${form} ` +
                    `(ist ${snapshot.entityId}/${snapshot.year}/${snapshot.formType}).`,
            );
        }
    }

    const stale = snapshot ? snapshotStale(snapshot) : false;
    assertSnapshotSignable(snapshot, stale);
    // `snapshot` is guaranteed non-null past the guard, but TS cannot see through the assertion.
    const bound = snapshot as FilingSnapshot;

    // Bind the readiness verdict at release time. A total failure to run the checks is recorded as
    // NOT clean (conservative: an un-verifiable return must not read as released-clean).
    let crossChecks: SignOffResult['crossChecks'] = null;
    let crossChecksClean = false;
    try {
        const results = await computeCrossChecks(config, {
            entity: opts.entity,
            year: opts.year,
            accountKeys: scope.accountKeys,
            elster: scope.elster,
        });
        const summary = summarizeCrossChecks(results);
        crossChecks = { summary, results };
        crossChecksClean = summary.clean;
    } catch {
        crossChecksClean = false;
    }

    const signoff = withLedger((db) =>
        insertSignoff(
            db,
            {
                snapshotId: bound.id,
                entityId: opts.entity,
                year: opts.year,
                formType: form,
                // Copied from the SNAPSHOT, not from opts: the release binds to the artefact it was
                // read against, so a mismatch between the two cannot silently widen its scope.
                period: bound.period,
                fingerprint: bound.fingerprint,
                signedBy: opts.signedBy ?? null,
                note: opts.note ?? null,
                crossChecksClean,
            },
            nowIso(),
        ),
    );

    return { signoff, crossChecks };
}

/** The live status of an entity/year/form's sign-off, bound to the latest snapshot. */
export interface SignoffStatus {
    /** The latest immutable snapshot for the scope (null = none captured yet). */
    snapshot: FilingSnapshot | null;
    /** The latest sign-off for the scope (revoked or not; null = none). */
    signoff: FilingSignoff | null;
    /** Non-revoked sign-off bound to the latest snapshot's fingerprint, with no drift since (see below). */
    valid: boolean;
    /** The latest snapshot has drifted since capture. */
    stale: boolean;
    /** German explanation of any invalidity (or a cross-checks-dirty note when otherwise valid). */
    reason: string | null;
}

/**
 * Read the live sign-off status for an entity/year/form: the latest snapshot + the latest sign-off,
 * and whether that sign-off is still validly bound to the current data. Cheap + side-effect-free —
 * one store scan for the fingerprint, no Paperless fetch.
 */
export function getSignoffStatus(opts: {
    entity: string;
    year: number;
    formType: string;
    period?: string | null;
}): SignoffStatus {
    const form = assertFormType(opts.formType);
    const config = loadPaperlessConfig();
    const scope = resolveEntityScope(opts.entity);

    const snapshot = latestFilingSnapshot(opts.entity, opts.year, form, opts.period);
    const signoff = withLedger((db) =>
        latestSignoff(db, { entityId: opts.entity, year: opts.year, formType: form, period: opts.period }),
    );
    const currentFingerprint = snapshot
        ? computeInputFingerprint(config, {
              entity: opts.entity,
              year: opts.year,
              accountKeys: scope.accountKeys,
              elster: scope.elster,
              est: scope.est,
          })
        : null;

    const { valid, stale, reason } = evaluateSignoffValidity({ snapshot, currentFingerprint, signoff });
    return { snapshot, signoff, valid, stale, reason };
}

/**
 * The submission gate for an entity/year/form: is "Absenden" unlocked, and if not, why. Gathers the
 * latest snapshot + sign-off + the live fingerprint and delegates to the pure {@link computeSubmissionGate}.
 * Cheap + sync (no Paperless): cross-check cleanliness is read from the fingerprint-bound sign-off,
 * not re-fetched.
 *
 * TODO(eric): ERiC availability is a SEND-TIME concern (getEricStatus does a native-binding probe /
 * dynamic import) and is checked in the submit path, not here — keeping this gate cheap + sync. Add
 * it as a soft blocker there.
 */
export function evaluateSubmissionGate(opts: {
    entity: string;
    year: number;
    formType: string;
    period?: string | null;
}): SubmissionGate {
    const form = assertFormType(opts.formType);
    const config = loadPaperlessConfig();
    const scope = resolveEntityScope(opts.entity);

    const snapshot = latestFilingSnapshot(opts.entity, opts.year, form, opts.period);
    const signoff = withLedger((db) =>
        latestSignoff(db, { entityId: opts.entity, year: opts.year, formType: form, period: opts.period }),
    );
    const currentFingerprint = snapshot
        ? computeInputFingerprint(config, {
              entity: opts.entity,
              year: opts.year,
              accountKeys: scope.accountKeys,
              elster: scope.elster,
              est: scope.est,
          })
        : null;

    return computeSubmissionGate({ snapshot, currentFingerprint, signoff });
}

/** All sign-offs for an entity/year (newest first), optionally narrowed to one form type. */
export function listFilingSignoffs(entity: string, year: number, formType?: string): FilingSignoff[] {
    return withLedger((db) => listSignoffs(db, { entityId: entity, year, formType }));
}

/**
 * Revoke a sign-off by id (soft, auditable withdrawal — the only mutation; substantive fields stay
 * frozen). Verifies the sign-off belongs to `entity` before revoking. Returns the updated sign-off,
 * or null if the id is unknown.
 */
export function revokeFilingSignoff(entity: string, id: string): FilingSignoff | null {
    return withLedger((db) => {
        const existing = getSignoff(db, id);
        if (existing && existing.entityId !== entity) {
            throw new Error(`Freigabe '${id}' gehört zu Entität '${existing.entityId}', nicht '${entity}'.`);
        }
        return revokeSignoff(db, id);
    });
}
