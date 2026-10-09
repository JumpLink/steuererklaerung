/**
 * Filing-document links on the SQLite `filing_documents` table (schema v11) — which DMS documents
 * (Bescheid, Mahnung, Übertragungsprotokoll, Zahlungsbeleg, …) belong to which filing-register
 * entry. Pure data layer like repo.ts: every mutation takes an `at` ISO timestamp from the caller.
 * Add is a MERGE keyed by (entity_id, kind, period, document_ref): re-attaching the same document
 * updates role/note instead of duplicating the row. FK-free by design — document_ref is a
 * DMS-agnostic string (`paperless:<id>` or a store documents.id), so the link survives an entity
 * switching its DMS backend; existence of the referenced filing is the ACTION layer's concern.
 */

import type { LedgerDatabase } from '../ledger/db.ts';
import type { FilingDocument, FilingDocumentInput } from './types.ts';

interface FilingDocumentRow {
    entity_id: string;
    kind: string;
    period: string;
    document_ref: string;
    role: string;
    note: string | null;
    created_at: string;
}

function rowToDocument(row: FilingDocumentRow): FilingDocument {
    return {
        entityId: row.entity_id,
        kind: row.kind,
        period: row.period,
        documentRef: row.document_ref,
        role: row.role,
        note: row.note,
        createdAt: row.created_at,
    };
}

/** Insert or merge-update a filing-document link. Returns the resulting row. */
export function addFilingDocument(db: LedgerDatabase, input: FilingDocumentInput, at: string): FilingDocument {
    const existing = db
        .prepare(`SELECT * FROM filing_documents WHERE entity_id = ? AND kind = ? AND period = ? AND document_ref = ?`)
        .get(input.entityId, input.kind, input.period, input.documentRef) as unknown as FilingDocumentRow | undefined;
    if (existing) {
        db.prepare(
            `UPDATE filing_documents SET role = ?, note = ?
             WHERE entity_id = ? AND kind = ? AND period = ? AND document_ref = ?`,
        ).run(
            input.role ?? existing.role,
            input.note !== undefined ? input.note : existing.note,
            input.entityId,
            input.kind,
            input.period,
            input.documentRef,
        );
    } else {
        db.prepare(
            `INSERT INTO filing_documents (entity_id, kind, period, document_ref, role, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            input.entityId,
            input.kind,
            input.period,
            input.documentRef,
            input.role ?? 'sonstiges',
            input.note ?? null,
            at,
        );
    }
    const saved = db
        .prepare(`SELECT * FROM filing_documents WHERE entity_id = ? AND kind = ? AND period = ? AND document_ref = ?`)
        .get(input.entityId, input.kind, input.period, input.documentRef) as unknown as FilingDocumentRow | undefined;
    if (!saved) throw new Error('Filing document link failed to persist');
    return rowToDocument(saved);
}

/**
 * List filing-document links, optionally scoped to an entity / kind / period / documentRef —
 * pass any combination; all given filters AND together. Ordered by filing key, then insertion.
 */
export function listFilingDocuments(
    db: LedgerDatabase,
    opts: { entityId?: string; kind?: string; period?: string; documentRef?: string } = {},
): FilingDocument[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.entityId) {
        clauses.push('entity_id = ?');
        params.push(opts.entityId);
    }
    if (opts.kind) {
        clauses.push('kind = ?');
        params.push(opts.kind);
    }
    if (opts.period) {
        clauses.push('period = ?');
        params.push(opts.period);
    }
    if (opts.documentRef) {
        clauses.push('document_ref = ?');
        params.push(opts.documentRef);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
        .prepare(`SELECT * FROM filing_documents ${where} ORDER BY period DESC, entity_id, kind, created_at`)
        .all(...params) as unknown as FilingDocumentRow[];
    return rows.map(rowToDocument);
}

/** Remove one filing-document link. Returns true if a row was removed. */
export function removeFilingDocument(
    db: LedgerDatabase,
    entityId: string,
    kind: string,
    period: string,
    documentRef: string,
): boolean {
    const existing = db
        .prepare(`SELECT 1 FROM filing_documents WHERE entity_id = ? AND kind = ? AND period = ? AND document_ref = ?`)
        .get(entityId, kind, period, documentRef);
    if (!existing) return false;
    db.prepare(`DELETE FROM filing_documents WHERE entity_id = ? AND kind = ? AND period = ? AND document_ref = ?`).run(
        entityId,
        kind,
        period,
        documentRef,
    );
    return true;
}
