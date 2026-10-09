/**
 * Erstattungen on the SQLite `refund_links` table (schema v19) + the append-only decision log.
 *
 * Pure data layer like classifications/repo.ts: every mutation takes the caller's `at` timestamp and
 * appends an `audit_log` row (`erstattung.*`) inside the same db transaction, so linking, rejecting
 * and undoing a refund leave the same durable trail as an Umbuchung.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type { RefundLinkInput, RefundLinkRecord, RefundLinkStatus } from "./types.ts";

interface RefundLinkRow {
  refund_tx_id: string;
  original_tx_id: string;
  status: string;
  category: string | null;
  vat_rate: number | null;
  original_document_id: number | null;
  decided_at: string;
  decided_by: string | null;
}

function rowToRecord(row: RefundLinkRow): RefundLinkRecord {
  return {
    refundTxId: row.refund_tx_id,
    originalTxId: row.original_tx_id,
    status: row.status as RefundLinkStatus,
    category: row.category,
    vatRate: row.vat_rate,
    originalDocumentId: row.original_document_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function log(db: LedgerDatabase, action: string, refundTxId: string, detail: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
    at,
    action,
    JSON.stringify({ transactionId: refundTxId, ...detail }),
  );
}

/** Every link and rejection, or those touching the given transaction ids (as refund OR original). */
export function getRefundLinks(db: LedgerDatabase, transactionIds?: readonly string[]): RefundLinkRecord[] {
  if (transactionIds && transactionIds.length === 0) return [];
  let rows: RefundLinkRow[];
  if (transactionIds) {
    const ph = transactionIds.map(() => "?").join(", ");
    rows = db
      .prepare(`SELECT * FROM refund_links WHERE refund_tx_id IN (${ph}) OR original_tx_id IN (${ph})`)
      .all(...transactionIds, ...transactionIds) as unknown as RefundLinkRow[];
  } else {
    rows = db.prepare(`SELECT * FROM refund_links`).all() as unknown as RefundLinkRow[];
  }
  return rows.map(rowToRecord);
}

/**
 * „Ja": link the refund to `originalTxId`. A refund belongs to one debit, so an earlier link of the
 * same refund to another debit is replaced; a rejection of this very pair is overwritten.
 */
export function linkRefund(db: LedgerDatabase, input: RefundLinkInput, at: string): RefundLinkRecord {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM refund_links WHERE refund_tx_id = ? AND status = 'linked'`).run(input.refundTxId);
    db.prepare(
      `INSERT INTO refund_links
         (refund_tx_id, original_tx_id, status, category, vat_rate, original_document_id, decided_at, decided_by)
       VALUES (?, ?, 'linked', ?, ?, ?, ?, ?)
       ON CONFLICT(refund_tx_id, original_tx_id) DO UPDATE SET
         status = 'linked', category = excluded.category, vat_rate = excluded.vat_rate,
         original_document_id = excluded.original_document_id, decided_at = excluded.decided_at,
         decided_by = excluded.decided_by`,
    ).run(
      input.refundTxId,
      input.originalTxId,
      input.category,
      input.vatRate,
      input.originalDocumentId ?? null,
      at,
      input.decidedBy ?? null,
    );
    log(
      db,
      "erstattung.link",
      input.refundTxId,
      { originalTxId: input.originalTxId, category: input.category, vatRate: input.vatRate, decidedBy: input.decidedBy ?? null },
      at,
    );
  });
  const saved = getRefundLinks(db, [input.refundTxId]).find(
    (r) => r.refundTxId === input.refundTxId && r.originalTxId === input.originalTxId,
  );
  if (!saved) throw new Error("Refund link failed to persist");
  return saved;
}

/** „Nein" for one candidate: it is not offered for this refund again. A link of the pair is dropped. */
export function rejectRefundCandidate(
  db: LedgerDatabase,
  refundTxId: string,
  originalTxId: string,
  at: string,
  decidedBy?: string | null,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO refund_links (refund_tx_id, original_tx_id, status, decided_at, decided_by)
       VALUES (?, ?, 'rejected', ?, ?)
       ON CONFLICT(refund_tx_id, original_tx_id) DO UPDATE SET
         status = 'rejected', category = NULL, vat_rate = NULL, original_document_id = NULL,
         decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    ).run(refundTxId, originalTxId, at, decidedBy ?? null);
    log(db, "erstattung.reject", refundTxId, { originalTxId, decidedBy: decidedBy ?? null }, at);
  });
}

/** Undo „Ja": remove the refund's link (rejections stay). True if one was removed. */
export function removeRefundLink(db: LedgerDatabase, refundTxId: string, at: string): boolean {
  const existing = getRefundLinks(db, [refundTxId]).find((r) => r.refundTxId === refundTxId && r.status === "linked");
  if (!existing) return false;
  withTransaction(db, () => {
    db.prepare(`DELETE FROM refund_links WHERE refund_tx_id = ? AND status = 'linked'`).run(refundTxId);
    log(db, "erstattung.remove", refundTxId, { originalTxId: existing.originalTxId, category: existing.category }, at);
  });
  return true;
}
