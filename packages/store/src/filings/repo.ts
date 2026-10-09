/**
 * Filing-register data access on the SQLite `filings` table
 * (schema v5; declared_amount + surcharge v10, assessed_amount + assessed_at v15).
 *
 * Pure data layer: every mutation takes an `at` ISO timestamp from the caller (like periods.ts /
 * contacts) so it stays testable. Upsert is a MERGE keyed by (entity_id, kind, period): a partial
 * patch (e.g. "set paid_at") preserves the other fields; pass null explicitly to clear one. The
 * four money columns are distinct on purpose — declared_amount (Anmeldungssoll, the authoritative
 * Soll), amount (paid/legacy), surcharge (Säumniszuschlag/Nebenleistung) and assessed_amount (what
 * the Finanzamt actually assessed) — see types.ts + schema.ts.
 */

import type { LedgerDatabase } from '../ledger/db.ts';
import type { Filing, FilingInput } from './types.ts';

interface FilingRow {
    entity_id: string;
    kind: string;
    period: string;
    filed_at: string | null;
    paid_at: string | null;
    amount: number | null;
    declared_amount: number | null;
    surcharge: number | null;
    assessed_amount: number | null;
    assessed_at: string | null;
    note: string | null;
    created_at: string;
    updated_at: string;
}

function rowToFiling(row: FilingRow): Filing {
    return {
        entityId: row.entity_id,
        kind: row.kind,
        period: row.period,
        filedAt: row.filed_at,
        paidAt: row.paid_at,
        amount: row.amount,
        // Pre-v10 rows have no declared_amount/surcharge column value → coalesce to null;
        // pre-v15 rows likewise have no assessed_amount/assessed_at.
        declaredAmount: row.declared_amount ?? null,
        surcharge: row.surcharge ?? null,
        assessedAmount: row.assessed_amount ?? null,
        assessedAt: row.assessed_at ?? null,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** The filing for one obligation, or null if none recorded yet. */
export function getFiling(db: LedgerDatabase, entityId: string, kind: string, period: string): Filing | null {
    const row = db
        .prepare(`SELECT * FROM filings WHERE entity_id = ? AND kind = ? AND period = ?`)
        .get(entityId, kind, period) as unknown as FilingRow | undefined;
    return row ? rowToFiling(row) : null;
}

/**
 * List filings, newest period first. Optionally scope to one entity and/or one year (period
 * begins with the 4-digit year, so '2025' matches '2025', '2025-Q2', '2025-03').
 */
export function listFilings(db: LedgerDatabase, opts: { entityId?: string; year?: number } = {}): Filing[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.entityId) {
        clauses.push('entity_id = ?');
        params.push(opts.entityId);
    }
    if (opts.year != null) {
        clauses.push('period LIKE ?');
        params.push(`${opts.year}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
        .prepare(`SELECT * FROM filings ${where} ORDER BY period DESC, entity_id, kind`)
        .all(...params) as unknown as FilingRow[];
    return rows.map(rowToFiling);
}

/** Insert or merge-update a filing. Returns the resulting row. */
export function upsertFiling(db: LedgerDatabase, input: FilingInput, at: string): Filing {
    const existing = getFiling(db, input.entityId, input.kind, input.period);
    if (existing) {
        db.prepare(
            `UPDATE filings SET filed_at = ?, paid_at = ?, amount = ?, declared_amount = ?, surcharge = ?,
                    assessed_amount = ?, assessed_at = ?, note = ?, updated_at = ?
             WHERE entity_id = ? AND kind = ? AND period = ?`,
        ).run(
            input.filedAt !== undefined ? input.filedAt : existing.filedAt,
            input.paidAt !== undefined ? input.paidAt : existing.paidAt,
            input.amount !== undefined ? input.amount : existing.amount,
            input.declaredAmount !== undefined ? input.declaredAmount : existing.declaredAmount,
            input.surcharge !== undefined ? input.surcharge : existing.surcharge,
            input.assessedAmount !== undefined ? input.assessedAmount : existing.assessedAmount,
            input.assessedAt !== undefined ? input.assessedAt : existing.assessedAt,
            input.note !== undefined ? input.note : existing.note,
            at,
            input.entityId,
            input.kind,
            input.period,
        );
    } else {
        db.prepare(
            `INSERT INTO filings (entity_id, kind, period, filed_at, paid_at, amount, declared_amount, surcharge,
                                  assessed_amount, assessed_at, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            input.entityId,
            input.kind,
            input.period,
            input.filedAt ?? null,
            input.paidAt ?? null,
            input.amount ?? null,
            input.declaredAmount ?? null,
            input.surcharge ?? null,
            input.assessedAmount ?? null,
            input.assessedAt ?? null,
            input.note ?? null,
            at,
            at,
        );
    }
    const saved = getFiling(db, input.entityId, input.kind, input.period);
    if (!saved) throw new Error('Filing upsert failed to persist');
    return saved;
}

/** Delete a filing. Returns true if a row was removed. */
export function removeFiling(db: LedgerDatabase, entityId: string, kind: string, period: string): boolean {
    const before = getFiling(db, entityId, kind, period);
    if (!before) return false;
    db.prepare(`DELETE FROM filings WHERE entity_id = ? AND kind = ? AND period = ?`).run(entityId, kind, period);
    return true;
}
