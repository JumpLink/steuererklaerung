/**
 * The cursor of the mail fetch (schema v24, `mail_eingang_state`): one row per workspace entity.
 *
 * A changed folder name counts as a new cursor — the UIDs of another folder mean nothing here — so
 * {@link getMailEingangState} returns null unless the stored folder is the one asked for.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import type { MailEingangState } from "./types.ts";

interface StateRow {
  entity_id: string;
  folder: string;
  uid_validity: number | null;
  last_uid: number;
  last_run_at: string | null;
  last_result: string | null;
}

function rowToState(row: StateRow): MailEingangState {
  return {
    entityId: row.entity_id,
    folder: row.folder,
    uidValidity: row.uid_validity,
    lastUid: row.last_uid,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
  };
}

/** The stored cursor of an entity, or null when there is none or it belongs to another folder. */
export function getMailEingangState(db: LedgerDatabase, entityId: string, folder: string): MailEingangState | null {
  const row = db.prepare(`SELECT * FROM mail_eingang_state WHERE entity_id = ?`).get(entityId) as unknown as
    | StateRow
    | undefined;
  return row && row.folder === folder ? rowToState(row) : null;
}

/** The last run of an entity whatever folder it used — what a status line shows. */
export function getMailEingangLastRun(
  db: LedgerDatabase,
  entityId: string,
): Pick<MailEingangState, "folder" | "lastRunAt" | "lastResult"> | null {
  const row = db.prepare(`SELECT * FROM mail_eingang_state WHERE entity_id = ?`).get(entityId) as unknown as
    | StateRow
    | undefined;
  return row ? { folder: row.folder, lastRunAt: row.last_run_at, lastResult: row.last_result } : null;
}

/** Store (replace) an entity's cursor. */
export function saveMailEingangState(db: LedgerDatabase, state: MailEingangState): void {
  db.prepare(
    `INSERT INTO mail_eingang_state (entity_id, folder, uid_validity, last_uid, last_run_at, last_result)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET folder = excluded.folder, uid_validity = excluded.uid_validity,
       last_uid = excluded.last_uid, last_run_at = excluded.last_run_at, last_result = excluded.last_result`,
  ).run(state.entityId, state.folder, state.uidValidity, state.lastUid, state.lastRunAt, state.lastResult);
}

/** Record the outcome of a run that moved nothing (an error, an empty folder) without touching the cursor. */
export function recordMailEingangRun(
  db: LedgerDatabase,
  entityId: string,
  folder: string,
  at: string,
  result: string,
): void {
  const existing = getMailEingangState(db, entityId, folder);
  saveMailEingangState(db, {
    entityId,
    folder,
    uidValidity: existing?.uidValidity ?? null,
    lastUid: existing?.lastUid ?? 0,
    lastRunAt: at,
    lastResult: result,
  });
}
