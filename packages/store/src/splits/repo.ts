/**
 * Splitbuchungen on the SQLite `booking_splits` table (schema v22) + the append-only decision log.
 *
 * Pure data layer like refunds/repo.ts: every mutation takes the caller's `at` timestamp and appends an
 * `audit_log` row (`aufteilung.*`) inside the same db transaction. Validation (one remainder part, the
 * parts fit the booking) is the caller's job — the repo stores what it is given.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type { SplitPartInput, SplitPartRecord } from "./types.ts";

interface SplitPartRow {
  tx_id: string;
  part_no: number;
  category: string;
  amount_cents: number | null;
  vat_rate: number;
  note: string | null;
  decided_at: string;
  decided_by: string | null;
}

function rowToRecord(row: SplitPartRow): SplitPartRecord {
  return {
    txId: row.tx_id,
    partNo: row.part_no,
    category: row.category,
    amountCents: row.amount_cents,
    vatRate: row.vat_rate,
    note: row.note,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function log(db: LedgerDatabase, action: string, txId: string, detail: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
    at,
    action,
    JSON.stringify({ transactionId: txId, ...detail }),
  );
}

/** Every stored part, or the parts of the given transaction ids — ordered by tx, then part number. */
export function getBookingSplits(db: LedgerDatabase, transactionIds?: readonly string[]): SplitPartRecord[] {
  if (transactionIds && transactionIds.length === 0) return [];
  let rows: SplitPartRow[];
  if (transactionIds) {
    const ph = transactionIds.map(() => "?").join(", ");
    rows = db
      .prepare(`SELECT * FROM booking_splits WHERE tx_id IN (${ph}) ORDER BY tx_id, part_no`)
      .all(...transactionIds) as unknown as SplitPartRow[];
  } else {
    rows = db.prepare(`SELECT * FROM booking_splits ORDER BY tx_id, part_no`).all() as unknown as SplitPartRow[];
  }
  return rows.map(rowToRecord);
}

/** Store the split of one booking, replacing an earlier one in full. */
export function saveBookingSplit(
  db: LedgerDatabase,
  txId: string,
  parts: readonly SplitPartInput[],
  at: string,
  decidedBy?: string | null,
): SplitPartRecord[] {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM booking_splits WHERE tx_id = ?`).run(txId);
    const insert = db.prepare(
      `INSERT INTO booking_splits (tx_id, part_no, category, amount_cents, vat_rate, note, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    parts.forEach((p, i) =>
      insert.run(txId, i + 1, p.category, p.amountCents, p.vatRate, p.note ?? null, at, decidedBy ?? null),
    );
    log(
      db,
      "aufteilung.save",
      txId,
      {
        parts: parts.map((p) => ({ category: p.category, amountCents: p.amountCents, vatRate: p.vatRate })),
        decidedBy: decidedBy ?? null,
      },
      at,
    );
  });
  return getBookingSplits(db, [txId]);
}

/** „Aufteilung aufheben": drop every part of the booking. True if there was a split. */
export function removeBookingSplit(db: LedgerDatabase, txId: string, at: string, decidedBy?: string | null): boolean {
  const existing = getBookingSplits(db, [txId]);
  if (existing.length === 0) return false;
  withTransaction(db, () => {
    db.prepare(`DELETE FROM booking_splits WHERE tx_id = ?`).run(txId);
    log(
      db,
      "aufteilung.remove",
      txId,
      { parts: existing.map((p) => ({ category: p.category, amountCents: p.amountCents })), decidedBy: decidedBy ?? null },
      at,
    );
  });
  return true;
}
