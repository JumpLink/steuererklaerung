/**
 * Projektzuordnungen on the SQLite `booking_projects` table (schema v23) + the append-only decision log.
 *
 * Pure data layer like splits/repo.ts: every mutation takes the caller's `at` timestamp and appends an
 * `audit_log` row (`projekt.*`) inside the same db transaction. Whether the project exists, and whether the
 * booking is an expense, is the caller's job — the repo stores what it is given.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type { ProjectLinkRecord } from "./types.ts";

interface ProjectLinkRow {
  tx_id: string;
  part_no: number;
  project_id: string | null;
  decided_at: string;
  decided_by: string | null;
}

function rowToRecord(row: ProjectLinkRow): ProjectLinkRecord {
  return {
    txId: row.tx_id,
    partNo: row.part_no,
    projectId: row.project_id,
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

/** Every stored decision, or those of the given transaction ids — ordered by tx, then part number. */
export function getProjectLinks(db: LedgerDatabase, transactionIds?: readonly string[]): ProjectLinkRecord[] {
  if (transactionIds && transactionIds.length === 0) return [];
  let rows: ProjectLinkRow[];
  if (transactionIds) {
    const ph = transactionIds.map(() => "?").join(", ");
    rows = db
      .prepare(`SELECT * FROM booking_projects WHERE tx_id IN (${ph}) ORDER BY tx_id, part_no`)
      .all(...transactionIds) as unknown as ProjectLinkRow[];
  } else {
    rows = db.prepare(`SELECT * FROM booking_projects ORDER BY tx_id, part_no`).all() as unknown as ProjectLinkRow[];
  }
  return rows.map(rowToRecord);
}

/** What `setProjectLink` did, for the sentence a surface shows. */
export type ProjectLinkChange = "assigned" | "excluded" | "unchanged";

/**
 * Decide the project of one booking (or one part of it): a project id, or null for „kein Projekt".
 * Writing the decision that is already stored changes nothing and logs nothing.
 */
export function setProjectLink(
  db: LedgerDatabase,
  txId: string,
  partNo: number,
  projectId: string | null,
  at: string,
  decidedBy?: string | null,
): ProjectLinkChange {
  const before = db
    .prepare(`SELECT * FROM booking_projects WHERE tx_id = ? AND part_no = ?`)
    .get(txId, partNo) as unknown as ProjectLinkRow | undefined;
  if (before && before.project_id === projectId) return "unchanged";
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO booking_projects (tx_id, part_no, project_id, decided_at, decided_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tx_id, part_no) DO UPDATE SET project_id = excluded.project_id,
         decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    ).run(txId, partNo, projectId, at, decidedBy ?? null);
    log(
      db,
      projectId == null ? "projekt.exclude" : "projekt.assign",
      txId,
      { partNo, projectId, previous: before ? before.project_id : undefined, decidedBy: decidedBy ?? null },
      at,
    );
  });
  return projectId == null ? "excluded" : "assigned";
}

/** „Zuordnung zurücknehmen": drop the decision. True if there was one. */
export function clearProjectLink(
  db: LedgerDatabase,
  txId: string,
  partNo: number,
  at: string,
  decidedBy?: string | null,
): boolean {
  const before = db
    .prepare(`SELECT * FROM booking_projects WHERE tx_id = ? AND part_no = ?`)
    .get(txId, partNo) as unknown as ProjectLinkRow | undefined;
  if (!before) return false;
  withTransaction(db, () => {
    db.prepare(`DELETE FROM booking_projects WHERE tx_id = ? AND part_no = ?`).run(txId, partNo);
    log(db, "projekt.clear", txId, { partNo, projectId: before.project_id, decidedBy: decidedBy ?? null }, at);
  });
  return true;
}

/** Drop every decision of a booking — used when its split is dissolved and the parts' decisions go with it. */
export function clearPartLinks(db: LedgerDatabase, txId: string, at: string, decidedBy?: string | null): number {
  const parts = getProjectLinks(db, [txId]).filter((l) => l.partNo > 0);
  for (const p of parts) clearProjectLink(db, txId, p.partNo, at, decidedBy);
  return parts.length;
}
