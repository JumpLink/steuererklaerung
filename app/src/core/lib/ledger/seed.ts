/**
 * Ledger data layer: seed master data (entities, accounts, chart of accounts)
 * and import RAW transactions idempotently. The chart of accounts is derived
 * from the EXISTING single sources of truth ({@link SKR03_TO_EUER},
 * {@link impliedRate}, {@link NO_RECEIPT_CATEGORIES}) so there is no second
 * copy to drift. No classifications are written — that layer stays open.
 *
 * Storage is `node:sqlite` (`DatabaseSync`) used directly; gjsify provides the
 * same module on GJS.
 */

import { SKR03_TO_EUER } from '../../elster/euer-aggregate.ts';
import { impliedRate } from '../../elster/euer-transactions.ts';
import { NO_RECEIPT_CATEGORIES } from '../select-field-constants.ts';
import {
  dedupeKey,
  entityForAccountKey,
  ENTITIES,
  withTransaction,
  schemaVersion,
  type UnifiedTransaction,
  type LedgerDatabase,
  type LedgerAccountSummary,
  type LedgerStatus,
} from '@steuererklaerung/store';

export function seedEntities(db: LedgerDatabase): void {
  const stmt = db.prepare(
    `INSERT INTO entities(id, name) VALUES(?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  );
  for (const e of ENTITIES) stmt.run(e.id, e.name);
}

/** Seed the chart of accounts from the existing SKR03→EÜR map (idempotent). */
export function seedChartOfAccounts(db: LedgerDatabase): number {
  const stmt = db.prepare(
    `INSERT INTO chart_of_accounts(code, kind, bucket, euer_kz, vat_rate, requires_receipt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       kind = excluded.kind, bucket = excluded.bucket, euer_kz = excluded.euer_kz,
       vat_rate = excluded.vat_rate, requires_receipt = excluded.requires_receipt`,
  );
  let n = 0;
  for (const [code, b] of Object.entries(SKR03_TO_EUER)) {
    const vat = impliedRate(code, b.kind);
    const requiresReceipt = NO_RECEIPT_CATEGORIES.includes(code) || b.kind === 'neutral' ? 0 : 1;
    stmt.run(code, b.kind, b.bucket, b.kz, vat, requiresReceipt);
    n += 1;
  }
  return n;
}

/** Upsert one accounts row per distinct accountKey seen in the transactions. */
export function upsertAccounts(db: LedgerDatabase, txs: UnifiedTransaction[]): number {
  const stmt = db.prepare(
    `INSERT INTO accounts(account_key, source, iban, entity_id) VALUES(?, ?, ?, ?)
     ON CONFLICT(account_key) DO UPDATE SET
       source = excluded.source,
       iban = COALESCE(excluded.iban, accounts.iban),
       entity_id = COALESCE(excluded.entity_id, accounts.entity_id)`,
  );
  const seen = new Set<string>();
  for (const t of txs) {
    if (seen.has(t.accountKey)) continue;
    seen.add(t.accountKey);
    stmt.run(t.accountKey, t.source, t.iban ?? null, entityForAccountKey(t.accountKey));
  }
  return seen.size;
}

/**
 * Import RAW transactions idempotently (upsert by dedupe_key). Re-running with
 * the same data changes nothing; updated rows reflect re-fetched bank data.
 * The full original record is kept in `raw_json` for audit.
 */
export function importTransactions(
  db: LedgerDatabase,
  txs: UnifiedTransaction[],
  importedAt: string,
): { added: number; updated: number } {
  const check = db.prepare('SELECT 1 AS x FROM transactions WHERE dedupe_key = ?');
  const insert = db.prepare(
    `INSERT INTO transactions(
       dedupe_key, id, source, account_key, booking_date, value_date, amount, currency,
       counterparty, counterparty_iban, purpose, reference, type, category, raw_json, imported_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       booking_date = excluded.booking_date, value_date = excluded.value_date,
       amount = excluded.amount, currency = excluded.currency,
       counterparty = excluded.counterparty, counterparty_iban = excluded.counterparty_iban,
       purpose = excluded.purpose, reference = excluded.reference, type = excluded.type,
       category = excluded.category, raw_json = excluded.raw_json`,
  );
  let added = 0;
  let updated = 0;
  withTransaction(db, () => {
    for (const t of txs) {
      const key = dedupeKey(t);
      const exists = check.get(key);
      insert.run(
        key, t.id, t.source, t.accountKey, t.bookingDate, t.valueDate ?? null, t.amount, t.currency,
        t.counterparty ?? null, t.counterpartyIban ?? null, t.purpose ?? null, t.reference ?? null,
        t.type ?? null, t.category ?? null, JSON.stringify(t), importedAt,
      );
      if (exists) updated += 1;
      else added += 1;
    }
    db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(
      importedAt,
      'import_transactions',
      JSON.stringify({ added, updated, total: txs.length }),
    );
  });
  return { added, updated };
}

export function ledgerStatus(db: LedgerDatabase, dbPath: string): LedgerStatus {
  const count = (sql: string) => Number(((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0));
  const byAccount = db
    .prepare(
      `SELECT t.account_key AS accountKey, a.entity_id AS entityId, COUNT(*) AS count,
              MIN(t.booking_date) AS "from", MAX(t.booking_date) AS "to"
       FROM transactions t
       LEFT JOIN accounts a ON a.account_key = t.account_key
       GROUP BY t.account_key ORDER BY t.account_key`,
    )
    .all() as unknown as LedgerAccountSummary[];
  return {
    dbPath,
    schemaVersion: schemaVersion(db),
    entities: count('SELECT COUNT(*) AS n FROM entities'),
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    chartOfAccounts: count('SELECT COUNT(*) AS n FROM chart_of_accounts'),
    transactions: count('SELECT COUNT(*) AS n FROM transactions'),
    classifications: count('SELECT COUNT(*) AS n FROM classifications'),
    byAccount,
  };
}
