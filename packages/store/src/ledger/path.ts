import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getStoreDir } from '../transactions/store.ts';

/** Ledger DB path — next to the NDJSON store (`<store>/ledger.db`), overridable via LEDGER_DB_PATH. */
export function ledgerDbPath(): string {
    return process.env.LEDGER_DB_PATH ?? join(getStoreDir(), 'ledger.db');
}

/**
 * True if the ledger DB has been created yet — for read paths that must NOT create it (a plain
 * report on a fresh store).
 */
export function ledgerDbExists(): boolean {
    return existsSync(ledgerDbPath());
}
