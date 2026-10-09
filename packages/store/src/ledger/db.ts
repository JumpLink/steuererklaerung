/**
 * Open the SQLite ledger via the built-in `node:sqlite`. Under GJS this module
 * is supplied by gjsify's `@gjsify/sqlite`, so the same `DatabaseSync` code runs
 * on GJS and Node — no runtime abstraction.
 */

import { DatabaseSync } from 'node:sqlite';

export type LedgerDatabase = DatabaseSync;

/**
 * How long a writer waits for a competing one before giving up, in milliseconds.
 *
 * WAL lets readers and one writer run concurrently, but two WRITERS still serialise — and without
 * `busy_timeout` SQLite does not wait at all: the second one gets `SQLITE_BUSY` on the spot. This
 * ledger genuinely has several processes on it: `.mcp.json` keeps an MCP server resident on the
 * same `ledger.db` while the CLI, the web UI and the native app all write to it. Five seconds is
 * far longer than any write here takes and short enough that a real deadlock still surfaces.
 */
const BUSY_TIMEOUT_MS = 5_000;

export function openLedger(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL + FK enforcement; WAL is a no-op for in-memory DBs (tests).
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

/** Run `fn` inside a BEGIN/COMMIT, rolling back on throw. */
export function withTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
