/**
 * Mahnungen on the SQLite `invoice_reminders` table (schema v21): per outgoing invoice, which reminder
 * stage was drafted and which the owner confirmed as sent. One row per (entity, invoice, stage).
 *
 * `invoiceId` is the back-end id of the invoice (a Qonto client invoice has no row in `invoices`, so
 * there is no foreign key — same as the mail history). The app never sends a reminder: `sentAt` is the
 * date the owner says it went out, set only by {@link markReminderSent}. Every write appends an
 * `audit_log` row (`mahnung.*`), and the caller passes `at`, like the other repos.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";

export type ReminderStage = 1 | 2 | 3;

export interface InvoiceReminderRecord {
  entityId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  stage: ReminderStage;
  /** ISO timestamp of the last draft, or null when the stage was only ever marked sent. */
  draftedAt: string | null;
  /** YYYY-MM-DD the owner confirmed the reminder as sent; null = drafted only. */
  sentAt: string | null;
}

export interface InvoiceReminderKey {
  entityId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  stage: ReminderStage;
}

interface ReminderRow {
  entity_id: string;
  invoice_id: string;
  invoice_number: string | null;
  stage: number;
  drafted_at: string | null;
  sent_at: string | null;
}

function rowToRecord(row: ReminderRow): InvoiceReminderRecord {
  return {
    entityId: row.entity_id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    stage: row.stage as ReminderStage,
    draftedAt: row.drafted_at,
    sentAt: row.sent_at,
  };
}

function checkStage(stage: number): void {
  if (stage !== 1 && stage !== 2 && stage !== 3) throw new Error(`Mahnstufe ${stage} gibt es nicht (1–3).`);
}

function log(db: LedgerDatabase, action: string, key: InvoiceReminderKey, detail: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
    at,
    action,
    JSON.stringify({ invoiceId: key.invoiceId, stage: key.stage, ...detail }),
  );
}

/** Note that a draft of this stage was made. A stage already sent keeps its `sentAt`. */
export function recordReminderDraft(db: LedgerDatabase, key: InvoiceReminderKey, at: string): void {
  checkStage(key.stage);
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO invoice_reminders(entity_id, invoice_id, stage, invoice_number, drafted_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, invoice_id, stage) DO UPDATE SET drafted_at = excluded.drafted_at`,
    ).run(key.entityId, key.invoiceId, key.stage, key.invoiceNumber, at);
    log(db, "mahnung.draft", key, {}, at);
  });
}

/** The owner confirms the reminder of this stage went out on `sentOn` (YYYY-MM-DD). */
export function markReminderSent(db: LedgerDatabase, key: InvoiceReminderKey, sentOn: string, at: string): void {
  checkStage(key.stage);
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO invoice_reminders(entity_id, invoice_id, stage, invoice_number, sent_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, invoice_id, stage) DO UPDATE SET sent_at = excluded.sent_at`,
    ).run(key.entityId, key.invoiceId, key.stage, key.invoiceNumber, sentOn);
    log(db, "mahnung.sent", key, { sentOn }, at);
  });
}

/** Every reminder row of an entity, oldest stage first per invoice. */
export function listEntityReminders(db: LedgerDatabase, entityId: string): InvoiceReminderRecord[] {
  const rows = db
    .prepare(`SELECT * FROM invoice_reminders WHERE entity_id = ? ORDER BY invoice_id, stage`)
    .all(entityId) as unknown as ReminderRow[];
  return rows.map(rowToRecord);
}
