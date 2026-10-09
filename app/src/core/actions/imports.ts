/**
 * Import batches: seeing what an import brought in, and taking it back.
 *
 * Until now a file import was irreversible. Pick the wrong CAMT export, or run the same PayPal CSV
 * twice against an account whose ids differ per download, and the only correction was deleting
 * NDJSON files in a file manager — which also takes out everything else in them. That was tolerable
 * while imports meant typing a CLI command; it stops being tolerable the moment there is a button.
 *
 * The store stamps every transaction an import ADDS with the batch id and can drop exactly those
 * again. This module is the layer above it: the two things the store must not do itself, because
 * both need the SQLite ledger.
 *
 *   - The **GoBD guard**. Books that are festgeschrieben stay. A batch reaching into a locked year
 *     is refused as a whole rather than partly undone — a half-reverted import is a worse state
 *     than the one the user wanted to leave.
 *   - The **ledger cleanup**. `transactions` and `classifications` there are derived from the
 *     store, so rows whose source is gone must go with them; otherwise the EÜR keeps counting a
 *     booking the user just removed.
 */

import {
    entityForAccountKey,
    getPeriodStatus,
    ledgerDbExists,
    ledgerDbPath,
    listImportBatches,
    loadAll,
    migrate,
    openLedger,
    undoImport as storeUndoImport,
    undoImportStatements,
    type ImportBatchSummary,
} from '@steuererklaerung/store';

export type { ImportBatchSummary };

/** Every import still represented in the store, newest first. */
export function listImports(): ImportBatchSummary[] {
    return listImportBatches();
}

/**
 * A readable, sortable batch id: `import-<ISO timestamp>-<source name>`.
 *
 * The timestamp leads so a plain string sort is newest-last, and the file name is carried along
 * because "welchen Import will ich zurücknehmen?" is a question a user answers by recognising the
 * file, not by reading a hash.
 */
export function newImportBatchId(filename: string, now: Date = new Date()): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    return `import-${stamp}-${safe}`;
}

/** The years an import touched, per ledger entity — what the GoBD check needs to look at. */
function lockedYearsIn(batchId: string): Array<{ entityId: string; year: number }> {
    if (!ledgerDbExists()) return [];
    const affected = new Map<string, Set<number>>();
    for (const t of loadAll()) {
        if (t.importBatch !== batchId) continue;
        const entity = entityForAccountKey(t.accountKey);
        const year = Number(t.bookingDate.slice(0, 4));
        if (!entity || !Number.isFinite(year)) continue;
        if (!affected.has(entity)) affected.set(entity, new Set());
        affected.get(entity)?.add(year);
    }
    if (affected.size === 0) return [];

    const locked: Array<{ entityId: string; year: number }> = [];
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        for (const [entityId, years] of affected) {
            for (const year of years) {
                if (getPeriodStatus(db, entityId, year) === 'locked') locked.push({ entityId, year });
            }
        }
    } finally {
        db.close();
    }
    return locked;
}

/** Delete the given unified transaction ids (and their classifications) from the ledger. */
function removeFromLedger(ids: string[]): number {
    if (ids.length === 0 || !ledgerDbExists()) return 0;
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        let removed = 0;
        // One statement per id rather than a giant IN-list: the list is user-sized (a bank export),
        // and a parameter list has a hard limit in SQLite that a big CAMT file would run into.
        const delClass = db.prepare('DELETE FROM classifications WHERE transaction_id = ?');
        const delTx = db.prepare('DELETE FROM transactions WHERE id = ?');
        db.exec('BEGIN');
        try {
            for (const id of ids) {
                delClass.run(id);
                removed += Number(delTx.run(id).changes ?? 0);
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        return removed;
    } finally {
        db.close();
    }
}

export interface UndoImportReport {
    batchId: string;
    /** Transactions removed from the NDJSON store. */
    removed: number;
    /** Rows removed from the SQLite ledger (may differ if it was never folded). */
    ledgerRemoved: number;
    accounts: string[];
}

/**
 * Take back one import: remove the transactions it added from the store and from the ledger.
 *
 * Refuses outright when any of them falls in a festgeschriebene period. Rows the import merely
 * UPDATED are kept — they existed before it and were never part of it.
 */
export function undoImportBatch(batchId: string): UndoImportReport {
    const known = listImportBatches().find((b) => b.id === batchId);
    if (!known) {
        const ids = listImportBatches().map((b) => b.id);
        throw new Error(
            `Import „${batchId}" ist im Speicher nicht (mehr) vorhanden. Bekannt: ${ids.join(', ') || '(keine)'}.`,
        );
    }

    const locked = lockedYearsIn(batchId);
    if (locked.length > 0) {
        const list = locked.map((l) => `${l.entityId} ${l.year}`).join(', ');
        throw new Error(
            `Import „${batchId}" enthält Buchungen in festgeschriebenen Perioden (${list}) — Zurücknehmen ist gesperrt (GoBD).`,
        );
    }

    // Store first: the ledger is derived from it, so a failure here must not leave the ledger
    // emptied while the source rows are still present.
    const result = storeUndoImport(batchId);
    undoImportStatements(batchId);
    const ledgerRemoved = removeFromLedger(result.ids);
    return { batchId, removed: result.ids.length, ledgerRemoved, accounts: result.accounts };
}
