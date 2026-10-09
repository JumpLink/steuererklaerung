/**
 * Time tracking data access on the SQLite `time_entries` table (schema v12).
 *
 * Pure data layer: every mutation takes an `at` ISO timestamp from the caller (like contacts.ts
 * and periods.ts) so it stays testable; ids are generated with crypto.randomUUID() when not
 * supplied.
 *
 * One rule is enforced here rather than in a frontend: at most ONE timer may run per entity.
 * Otherwise a forgotten timer in the CLI and a second one in the app silently double-count the
 * same afternoon, and nothing downstream could tell which interval was real.
 */

import type { LedgerDatabase } from '../ledger/db.ts';
import type { TimeEntry, TimeEntryFilter, TimeEntryInput, TimeEntrySource, TimeSummaryRow } from './types.ts';

interface TimeEntryRow {
    id: string;
    entity_id: string;
    contact_id: string | null;
    project: string;
    project_id: string | null;
    description: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    billable: number;
    invoice_id: string | null;
    source: string;
    external_id: string | null;
    note: string | null;
    created_at: string;
    updated_at: string;
}

function rowToEntry(row: TimeEntryRow): TimeEntry {
    return {
        id: row.id,
        entityId: row.entity_id,
        contactId: row.contact_id,
        project: row.project,
        projectId: row.project_id,
        description: row.description,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationSeconds: row.duration_seconds,
        billable: row.billable !== 0,
        invoiceId: row.invoice_id,
        source: row.source as TimeEntrySource,
        externalId: row.external_id,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Whole seconds between two ISO timestamps, never negative. */
export function secondsBetween(startedAt: string, endedAt: string): number {
    const secs = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
    return secs > 0 ? secs : 0;
}

/**
 * Build the WHERE clause for a filter.
 *
 * `from`/`to` are compared against the ISO timestamp as a STRING. That works because ISO-8601 in
 * UTC sorts lexicographically, and it lets a plain date ('2026-08-12') bound a timestamp: `to` is
 * padded so the whole day is included instead of cutting off at midnight.
 */
function buildWhere(filter: TimeEntryFilter): { sql: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.entityId) {
        clauses.push('entity_id = ?');
        params.push(filter.entityId);
    }
    if (filter.contactId) {
        clauses.push('contact_id = ?');
        params.push(filter.contactId);
    }
    if (filter.project) {
        clauses.push('project = ?');
        params.push(filter.project);
    }
    if (filter.projectId) {
        clauses.push('project_id = ?');
        params.push(filter.projectId);
    }
    if (filter.from) {
        clauses.push('started_at >= ?');
        params.push(filter.from);
    }
    if (filter.to) {
        clauses.push('started_at <= ?');
        params.push(filter.to.length === 10 ? `${filter.to}T23:59:59.999Z` : filter.to);
    }
    if (filter.unbilled === true) clauses.push('invoice_id IS NULL');
    if (filter.unbilled === false) clauses.push('invoice_id IS NOT NULL');
    if (filter.billable !== undefined) {
        clauses.push('billable = ?');
        params.push(filter.billable ? 1 : 0);
    }
    if (filter.running === true) clauses.push('ended_at IS NULL');
    if (filter.running === false) clauses.push('ended_at IS NOT NULL');
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Entries matching the filter, newest first. */
export function listTimeEntries(db: LedgerDatabase, filter: TimeEntryFilter = {}): TimeEntry[] {
    const { sql, params } = buildWhere(filter);
    const rows = db
        .prepare(`SELECT * FROM time_entries ${sql} ORDER BY started_at DESC`)
        .all(...params) as unknown as TimeEntryRow[];
    return rows.map(rowToEntry);
}

/** One entry by id, or null. */
export function getTimeEntry(db: LedgerDatabase, id: string): TimeEntry | null {
    const row = db.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(id) as unknown as TimeEntryRow | undefined;
    return row ? rowToEntry(row) : null;
}

/** The currently running entry of an entity, or null. */
export function getRunningTimeEntry(db: LedgerDatabase, entityId: string): TimeEntry | null {
    const row = db
        .prepare(`SELECT * FROM time_entries WHERE entity_id = ? AND ended_at IS NULL ORDER BY started_at DESC`)
        .get(entityId) as unknown as TimeEntryRow | undefined;
    return row ? rowToEntry(row) : null;
}

/** The entry previously imported under this external id, or null — the dedupe key for re-imports. */
export function findTimeEntryByExternalId(db: LedgerDatabase, entityId: string, externalId: string): TimeEntry | null {
    const row = db
        .prepare(`SELECT * FROM time_entries WHERE entity_id = ? AND external_id = ?`)
        .get(entityId, externalId) as unknown as TimeEntryRow | undefined;
    return row ? rowToEntry(row) : null;
}

/**
 * Insert or update an entry. With `input.id` set to an existing row it updates; otherwise it
 * inserts with a generated id.
 *
 * `durationSeconds` is derived from the interval when the caller does not supply one, so a
 * hand-entered "from 9 to 11" needs no arithmetic — but an explicitly passed value wins, which is
 * how a duration rounded to the billed quarter hour survives.
 */
export function upsertTimeEntry(db: LedgerDatabase, input: TimeEntryInput, at: string): TimeEntry {
    const existing = input.id ? getTimeEntry(db, input.id) : null;
    const id = input.id ?? `t_${crypto.randomUUID()}`;
    const endedAt = input.endedAt ?? null;
    const duration =
        input.durationSeconds ?? (endedAt ? secondsBetween(input.startedAt, endedAt) : null);

    if (existing) {
        db.prepare(
            `UPDATE time_entries SET
               entity_id = ?, contact_id = ?, project = ?, project_id = ?, description = ?,
               started_at = ?, ended_at = ?, duration_seconds = ?,
               billable = ?, invoice_id = ?, source = ?, external_id = ?, note = ?, updated_at = ?
             WHERE id = ?`,
        ).run(
            input.entityId,
            input.contactId ?? existing.contactId,
            input.project,
            // null drops the project link; only an absent value keeps it (the other fields cannot be cleared this way).
            input.projectId === undefined ? existing.projectId : input.projectId,
            input.description ?? existing.description,
            input.startedAt,
            endedAt,
            duration,
            (input.billable ?? existing.billable) ? 1 : 0,
            input.invoiceId ?? existing.invoiceId,
            input.source ?? existing.source,
            input.externalId ?? existing.externalId,
            input.note ?? existing.note,
            at,
            id,
        );
    } else {
        db.prepare(
            `INSERT INTO time_entries
               (id, entity_id, contact_id, project, project_id, description, started_at, ended_at,
                duration_seconds, billable, invoice_id, source, external_id, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id,
            input.entityId,
            input.contactId ?? null,
            input.project,
            input.projectId ?? null,
            input.description ?? null,
            input.startedAt,
            endedAt,
            duration,
            (input.billable ?? true) ? 1 : 0,
            input.invoiceId ?? null,
            input.source ?? 'manual',
            input.externalId ?? null,
            input.note ?? null,
            at,
            at,
        );
    }
    const stored = getTimeEntry(db, id);
    if (!stored) throw new Error(`Zeiteintrag ${id} konnte nach dem Schreiben nicht gelesen werden`);
    return stored;
}

/**
 * Start a timer. Throws if one is already running for this entity — see the module comment; a
 * silent second timer is worse than a refused start.
 */
export function startTimeEntry(
    db: LedgerDatabase,
    input: Omit<TimeEntryInput, 'endedAt' | 'durationSeconds'>,
    at: string,
): TimeEntry {
    const running = getRunningTimeEntry(db, input.entityId);
    if (running) {
        throw new Error(
            `Es läuft bereits ein Timer (${running.project}, seit ${running.startedAt}). Erst mit "time stop" beenden.`,
        );
    }
    return upsertTimeEntry(db, { ...input, endedAt: null, durationSeconds: null }, at);
}

/** Stop a running entry (the given one, or the entity's running one). Returns the stopped entry. */
export function stopTimeEntry(db: LedgerDatabase, entityId: string, at: string, id?: string): TimeEntry {
    const entry = id ? getTimeEntry(db, id) : getRunningTimeEntry(db, entityId);
    if (!entry) throw new Error('Es läuft kein Timer.');
    if (entry.endedAt) throw new Error(`Zeiteintrag ${entry.id} ist bereits beendet (${entry.endedAt}).`);
    db.prepare(`UPDATE time_entries SET ended_at = ?, duration_seconds = ?, updated_at = ? WHERE id = ?`).run(
        at,
        secondsBetween(entry.startedAt, at),
        at,
        entry.id,
    );
    const stopped = getTimeEntry(db, entry.id);
    if (!stopped) throw new Error(`Zeiteintrag ${entry.id} verschwand beim Stoppen`);
    return stopped;
}

export function deleteTimeEntry(db: LedgerDatabase, id: string): void {
    db.prepare(`DELETE FROM time_entries WHERE id = ?`).run(id);
}

/**
 * Attach entries to an invoice — this is what marks them billed.
 *
 * Refuses entries that already belong to a DIFFERENT invoice: silently re-pointing them would
 * make the older invoice unexplainable after the fact.
 */
export function markTimeEntriesInvoiced(
    db: LedgerDatabase,
    ids: readonly string[],
    invoiceId: string,
    at: string,
): number {
    let changed = 0;
    for (const id of ids) {
        const entry = getTimeEntry(db, id);
        if (!entry) throw new Error(`Zeiteintrag ${id} existiert nicht.`);
        if (entry.invoiceId && entry.invoiceId !== invoiceId) {
            throw new Error(`Zeiteintrag ${id} liegt bereits auf Rechnung ${entry.invoiceId}.`);
        }
        if (entry.invoiceId === invoiceId) continue;
        db.prepare(`UPDATE time_entries SET invoice_id = ?, updated_at = ? WHERE id = ?`).run(invoiceId, at, id);
        changed += 1;
    }
    return changed;
}

/** Grouped totals per project (+ contact), longest first. Running entries are excluded. */
export function summarizeTime(db: LedgerDatabase, filter: TimeEntryFilter = {}): TimeSummaryRow[] {
    const { sql, params } = buildWhere({ ...filter, running: false });
    const rows = db
        .prepare(
            `SELECT project, project_id, contact_id, COUNT(*) AS entries, COALESCE(SUM(duration_seconds), 0) AS seconds
             FROM time_entries ${sql}
             GROUP BY project, project_id, contact_id
             ORDER BY seconds DESC`,
        )
        .all(...params) as unknown as {
            project: string;
            project_id: string | null;
            contact_id: string | null;
            entries: number;
            seconds: number;
        }[];
    return rows.map((r) => ({
        project: r.project,
        projectId: r.project_id,
        contactId: r.contact_id,
        entries: r.entries,
        seconds: r.seconds,
    }));
}
