/**
 * Ledger actions — open/migrate the SQLite ledger, seed master data, and import
 * the RAW transactions from the NDJSON store. Classifications are intentionally
 * NOT written: the decision layer stays open until the bookkeeping is verified.
 *
 * The DB lives next to the NDJSON store (`<store>/ledger.db`, same .gitignore),
 * overridable via `LEDGER_DB_PATH`.
 */

import {
    loadAll,
    openLedger,
    migrate,
    entityForAccountKey,
    getPeriodStatus,
    lockPeriod,
    ledgerDbPath,
    type LedgerDatabase,
    type PeriodStatus,
    type LedgerStatus,
} from '@steuererklaerung/store';
import {
    importTransactions,
    ledgerStatus,
    seedChartOfAccounts,
    seedEntities,
    upsertAccounts,
} from '../lib/ledger/seed.ts';

// ledgerDbPath now lives in @steuererklaerung/store; re-exported so callers importing it from here keep working.
export { ledgerDbPath };

/** Open + migrate + close around `fn`, returning its result. */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

export interface LedgerInitResult {
    dbPath: string;
    entities: number;
    chartOfAccounts: number;
}

/** Create the schema and seed master data (entities + chart of accounts). */
export async function ledgerInit(): Promise<LedgerInitResult> {
    return withLedger((db) => {
        seedEntities(db);
        const chartOfAccounts = seedChartOfAccounts(db);
        return { dbPath: ledgerDbPath(), entities: 3, chartOfAccounts };
    });
}

export interface LedgerImportResult {
    dbPath: string;
    accounts: number;
    added: number;
    updated: number;
    total: number;
}

/** Seed master data, then import every RAW transaction from the NDJSON store. */
export async function ledgerImportFromStore(): Promise<LedgerImportResult> {
    const importedAt = new Date().toISOString();
    return withLedger((db) => {
        seedEntities(db);
        seedChartOfAccounts(db);
        const txs = loadAll();
        const accounts = upsertAccounts(db, txs);
        const { added, updated } = importTransactions(db, txs, importedAt);
        return { dbPath: ledgerDbPath(), accounts, added, updated, total: txs.length };
    });
}

/** Remove an account and all its rows (transactions + classifications) from the ledger. */
export async function ledgerRemoveAccount(accountKey: string): Promise<{ transactions: number }> {
    return withLedger((db) => {
        // GoBD: refuse if the account's entity has any festgeschriebene (locked) period.
        const entityId = entityForAccountKey(accountKey);
        if (
            entityId &&
            db.prepare(`SELECT 1 FROM periods WHERE entity_id = ? AND status = 'locked' LIMIT 1`).get(entityId)
        )
            throw new Error(
                `Konto "${accountKey}" gehört zur Entität "${entityId}" mit einer festgeschriebenen Periode — Löschen ist gesperrt (GoBD). Nutze stattdessen „Sync stoppen".`,
            );
        const n = Number(
            (
                db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_key = ?').get(accountKey) as
                    | { n: number }
                    | undefined
            )?.n ?? 0,
        );
        // classifications key by the unified transaction id (schema v6), which equals transactions.id.
        db.prepare(
            'DELETE FROM classifications WHERE transaction_id IN (SELECT id FROM transactions WHERE account_key = ?)',
        ).run(accountKey);
        db.prepare('DELETE FROM transactions WHERE account_key = ?').run(accountKey);
        db.prepare('DELETE FROM accounts WHERE account_key = ?').run(accountKey);
        db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(
            new Date().toISOString(),
            'remove_account',
            JSON.stringify({ accountKey, transactions: n }),
        );
        return { transactions: n };
    });
}

export async function ledgerStatusReport(): Promise<LedgerStatus> {
    return withLedger((db) => ledgerStatus(db, ledgerDbPath()));
}

export interface PeriodLockResult {
    dbPath: string;
    entityId: string;
    year: number;
    status: PeriodStatus;
}

/** Lock an entity's tax year (GoBD Festschreibung) — the books-are-final gate. */
export async function lockLedgerPeriod(entityId: string, year: number): Promise<PeriodLockResult> {
    const at = new Date().toISOString();
    return withLedger((db) => {
        seedEntities(db); // ensure the entity FK target exists before referencing it
        lockPeriod(db, entityId, year, at);
        return { dbPath: ledgerDbPath(), entityId, year, status: 'locked' };
    });
}

/** Read the lock status of an entity's tax year (null if no period row exists). */
export async function ledgerPeriodStatus(entityId: string, year: number): Promise<PeriodStatus | null> {
    return withLedger((db) => getPeriodStatus(db, entityId, year));
}
