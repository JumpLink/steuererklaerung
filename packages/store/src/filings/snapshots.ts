/**
 * Immutable filing snapshots (schema v7) — the durable object a submission + sign-off binds to.
 *
 * A `FilingSnapshot` freezes, at capture time, everything that describes ONE generated tax return:
 * the generated ELSTER XML, the headline figures (JSON), the input fingerprint (see the app-side
 * `computeInputFingerprint`), a timestamp, and the form type. Rows are **append-only**: the XML,
 * figures and fingerprint are written ONCE at insert and never mutated — there is deliberately no
 * repo function that updates them. The ONLY permitted mutations are status transitions
 * (`validated` / `submitted` / `superseded`) and, on submit, recording the transfer ticket +
 * server protocol. This is what makes a filed return re-checkable ("what exactly did I file, and
 * does my current data still agree with it?"): a later data edit flips the live fingerprint, and
 * comparing it against a snapshot's frozen fingerprint detects the drift.
 *
 * Sibling to the mergeable `filings` register (which tracks the erledigt/paid state of an
 * obligation): a snapshot stores MORE and is immutable, so it is its own append-only table rather
 * than an extension of `filings`.
 */

import { createHash } from 'node:crypto';
import type { LedgerDatabase } from '../ledger/db.ts';

/** The statutory forms a snapshot can capture (each has an ELSTER XML builder). */
export type FilingFormType = 'ustva' | 'euer' | 'uste' | 'gewst' | 'feststellung' | 'est';

/**
 * Snapshot lifecycle: `draft` (just captured) → `validated` (passed local ERiC validation) →
 * `submitted` (transmitted; carries the transfer ticket + protocol). `superseded` marks a snapshot
 * replaced by a newer one (e.g. after the data drifted and a fresh snapshot was taken). The state
 * MACHINE (which transitions are legal, the test-first ladder) lives in the later submission slice;
 * this table only records the state.
 */
export type FilingSnapshotStatus = 'draft' | 'validated' | 'submitting' | 'submitted' | 'superseded';

export interface FilingSnapshot {
    /** Stable snapshot id (`snap_<hex>`), generated at insert. */
    id: string;
    /** Workspace entity id the return is for (gbr|jumplink|privat). */
    entityId: string;
    /** Tax year (the annual scope; for USt-VA the concrete period is inside `figures`). */
    year: number;
    /** Form type — one of {@link FilingFormType}; stored as free text so a future form needs no migration. */
    formType: string;
    /**
     * Sub-year scope: `null` for the annual forms, `YYYY-Qn` / `YYYY-MM` for a USt-VA.
     *
     * Without it, "the latest ustva snapshot of 2025" was ambiguous the moment two quarters had
     * been captured — and the newest would be handed to a submission the user had started for the
     * older one. Sending the wrong period's XML is not a display bug.
     */
    period: string | null;
    /** Capture timestamp (ISO). */
    createdAt: string;
    /** The input fingerprint at capture time (freshness/binding key). */
    fingerprint: string;
    /** The generated ELSTER XML, frozen (never mutated after insert). */
    xml: string;
    /** The captured headline figures (parsed from the stored JSON). Shape defined by the action layer. */
    figures: unknown;
    status: FilingSnapshotStatus;
    /** ELSTER Transferticket, set on submit (null until then). */
    transferTicket: string | null;
    /** ELSTER Übertragungsprotokoll reference, set on submit (null until then). */
    serverProtocol: string | null;
    /** How it was submitted: 'eric' (transmitted via ERiC) | 'web-form' (hand-entered in Mein ELSTER); null until submit. */
    submissionSource: string | null;
    /** Actual submission date (YYYY-MM-DD) — distinct from `createdAt` for a recorded web filing; null until submit. */
    submittedAt: string | null;
    note: string | null;
}

/** Insert payload for {@link createSnapshot}. `id`/`status` are defaulted; `figures` is any JSON-serialisable value. */
export interface CreateSnapshotInput {
    /** Optional explicit id (else generated). */
    id?: string;
    entityId: string;
    year: number;
    formType: string;
    /** Sub-year scope; omit (or null) for the annual forms. */
    period?: string | null;
    fingerprint: string;
    xml: string;
    figures: unknown;
    /** Initial status; defaults to `draft`. */
    status?: FilingSnapshotStatus;
    note?: string | null;
}

interface FilingSnapshotRow {
    id: string;
    entity_id: string;
    year: number;
    form_type: string;
    period: string | null;
    created_at: string;
    fingerprint: string;
    xml: string;
    figures: string;
    status: string;
    transfer_ticket: string | null;
    server_protocol: string | null;
    submission_source: string | null;
    submitted_at: string | null;
    note: string | null;
}

function rowToSnapshot(row: FilingSnapshotRow): FilingSnapshot {
    let figures: unknown = null;
    try {
        figures = row.figures ? JSON.parse(row.figures) : null;
    } catch {
        // A snapshot's figures blob is written by us as JSON; if it is somehow unparseable, fall
        // back to the raw string rather than throwing — the XML + fingerprint are the load-bearing
        // parts and must always read back.
        figures = row.figures;
    }
    return {
        id: row.id,
        entityId: row.entity_id,
        year: row.year,
        formType: row.form_type,
        period: row.period ?? null,
        createdAt: row.created_at,
        fingerprint: row.fingerprint,
        xml: row.xml,
        figures,
        status: (row.status as FilingSnapshotStatus) ?? 'draft',
        transferTicket: row.transfer_ticket,
        serverProtocol: row.server_protocol,
        submissionSource: row.submission_source,
        submittedAt: row.submitted_at,
        note: row.note,
    };
}

/** Deterministic-but-unique snapshot id (content + timestamp + salt → collision-free in practice). */
function newSnapshotId(input: CreateSnapshotInput, at: string): string {
    const seed = `${input.entityId}|${input.year}|${input.formType}|${at}|${Math.random()}`;
    return `snap_${createHash('sha1').update(seed).digest('hex').slice(0, 20)}`;
}

/**
 * INSERT a new immutable snapshot (never an UPSERT — a re-used id throws on the PK). The xml,
 * figures and fingerprint are frozen here; no repo function ever rewrites them. Returns the row.
 */
export function createSnapshot(db: LedgerDatabase, input: CreateSnapshotInput, at: string): FilingSnapshot {
    const id = input.id ?? newSnapshotId(input, at);
    db.prepare(
        `INSERT INTO filing_snapshots
           (id, entity_id, year, form_type, period, created_at, fingerprint, xml, figures, status, transfer_ticket, server_protocol, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        input.entityId,
        input.year,
        input.formType,
        input.period ?? null,
        at,
        input.fingerprint,
        input.xml,
        JSON.stringify(input.figures ?? null),
        input.status ?? 'draft',
        null,
        null,
        input.note ?? null,
    );
    const saved = getSnapshot(db, id);
    if (!saved) throw new Error('Filing snapshot insert failed to persist');
    return saved;
}

/** One snapshot by id, or null. */
export function getSnapshot(db: LedgerDatabase, id: string): FilingSnapshot | null {
    const row = db.prepare(`SELECT * FROM filing_snapshots WHERE id = ?`).get(id) as unknown as
        | FilingSnapshotRow
        | undefined;
    return row ? rowToSnapshot(row) : null;
}

/**
 * List snapshots for an entity + year (newest first), optionally narrowed to one form type.
 * Newest-first = the natural order for "the latest is authoritative" + a capture history.
 */
export function listSnapshots(
    db: LedgerDatabase,
    entityId: string,
    year: number,
    formType?: string,
): FilingSnapshot[] {
    const clauses = ['entity_id = ?', 'year = ?'];
    const params: Array<string | number> = [entityId, year];
    if (formType) {
        clauses.push('form_type = ?');
        params.push(formType);
    }
    const rows = db
        .prepare(
            `SELECT * FROM filing_snapshots WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
        )
        .all(...params) as unknown as FilingSnapshotRow[];
    return rows.map(rowToSnapshot);
}

/** The most recent snapshot for an entity/year/form, or null if none captured yet. */
export function latestSnapshot(
    db: LedgerDatabase,
    entityId: string,
    year: number,
    formType: string,
    period?: string | null,
): FilingSnapshot | null {
    // `undefined` means "no period filter", which is right for the annual forms — every row of
    // theirs has period NULL, so the scope is already unambiguous. A PERIODIC form must pass its
    // period: without the filter, asking for Q1 after Q2 was captured returns Q2's snapshot, and
    // a submission started for Q1 would carry Q2's XML.
    const scoped = period !== undefined;
    const row = db
        .prepare(
            `SELECT * FROM filing_snapshots WHERE entity_id = ? AND year = ? AND form_type = ?
             ${scoped ? (period === null ? 'AND period IS NULL' : 'AND period = ?') : ''}
             ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(...[entityId, year, formType, ...(scoped && period !== null ? [period] : [])]) as unknown as
        | FilingSnapshotRow
        | undefined;
    return row ? rowToSnapshot(row) : null;
}

/**
 * Mark a snapshot `validated` (local ERiC validation passed). Status-only mutation; the frozen
 * xml/figures/fingerprint are untouched. Returns the updated snapshot, or null if the id is unknown.
 */
export function markSnapshotValidated(db: LedgerDatabase, id: string): FilingSnapshot | null {
    db.prepare(`UPDATE filing_snapshots SET status = 'validated' WHERE id = ?`).run(id);
    return getSnapshot(db, id);
}

/**
 * Mark a snapshot `submitting` — a live_pending latch set BEFORE the transmission call so a crash
 * mid-send cannot be blindly retried (a retry would risk a double submission). The submit action
 * refuses to send a snapshot already in `submitting`, forcing manual reconciliation of whether the
 * prior attempt reached ELSTER. Status-only mutation. Returns the updated snapshot, or null if unknown.
 */
export function markSnapshotSubmitting(db: LedgerDatabase, id: string): FilingSnapshot | null {
    db.prepare(`UPDATE filing_snapshots SET status = 'submitting' WHERE id = ?`).run(id);
    return getSnapshot(db, id);
}

/**
 * Mark a snapshot `submitted` and record the ELSTER Transferticket + server protocol, plus how it was
 * submitted (`source`: 'eric' | 'web-form') and the actual submission date (`submittedAt`). The only
 * mutation besides the status transition; xml/figures/fingerprint stay frozen. A field left undefined
 * is not written (so an ERiC re-mark does not clobber a set value with null). Returns the updated
 * snapshot, or null if the id is unknown.
 */
export function markSnapshotSubmitted(
    db: LedgerDatabase,
    id: string,
    opts: {
        transferTicket?: string | null;
        serverProtocol?: string | null;
        source?: string | null;
        submittedAt?: string | null;
    } = {},
): FilingSnapshot | null {
    const existing = getSnapshot(db, id);
    if (!existing) return null;
    db.prepare(
        `UPDATE filing_snapshots
           SET status = 'submitted', transfer_ticket = ?, server_protocol = ?, submission_source = ?, submitted_at = ?
         WHERE id = ?`,
    ).run(
        opts.transferTicket ?? null,
        opts.serverProtocol ?? null,
        opts.source !== undefined ? opts.source : existing.submissionSource,
        opts.submittedAt !== undefined ? opts.submittedAt : existing.submittedAt,
        id,
    );
    return getSnapshot(db, id);
}

/**
 * Mark a snapshot `superseded` (a newer snapshot replaced it). Status-only mutation. Returns the
 * updated snapshot, or null if the id is unknown.
 */
export function markSuperseded(db: LedgerDatabase, id: string): FilingSnapshot | null {
    db.prepare(`UPDATE filing_snapshots SET status = 'superseded' WHERE id = ?`).run(id);
    return getSnapshot(db, id);
}
