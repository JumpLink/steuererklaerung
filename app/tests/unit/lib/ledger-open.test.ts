/**
 * What `openLedger` actually turns on — the pragmas, asserted by reading them back.
 *
 * `busy_timeout` is the load-bearing one and it was missing. WAL lets readers and one writer run
 * concurrently, but two WRITERS still serialise, and without a busy timeout SQLite does not wait at
 * all — the second writer gets SQLITE_BUSY immediately. This ledger genuinely has several processes
 * on it: `.mcp.json` keeps an MCP server resident on the same `ledger.db` while the CLI, the web UI
 * and the native app all write to it.
 *
 * Read the values BACK rather than trusting the exec: a mistyped pragma name is not an error in
 * SQLite, it is silently ignored — the exact shape of "green and yet nothing was configured".
 */
import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLedger } from '@steuererklaerung/store';

/** Read a single-value pragma back out of the database. */
function pragma(db: ReturnType<typeof openLedger>, name: string): unknown {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
}

export default async () => {
    await describe('openLedger pragmas', async () => {
        await it('sets a non-zero busy_timeout so a competing writer waits instead of failing', async () => {
            const db = openLedger(':memory:');
            try {
                expect(Number(pragma(db, 'busy_timeout'))).toBe(5000);
            } finally {
                db.close();
            }
        });

        await it('enforces foreign keys', async () => {
            const db = openLedger(':memory:');
            try {
                expect(Number(pragma(db, 'foreign_keys'))).toBe(1);
            } finally {
                db.close();
            }
        });

        await it('uses WAL on a real file (in-memory cannot, which is why this needs a temp dir)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-ledger-'));
            const db = openLedger(join(dir, 'ledger.db'));
            try {
                expect(String(pragma(db, 'journal_mode')).toLowerCase()).toBe('wal');
                // The timeout must survive on the file path too — that is the one that matters,
                // since the multi-process contention only exists for a real database.
                expect(Number(pragma(db, 'busy_timeout'))).toBe(5000);
            } finally {
                db.close();
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
};
