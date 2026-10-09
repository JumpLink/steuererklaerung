/**
 * Rechnung ↔ Projekt on the SQLite `invoice_projects` table (schema v25) and the time entries a draft
 * reserves (`invoice_time_links`).
 *
 * Pure data layer like project-links/repo.ts: every mutation takes the caller's `at` timestamp and appends
 * an `audit_log` row (`rechnung_projekt.*`) in the same transaction. Whether the project or invoice exists
 * is the caller's job.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type { InvoiceProjectRecord } from "./types.ts";

interface InvoiceProjectRow {
  entity_id: string;
  invoice_id: string;
  project_id: string;
  decided_at: string;
  decided_by: string | null;
}

function rowToRecord(row: InvoiceProjectRow): InvoiceProjectRecord {
  return {
    entityId: row.entity_id,
    invoiceId: row.invoice_id,
    projectId: row.project_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function log(db: LedgerDatabase, action: string, detail: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(at, action, JSON.stringify(detail));
}

/** Every direct assignment of the entity, ordered by invoice id. */
export function getInvoiceProjects(db: LedgerDatabase, entityId: string): InvoiceProjectRecord[] {
  const rows = db
    .prepare(`SELECT * FROM invoice_projects WHERE entity_id = ? ORDER BY invoice_id`)
    .all(entityId) as unknown as InvoiceProjectRow[];
  return rows.map(rowToRecord);
}

/** The project of one invoice, or null when it has no direct assignment. */
export function getInvoiceProject(db: LedgerDatabase, entityId: string, invoiceId: string): string | null {
  const row = db
    .prepare(`SELECT project_id FROM invoice_projects WHERE entity_id = ? AND invoice_id = ?`)
    .get(entityId, invoiceId) as unknown as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/** What `setInvoiceProject` did, for the sentence a surface shows. */
export type InvoiceProjectChange = "assigned" | "unchanged";

/** Assign an invoice to a project. Writing the decision that is already stored changes nothing. */
export function setInvoiceProject(
  db: LedgerDatabase,
  entityId: string,
  invoiceId: string,
  projectId: string,
  at: string,
  decidedBy?: string | null,
): InvoiceProjectChange {
  const previous = getInvoiceProject(db, entityId, invoiceId);
  if (previous === projectId) return "unchanged";
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO invoice_projects (entity_id, invoice_id, project_id, decided_at, decided_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, invoice_id) DO UPDATE SET project_id = excluded.project_id,
         decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    ).run(entityId, invoiceId, projectId, at, decidedBy ?? null);
    log(
      db,
      "rechnung_projekt.assign",
      { entityId, invoiceId, projectId, previous: previous ?? undefined, decidedBy: decidedBy ?? null },
      at,
    );
  });
  return "assigned";
}

/** „Zuordnung aufheben": drop the direct assignment. True if there was one. */
export function clearInvoiceProject(
  db: LedgerDatabase,
  entityId: string,
  invoiceId: string,
  at: string,
  decidedBy?: string | null,
): boolean {
  const previous = getInvoiceProject(db, entityId, invoiceId);
  if (previous == null) return false;
  withTransaction(db, () => {
    db.prepare(`DELETE FROM invoice_projects WHERE entity_id = ? AND invoice_id = ?`).run(entityId, invoiceId);
    log(db, "rechnung_projekt.clear", { entityId, invoiceId, projectId: previous, decidedBy: decidedBy ?? null }, at);
  });
  return true;
}

/** The time entries a draft invoice reserves. */
export function getInvoiceTimeLinks(db: LedgerDatabase, entityId: string, invoiceId: string): string[] {
  const rows = db
    .prepare(`SELECT entry_id FROM invoice_time_links WHERE entity_id = ? AND invoice_id = ? ORDER BY entry_id`)
    .all(entityId, invoiceId) as unknown as { entry_id: string }[];
  return rows.map((r) => r.entry_id);
}

/** Entry ids reserved by any draft of the entity, mapped to the draft that holds them. */
export function getReservedTimeEntries(db: LedgerDatabase, entityId: string): Map<string, string> {
  const rows = db
    .prepare(`SELECT entry_id, invoice_id FROM invoice_time_links WHERE entity_id = ?`)
    .all(entityId) as unknown as { entry_id: string; invoice_id: string }[];
  return new Map(rows.map((r) => [r.entry_id, r.invoice_id]));
}

/** Replace the reservation of a draft with exactly these entries (an empty list clears it). */
export function setInvoiceTimeLinks(
  db: LedgerDatabase,
  entityId: string,
  invoiceId: string,
  entryIds: readonly string[],
): void {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM invoice_time_links WHERE entity_id = ? AND invoice_id = ?`).run(entityId, invoiceId);
    const ins = db.prepare(`INSERT OR IGNORE INTO invoice_time_links (entity_id, invoice_id, entry_id) VALUES (?, ?, ?)`);
    for (const id of new Set(entryIds)) ins.run(entityId, invoiceId, id);
  });
}

/** Drop a draft's reservation (draft deleted, or invoice finalized and its entries billed). */
export function clearInvoiceTimeLinks(db: LedgerDatabase, entityId: string, invoiceId: string): void {
  db.prepare(`DELETE FROM invoice_time_links WHERE entity_id = ? AND invoice_id = ?`).run(entityId, invoiceId);
}
