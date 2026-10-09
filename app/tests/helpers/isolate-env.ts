import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point the NDJSON store and the ledger DB at a throwaway directory for the WHOLE test run.
 *
 * Imported first by `tests/test.mts`. A test that sends mail, logs an invoice or writes a contact
 * goes through `ledgerDbPath()`, which without an override resolves to the user's real
 * `transactions-data/ledger.db` — a missing per-test override once left a fixture invoice
 * (`inv-1`, `RE/0001`) in the real ledger. Individual tests still set their own directory and
 * restore THIS one afterwards, never the real path.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'steuer-test-'));

process.env.TRANSACTIONS_DATA_DIR = join(sandbox, 'transactions-data');
process.env.LEDGER_DB_PATH = join(sandbox, 'ledger.db');

export const TEST_SANDBOX = sandbox;
