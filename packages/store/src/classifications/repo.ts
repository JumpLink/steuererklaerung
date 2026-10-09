/**
 * Per-transaction classification decisions on the SQLite `classifications` table (schema v6) +
 * the append-only decision log on `audit_log`.
 *
 * Pure data layer: every mutation takes an `at` ISO timestamp from the caller (like periods.ts /
 * filings.ts / contacts.ts) so it stays testable. {@link setClassification} is an UPSERT keyed by
 * `transaction_id` — a partial patch preserves the other fields; pass `null` to clear one — and it
 * appends an `audit_log` row (`classification.set`) inside the SAME transaction so the decision log
 * is durable + append-only. FK-free: the transaction need not exist in the SQLite `transactions`
 * mirror (the NDJSON store is the source of truth), and any SKR03 category is bookable.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type { ClassificationInput, ClassificationRecord, DecisionLogEntry } from "./types.ts";

interface ClassificationRow {
  transaction_id: string;
  category: string | null;
  net: number | null;
  vat: number | null;
  status: string;
  source: string | null;
  document_id: number | null;
  note: string | null;
  ai_note: string | null;
  ai_note_accepted: number | null;
  decided_at: string | null;
  decided_by: string | null;
}

function rowToRecord(row: ClassificationRow): ClassificationRecord {
  return {
    transactionId: row.transaction_id,
    category: row.category,
    net: row.net,
    vat: row.vat,
    status: (row.status as ClassificationRecord["status"]) ?? "open",
    source: row.source,
    documentId: row.document_id,
    note: row.note,
    aiNote: row.ai_note,
    aiNoteAccepted: row.ai_note_accepted == null ? null : row.ai_note_accepted !== 0,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

/** The persisted decision for one transaction, or null if none recorded yet. */
export function getClassification(
  db: LedgerDatabase,
  transactionId: string,
): ClassificationRecord | null {
  const row = db
    .prepare(`SELECT * FROM classifications WHERE transaction_id = ?`)
    .get(transactionId) as unknown as ClassificationRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * The decisions for the given transaction ids (or ALL decisions when omitted), keyed by
 * transaction id. Only rows that exist are returned, so a fresh/empty table yields an empty Map.
 */
export function getClassifications(
  db: LedgerDatabase,
  transactionIds?: string[],
): Map<string, ClassificationRecord> {
  const out = new Map<string, ClassificationRecord>();
  if (transactionIds && transactionIds.length === 0) return out;
  let rows: ClassificationRow[];
  if (transactionIds) {
    const placeholders = transactionIds.map(() => "?").join(", ");
    rows = db
      .prepare(`SELECT * FROM classifications WHERE transaction_id IN (${placeholders})`)
      .all(...transactionIds) as unknown as ClassificationRow[];
  } else {
    rows = db.prepare(`SELECT * FROM classifications`).all() as unknown as ClassificationRow[];
  }
  for (const row of rows) out.set(row.transaction_id, rowToRecord(row));
  return out;
}

/**
 * Manual overrides ONLY — the subset the EÜR aggregate honours: `source='manual'` rows that carry a
 * category. Optionally scoped to a set of transaction ids (the year's bookings). Keyed by tx id.
 */
export function getManualOverrides(
  db: LedgerDatabase,
  transactionIds?: string[],
): Map<string, ClassificationRecord> {
  const out = new Map<string, ClassificationRecord>();
  if (transactionIds && transactionIds.length === 0) return out;
  let rows: ClassificationRow[];
  if (transactionIds) {
    const placeholders = transactionIds.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT * FROM classifications
                 WHERE source = 'manual' AND category IS NOT NULL AND transaction_id IN (${placeholders})`,
      )
      .all(...transactionIds) as unknown as ClassificationRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM classifications WHERE source = 'manual' AND category IS NOT NULL`)
      .all() as unknown as ClassificationRow[];
  }
  for (const row of rows) out.set(row.transaction_id, rowToRecord(row));
  return out;
}

/** Append one row to the append-only decision log (`audit_log`). Detail is JSON-encoded. */
function appendDecisionLog(
  db: LedgerDatabase,
  action: string,
  transactionId: string,
  detail: Record<string, unknown>,
  at: string,
): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
    at,
    action,
    // transactionId is stored first so the log can be scoped to a tx (see getDecisionLog).
    JSON.stringify({ transactionId, ...detail }),
  );
}

/**
 * Insert or merge-update the decision for one transaction, and append a `classification.set` row to
 * the decision log — both inside ONE db transaction. Merge semantics: an omitted input field keeps
 * the existing value; pass `null` to clear it. `decided_at` is always set to `at`. Returns the saved
 * record.
 */
export function setClassification(
  db: LedgerDatabase,
  transactionId: string,
  input: ClassificationInput,
  at: string,
): ClassificationRecord {
  const existing = getClassification(db, transactionId);
  const pick = <T>(next: T | undefined, prev: T): T => (next !== undefined ? next : prev);
  const aiAcceptedNext =
    input.aiNoteAccepted !== undefined
      ? input.aiNoteAccepted === null
        ? null
        : input.aiNoteAccepted
          ? 1
          : 0
      : existing?.aiNoteAccepted == null
        ? null
        : existing.aiNoteAccepted
          ? 1
          : 0;

  const merged = {
    category: pick(input.category, existing?.category ?? null),
    net: pick(input.net, existing?.net ?? null),
    vat: pick(input.vat, existing?.vat ?? null),
    status: pick(input.status, existing?.status ?? "open"),
    source: pick(input.source, existing?.source ?? null),
    documentId: pick(input.documentId, existing?.documentId ?? null),
    note: pick(input.note, existing?.note ?? null),
    aiNote: pick(input.aiNote, existing?.aiNote ?? null),
    aiNoteAccepted: aiAcceptedNext,
    decidedBy: pick(input.decidedBy, existing?.decidedBy ?? null),
  };

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO classifications
               (transaction_id, category, net, vat, status, source, document_id, note, ai_note, ai_note_accepted, decided_at, decided_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(transaction_id) DO UPDATE SET
               category = excluded.category, net = excluded.net, vat = excluded.vat,
               status = excluded.status, source = excluded.source, document_id = excluded.document_id,
               note = excluded.note, ai_note = excluded.ai_note, ai_note_accepted = excluded.ai_note_accepted,
               decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    ).run(
      transactionId,
      merged.category,
      merged.net,
      merged.vat,
      merged.status,
      merged.source,
      merged.documentId,
      merged.note,
      merged.aiNote,
      merged.aiNoteAccepted,
      at,
      merged.decidedBy,
    );
    appendDecisionLog(
      db,
      "classification.set",
      transactionId,
      {
        category: merged.category,
        status: merged.status,
        source: merged.source,
        note: merged.note,
        decidedBy: merged.decidedBy,
        aiNoteAccepted: merged.aiNoteAccepted == null ? null : merged.aiNoteAccepted !== 0,
        previousCategory: existing?.category ?? null,
      },
      at,
    );
  });

  const saved = getClassification(db, transactionId);
  if (!saved) throw new Error("Classification upsert failed to persist");
  return saved;
}

/** Delete the decision for one transaction (+ append `classification.remove`). True if a row went. */
export function removeClassification(
  db: LedgerDatabase,
  transactionId: string,
  at: string,
): boolean {
  const existing = getClassification(db, transactionId);
  if (!existing) return false;
  withTransaction(db, () => {
    db.prepare(`DELETE FROM classifications WHERE transaction_id = ?`).run(transactionId);
    appendDecisionLog(
      db,
      "classification.remove",
      transactionId,
      { previousCategory: existing.category, previousSource: existing.source },
      at,
    );
  });
  return true;
}

interface AuditRow {
  id: number;
  at: string;
  action: string;
  detail: string | null;
}

/**
 * The append-only decision log for ONE transaction, oldest → newest. Reads the `classification.*`
 * `erstattung.*`, `aufteilung.*` and `projekt.*` rows of `audit_log` and filters by the `transactionId` embedded in each row's detail JSON (the
 * table has no tx column, and a `LIKE` filter is unsafe for ids containing `_`). Small table —
 * decisions only — so reading the classification rows and filtering in JS is fine + robust.
 */
export function getDecisionLog(db: LedgerDatabase, transactionId: string): DecisionLogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, at, action, detail FROM audit_log
       WHERE action LIKE 'classification.%' OR action LIKE 'erstattung.%' OR action LIKE 'aufteilung.%'
         OR action LIKE 'projekt.%'
       ORDER BY id ASC`,
    )
    .all() as unknown as AuditRow[];
  const out: DecisionLogEntry[] = [];
  for (const row of rows) {
    let detail: unknown = null;
    let txId: string | null = null;
    if (row.detail) {
      try {
        detail = JSON.parse(row.detail);
        if (detail && typeof detail === "object" && "transactionId" in detail) {
          txId = (detail as { transactionId?: unknown }).transactionId as string | null;
        }
      } catch {
        detail = row.detail;
      }
    }
    if (txId !== transactionId) continue;
    out.push({ id: row.id, at: row.at, action: row.action, transactionId: txId, detail });
  }
  return out;
}
