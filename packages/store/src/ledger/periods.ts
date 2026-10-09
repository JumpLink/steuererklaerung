/**
 * Period locking (GoBD Festschreibung) on the ledger `periods` table.
 *
 * A locked period marks "the books for this entity/year are final" — the gate between
 * still-classifying transactions and generating filing XML. The `generate-xml` actions
 * read {@link getPeriodStatus} and warn when a period is still open. `at` (an ISO
 * timestamp) is passed in so this stays pure/testable; the action layer supplies it.
 */

import type { LedgerDatabase } from './db.ts';

export type PeriodStatus = 'open' | 'locked';

/** The lock status of an entity's year, or null if no period row exists yet. */
export function getPeriodStatus(db: LedgerDatabase, entityId: string, year: number): PeriodStatus | null {
    const row = db.prepare(`SELECT status FROM periods WHERE entity_id = ? AND year = ?`).get(entityId, year) as
        | { status: string }
        | undefined;
    return row ? (row.status as PeriodStatus) : null;
}

/** Mark an entity's year as locked (idempotent) and append an audit_log entry. */
export function lockPeriod(db: LedgerDatabase, entityId: string, year: number, at: string): void {
    db.prepare(
        `INSERT INTO periods(entity_id, year, status, locked_at) VALUES(?, ?, 'locked', ?)
         ON CONFLICT(entity_id, year) DO UPDATE SET status = 'locked', locked_at = excluded.locked_at`,
    ).run(entityId, year, at);
    db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
        at,
        'lock_period',
        JSON.stringify({ entity_id: entityId, year }),
    );
}

/** Reopen a locked period (rare; e.g. a correction before filing). Audited. */
export function unlockPeriod(db: LedgerDatabase, entityId: string, year: number, at: string): void {
    db.prepare(`UPDATE periods SET status = 'open', locked_at = NULL WHERE entity_id = ? AND year = ?`).run(
        entityId,
        year,
    );
    db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
        at,
        'unlock_period',
        JSON.stringify({ entity_id: entityId, year }),
    );
}
