/**
 * GoBD locked-period guard for link/unlink writes, DMS-agnostic.
 *
 * The builtin DMS provider refuses to alter a festgeschriebene (locked) period's receipt assignment,
 * but the Paperless provider has no ledger access — so the SHARED actions must enforce the lock for
 * every back-end. Resolves the transaction → ledger entity → year and throws the same German error
 * the builtin provider raises. Best-effort resolution: an unknown tx or a store without a ledger DB
 * passes (there is nothing to guard yet).
 */

import {
    entityForAccountKey,
    getPeriodStatus,
    ledgerDbExists,
    ledgerDbPath,
    migrate,
    openLedger,
    searchTransactions,
} from '@steuererklaerung/store';

/** Throw when the booking's year is GoBD-locked for its ledger entity. `verb` names the refused write. */
export function assertTxPeriodUnlocked(txId: string, verb: 'Verknüpfen' | 'Entknüpfen'): void {
    if (!ledgerDbExists()) return;
    const tx = searchTransactions({}).transactions.find((t) => t.id === txId);
    if (!tx) return;
    const ledgerEntity = entityForAccountKey(tx.accountKey);
    const year = Number(tx.bookingDate.slice(0, 4));
    if (!ledgerEntity || !Number.isFinite(year)) return;
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        if (getPeriodStatus(db, ledgerEntity, year) === 'locked')
            throw new Error(
                `Periode ${year} der Entität "${ledgerEntity}" ist festgeschrieben (GoBD) — ${verb} gesperrt.`,
            );
    } finally {
        db.close();
    }
}
