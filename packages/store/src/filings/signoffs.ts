/**
 * Fingerprint-bound filing sign-offs (schema v8) — the durable human release a submission gate binds to.
 *
 * A `FilingSignoff` is an explicit, append-only record that a human RELEASED one immutable filing
 * snapshot (see filings/snapshots.ts) for submission. It copies, at sign-off time, that snapshot's
 * input `fingerprint` and the machine cross-check verdict (`cross_checks_clean`) — so the release is
 * bound to an exact data state. The binding is what makes a sign-off go **stale automatically**: the
 * moment the underlying data drifts, the live recomputed fingerprint no longer equals the frozen one
 * and the release is no longer valid (the return must be re-snapshotted and re-signed before submit).
 *
 * Rows are **append-only**: the substantive fields (snapshot_id, fingerprint, signed_by, signed_at,
 * note, cross_checks_clean) are written ONCE at insert and never rewritten — there is deliberately no
 * repo function that updates them. The ONLY permitted mutation is {@link revokeSignoff}, which flips
 * the `revoked` flag (a soft, auditable withdrawal); a re-release is a NEW row, never an edit.
 *
 * Sibling to filing_snapshots (the immutable object) — a sign-off records WHO released WHICH snapshot
 * at WHICH data state, so it is its own append-only table rather than a column on the snapshot.
 */

import { createHash } from 'node:crypto';
import type { LedgerDatabase } from '../ledger/db.ts';

export interface FilingSignoff {
    /** Stable sign-off id (`signoff_<hex>`), generated at insert. */
    id: string;
    /** The immutable filing snapshot this release binds to (filing_snapshots.id; FK-free like snapshots). */
    snapshotId: string;
    /** Workspace entity id the return is for (gbr|jumplink|privat). */
    entityId: string;
    /** Tax year (the annual scope). */
    year: number;
    /** Form type — one of the snapshot form types; stored as free text so a future form needs no migration. */
    formType: string;
    /** Sub-year scope, mirroring the snapshot's: `null` for the annual forms, `YYYY-Qn` for a USt-VA. */
    period: string | null;
    /** The snapshot's input fingerprint, COPIED at sign-off time (the freshness/binding key). */
    fingerprint: string;
    /** Who released it (a human id / model id), or null. */
    signedBy: string | null;
    /** Sign-off timestamp (ISO). */
    signedAt: string;
    /** Optional owner note recorded with the release. */
    note: string | null;
    /** The machine cross-check verdict captured at sign-off time (true = no errors → clean). */
    crossChecksClean: boolean;
    /** Soft withdrawal flag: true once {@link revokeSignoff} was called (the only mutation). */
    revoked: boolean;
}

/** Insert payload for {@link insertSignoff}. `id` is defaulted; `revoked` is always 0 at insert. */
export interface CreateSignoffInput {
    /** Optional explicit id (else generated). */
    id?: string;
    snapshotId: string;
    entityId: string;
    year: number;
    formType: string;
    /** Sub-year scope; omit (or null) for the annual forms. */
    period?: string | null;
    fingerprint: string;
    signedBy?: string | null;
    note?: string | null;
    /** The captured cross-check verdict (true = clean). */
    crossChecksClean: boolean;
}

/** Filter for the list/latest queries. `formType` narrows to one form when set. */
export interface SignoffFilter {
    entityId: string;
    year: number;
    formType?: string;
}

interface FilingSignoffRow {
    id: string;
    snapshot_id: string;
    entity_id: string;
    year: number;
    form_type: string;
    period: string | null;
    fingerprint: string;
    signed_by: string | null;
    signed_at: string;
    note: string | null;
    cross_checks_clean: number;
    revoked: number;
}

function rowToSignoff(row: FilingSignoffRow): FilingSignoff {
    return {
        id: row.id,
        snapshotId: row.snapshot_id,
        entityId: row.entity_id,
        year: row.year,
        formType: row.form_type,
        period: row.period ?? null,
        fingerprint: row.fingerprint,
        signedBy: row.signed_by,
        signedAt: row.signed_at,
        note: row.note,
        crossChecksClean: row.cross_checks_clean === 1,
        revoked: row.revoked === 1,
    };
}

/** Deterministic-but-unique sign-off id (content + timestamp + salt → collision-free in practice). */
function newSignoffId(input: CreateSignoffInput, at: string): string {
    const seed = `${input.entityId}|${input.year}|${input.formType}|${input.snapshotId}|${at}|${Math.random()}`;
    return `signoff_${createHash('sha1').update(seed).digest('hex').slice(0, 20)}`;
}

/**
 * INSERT a new append-only sign-off (never an UPSERT — a re-used id throws on the PK). The snapshot
 * ref, fingerprint, signer, note and cross-check verdict are frozen here; no repo function ever
 * rewrites them (only {@link revokeSignoff} flips `revoked`). Returns the row.
 */
export function insertSignoff(db: LedgerDatabase, input: CreateSignoffInput, at: string): FilingSignoff {
    const id = input.id ?? newSignoffId(input, at);
    db.prepare(
        `INSERT INTO filing_signoffs
           (id, snapshot_id, entity_id, year, form_type, period, fingerprint, signed_by, signed_at, note, cross_checks_clean, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        input.snapshotId,
        input.entityId,
        input.year,
        input.formType,
        input.period ?? null,
        input.fingerprint,
        input.signedBy ?? null,
        at,
        input.note ?? null,
        input.crossChecksClean ? 1 : 0,
        0,
    );
    const saved = getSignoff(db, id);
    if (!saved) throw new Error('Filing sign-off insert failed to persist');
    return saved;
}

/** One sign-off by id, or null. */
export function getSignoff(db: LedgerDatabase, id: string): FilingSignoff | null {
    const row = db.prepare(`SELECT * FROM filing_signoffs WHERE id = ?`).get(id) as unknown as
        | FilingSignoffRow
        | undefined;
    return row ? rowToSignoff(row) : null;
}

/**
 * List sign-offs for an entity + year (newest first), optionally narrowed to one form type. Includes
 * revoked rows (the caller decides how to treat them) — newest-first = the natural order for "the
 * latest release is authoritative" + an audit history.
 */
export function listSignoffs(db: LedgerDatabase, filter: SignoffFilter): FilingSignoff[] {
    const clauses = ['entity_id = ?', 'year = ?'];
    const params: Array<string | number> = [filter.entityId, filter.year];
    if (filter.formType) {
        clauses.push('form_type = ?');
        params.push(filter.formType);
    }
    const rows = db
        .prepare(
            `SELECT * FROM filing_signoffs WHERE ${clauses.join(' AND ')} ORDER BY signed_at DESC, id DESC`,
        )
        .all(...params) as unknown as FilingSignoffRow[];
    return rows.map(rowToSignoff);
}

/** The most recent sign-off for an entity/year/form (revoked or not), or null if none exists. */
export function latestSignoff(
    db: LedgerDatabase,
    filter: { entityId: string; year: number; formType: string; period?: string | null },
): FilingSignoff | null {
    // Same rule as latestSnapshot: `undefined` means no period filter (correct for the annual
    // forms, whose rows are all NULL); a periodic form passes its period so a Q1 release cannot be
    // read as covering Q2.
    const scoped = filter.period !== undefined;
    const row = db
        .prepare(
            `SELECT * FROM filing_signoffs WHERE entity_id = ? AND year = ? AND form_type = ?
             ${scoped ? (filter.period === null ? 'AND period IS NULL' : 'AND period = ?') : ''}
             ORDER BY signed_at DESC, id DESC LIMIT 1`,
        )
        .get(
            ...[
                filter.entityId,
                filter.year,
                filter.formType,
                ...(scoped && filter.period != null ? [filter.period] : []),
            ],
        ) as unknown as FilingSignoffRow | undefined;
    return row ? rowToSignoff(row) : null;
}

/**
 * Revoke a sign-off — the ONLY permitted mutation. Flips `revoked` to 1; the substantive fields
 * (snapshot_id, fingerprint, signed_by, signed_at, note, cross_checks_clean) stay frozen. Returns the
 * updated sign-off, or null if the id is unknown. A re-release is a fresh {@link insertSignoff} row.
 */
export function revokeSignoff(db: LedgerDatabase, id: string): FilingSignoff | null {
    db.prepare(`UPDATE filing_signoffs SET revoked = 1 WHERE id = ?`).run(id);
    return getSignoff(db, id);
}
