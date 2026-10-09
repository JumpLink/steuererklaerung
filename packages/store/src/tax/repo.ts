/**
 * Assessed tax key figures on the SQLite `tax_assessments` table (schema v13). Pure data layer like
 * filings/repo.ts: every function takes the db first and every mutation an `at` ISO timestamp from
 * the caller, so it stays testable without a clock.
 *
 * Upsert is a REPLACE of the figure keyed by (entity_id, year) — an Änderungsbescheid overwrites the
 * year's zvE and its document reference, and refreshes `recorded_at` (a re-record is a new capture);
 * `created_at` survives. `document_ref`/`note` follow the house merge convention: omitted preserves,
 * explicit null clears.
 */

import type { LedgerDatabase } from '../ledger/db.ts';
import type { TaxAssessment, TaxAssessmentInput } from './types.ts';

interface TaxAssessmentRow {
    entity_id: string;
    year: number;
    zve: number;
    document_ref: string | null;
    note: string | null;
    recorded_at: string;
    created_at: string;
}

function rowToAssessment(row: TaxAssessmentRow): TaxAssessment {
    return {
        entityId: row.entity_id,
        year: row.year,
        zve: row.zve,
        documentRef: row.document_ref,
        note: row.note,
        recordedAt: row.recorded_at,
        createdAt: row.created_at,
    };
}

function readRow(db: LedgerDatabase, entityId: string, year: number): TaxAssessmentRow | undefined {
    return db
        .prepare(`SELECT * FROM tax_assessments WHERE entity_id = ? AND year = ?`)
        .get(entityId, year) as unknown as TaxAssessmentRow | undefined;
}

/** Insert or replace one year's assessed figures. Returns the resulting row. */
export function upsertTaxAssessment(db: LedgerDatabase, input: TaxAssessmentInput, at: string): TaxAssessment {
    if (!Number.isFinite(input.zve)) throw new Error('zvE muss eine Zahl sein.');
    if (!Number.isInteger(input.year)) throw new Error('Veranlagungsjahr muss eine ganze Zahl sein.');
    const existing = readRow(db, input.entityId, input.year);
    if (existing) {
        db.prepare(
            `UPDATE tax_assessments SET zve = ?, document_ref = ?, note = ?, recorded_at = ?
             WHERE entity_id = ? AND year = ?`,
        ).run(
            input.zve,
            input.documentRef !== undefined ? input.documentRef : existing.document_ref,
            input.note !== undefined ? input.note : existing.note,
            at,
            input.entityId,
            input.year,
        );
    } else {
        db.prepare(
            `INSERT INTO tax_assessments (entity_id, year, zve, document_ref, note, recorded_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(input.entityId, input.year, input.zve, input.documentRef ?? null, input.note ?? null, at, at);
    }
    const saved = readRow(db, input.entityId, input.year);
    if (!saved) throw new Error('Tax assessment failed to persist');
    return rowToAssessment(saved);
}

/** One year's assessed figures for one entity, or null when nothing is recorded. */
export function getTaxAssessment(db: LedgerDatabase, entityId: string, year: number): TaxAssessment | null {
    const row = readRow(db, entityId, year);
    return row ? rowToAssessment(row) : null;
}

/** Every recorded year, newest first; optionally scoped to one entity. */
export function listTaxAssessments(db: LedgerDatabase, opts: { entityId?: string } = {}): TaxAssessment[] {
    const where = opts.entityId ? 'WHERE entity_id = ?' : '';
    const params = opts.entityId ? [opts.entityId] : [];
    const rows = db
        .prepare(`SELECT * FROM tax_assessments ${where} ORDER BY year DESC, entity_id`)
        .all(...params) as unknown as TaxAssessmentRow[];
    return rows.map(rowToAssessment);
}

/** Remove one year's assessed figures. Returns true if a row was removed. */
export function removeTaxAssessment(db: LedgerDatabase, entityId: string, year: number): boolean {
    if (!readRow(db, entityId, year)) return false;
    db.prepare(`DELETE FROM tax_assessments WHERE entity_id = ? AND year = ?`).run(entityId, year);
    return true;
}
