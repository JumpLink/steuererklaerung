/**
 * Fortlaufende Rechnungsnummer (§14 UStG) allocation on the `invoice_sequences` table.
 *
 * The number is assigned only at finalize — drafts stay unnumbered, so deleting a draft never
 * leaves a gap. Allocation MUST run inside an open transaction (repo.finalizeInvoice provides
 * one) so the read-modify-write of last_seq is atomic; the partial UNIQUE index on
 * invoices(entity_id, number) is the backstop against any manual-number collision.
 */

import type { LedgerDatabase } from '../ledger/db.ts';

/** Default prefix when the entity's invoicing config sets none. */
export const DEFAULT_NUMBER_PREFIX = 'RE-';

/** Format a number from its parts, e.g. ("RE-", 2026, 7) → "RE-2026-0007". */
export function formatInvoiceNumber(prefix: string, year: number, seq: number): string {
    return `${prefix}${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Reserve and format the next number for (entity, prefix, year). Call ONLY inside an open
 * transaction. Increments last_seq (seeding the row on first use) and returns the formatted
 * number; storno invoices draw from the same sequence so their number is consecutive too.
 */
export function allocateInvoiceNumber(
    db: LedgerDatabase,
    entityId: string,
    prefix: string,
    year: number,
): string {
    db.prepare(
        `INSERT INTO invoice_sequences(entity_id, prefix, year, last_seq) VALUES(?, ?, ?, 0)
         ON CONFLICT(entity_id, prefix, year) DO NOTHING`,
    ).run(entityId, prefix, year);
    db.prepare(
        `UPDATE invoice_sequences SET last_seq = last_seq + 1 WHERE entity_id = ? AND prefix = ? AND year = ?`,
    ).run(entityId, prefix, year);
    const row = db
        .prepare(`SELECT last_seq FROM invoice_sequences WHERE entity_id = ? AND prefix = ? AND year = ?`)
        .get(entityId, prefix, year) as { last_seq: number } | undefined;
    if (!row) throw new Error('invoice sequence row vanished mid-transaction');
    return formatInvoiceNumber(prefix, year, row.last_seq);
}
