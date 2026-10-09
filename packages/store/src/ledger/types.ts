/**
 * SQLite ledger — shared types.
 *
 * The ledger is the future "system of record" for bookkeeping: immutable RAW
 * transactions + master data (entities, accounts, chart of accounts), with a
 * (currently EMPTY) decision layer (classifications / periods / audit_log) that
 * stays OPEN until the data is verified.
 *
 * Storage is the built-in `node:sqlite` (`DatabaseSync`) — under GJS this is
 * provided by gjsify's `@gjsify/sqlite`, so the SAME code runs on both; there is
 * no runtime abstraction.
 */

export interface LedgerAccountSummary {
  accountKey: string;
  entityId: string | null;
  count: number;
  from: string | null;
  to: string | null;
}

export interface LedgerStatus {
  dbPath: string;
  schemaVersion: number;
  entities: number;
  accounts: number;
  chartOfAccounts: number;
  transactions: number;
  /** Decision layer — stays 0 while classifications remain open/unpersisted. */
  classifications: number;
  byAccount: LedgerAccountSummary[];
}
