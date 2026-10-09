/**
 * Taking back a wrong import.
 *
 * Until now a file import was irreversible: pick the wrong CAMT export, or run a PayPal CSV twice
 * against an account whose ids differ per download, and the only correction was deleting NDJSON
 * files in a file manager — which takes out everything else in them too. That was survivable while
 * importing meant typing a CLI command. It stops being survivable the moment there is a button.
 *
 * The load-bearing rule, and the one that is easy to get wrong: an import stamps only what it
 * genuinely ADDS. A row it merely UPDATED existed beforehand, so undoing the newer import must
 * leave it alone — otherwise the undo destroys data nobody asked to remove. Several tests below
 * exist purely to pin that.
 */
import { afterEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    listImportBatches,
    loadAll,
    undoImport,
    upsertAccount,
    withImportBatch,
    type UnifiedTransaction,
} from '@steuererklaerung/store';

import { newImportBatchId } from '../../../src/core/actions/imports.ts';

const tx = (id: string, over: Partial<UnifiedTransaction> = {}): UnifiedTransaction => ({
    id,
    source: 'camt',
    accountKey: 'camt:TESTBANK',
    bookingDate: '2025-03-01',
    amount: -12.34,
    currency: 'EUR',
    ...over,
});

export default async () => {
    const dirs: string[] = [];
    let savedDir: string | undefined;

    function freshStore(): void {
        savedDir ??= process.env.TRANSACTIONS_DATA_DIR;
        const dir = mkdtempSync(join(tmpdir(), 'bh-import-'));
        dirs.push(dir);
        process.env.TRANSACTIONS_DATA_DIR = dir;
    }

    afterEach(() => {
        if (savedDir === undefined) delete process.env.TRANSACTIONS_DATA_DIR;
        else process.env.TRANSACTIONS_DATA_DIR = savedDir;
        savedDir = undefined;
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    await describe('newImportBatchId', async () => {
        await it('leads with the timestamp so plain string sorting is chronological', async () => {
            const a = newImportBatchId('a.xml', new Date('2025-03-01T10:00:00Z'));
            const b = newImportBatchId('b.xml', new Date('2025-04-01T10:00:00Z'));
            expect(a < b).toBe(true);
        });

        await it('carries the file name — that is how a user recognises their import', async () => {
            expect(newImportBatchId('kontoauszug-2025.xml').includes('kontoauszug-2025.xml')).toBe(true);
        });

        await it('sanitises a name that would be awkward in a path or an argument', async () => {
            const id = newImportBatchId('mein export/2025 «neu».xml');
            expect(/^[a-zA-Z0-9._-]+$/.test(id)).toBe(true);
        });
    });

    await describe('stamping', async () => {
        await it('stamps only what it adds, and leaves rows outside a batch unstamped', async () => {
            freshStore();
            upsertAccount('camt:TESTBANK', [tx('before')]);
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('new')]));

            const stored = new Map(loadAll().map((t) => [t.id, t]));
            expect(stored.get('before')?.importBatch).toBe(undefined);
            expect(stored.get('new')?.importBatch).toBe('batch-1');
        });

        await it('does NOT re-stamp a row an earlier import brought in', async () => {
            // The whole reason undo is safe: a re-import that only refreshes an existing booking
            // must not make it look like the newer import's property.
            freshStore();
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('shared')]));
            withImportBatch('batch-2', () => upsertAccount('camt:TESTBANK', [tx('shared', { amount: -99 })]));

            const stored = loadAll().find((t) => t.id === 'shared');
            expect(stored?.importBatch).toBe('batch-1');
            expect(stored?.amount).toBe(-99); // the update itself did happen
        });

        await it('restores the previous batch after the scope, even when the import throws', async () => {
            freshStore();
            let threw = false;
            try {
                withImportBatch('batch-broken', () => {
                    throw new Error('kaputte Datei');
                });
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);

            // A failed import must not leave later writes labelled as part of it.
            upsertAccount('camt:TESTBANK', [tx('after')]);
            expect(loadAll().find((t) => t.id === 'after')?.importBatch).toBe(undefined);
        });
    });

    await describe('listImportBatches', async () => {
        await it('summarises count, accounts and the date range', async () => {
            freshStore();
            withImportBatch('batch-1', () => {
                upsertAccount('camt:A', [tx('a1', { accountKey: 'camt:A', bookingDate: '2025-01-05' })]);
                upsertAccount('camt:B', [tx('b1', { accountKey: 'camt:B', bookingDate: '2025-07-09' })]);
            });

            const [batch] = listImportBatches();
            expect(batch.id).toBe('batch-1');
            expect(batch.count).toBe(2);
            expect(batch.accounts).toStrictEqual(['camt:A', 'camt:B']);
            expect(batch.firstDate).toBe('2025-01-05');
            expect(batch.lastDate).toBe('2025-07-09');
        });

        await it('ignores unstamped rows entirely', async () => {
            freshStore();
            upsertAccount('camt:TESTBANK', [tx('sync-1')]);
            expect(listImportBatches().length).toBe(0);
        });

        await it('lists newest first', async () => {
            freshStore();
            withImportBatch('import-2025-01', () => upsertAccount('camt:A', [tx('x', { accountKey: 'camt:A' })]));
            withImportBatch('import-2025-09', () => upsertAccount('camt:B', [tx('y', { accountKey: 'camt:B' })]));
            expect(listImportBatches().map((b) => b.id)).toStrictEqual(['import-2025-09', 'import-2025-01']);
        });
    });

    await describe('undoImport', async () => {
        await it('removes exactly the batch and nothing else', async () => {
            freshStore();
            upsertAccount('camt:TESTBANK', [tx('kept-unstamped')]);
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('a'), tx('b')]));
            withImportBatch('batch-2', () => upsertAccount('camt:TESTBANK', [tx('c')]));

            const result = undoImport('batch-1');

            expect(result.ids.sort()).toStrictEqual(['a', 'b']);
            expect(
                loadAll()
                    .map((t) => t.id)
                    .sort(),
            ).toStrictEqual(['c', 'kept-unstamped']);
        });

        await it('KEEPS a row the batch only updated', async () => {
            // The sharpest case. `shared` came in with batch-1 and was refreshed by batch-2;
            // undoing batch-2 must not take it, because batch-2 did not bring it in.
            freshStore();
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('shared')]));
            withImportBatch('batch-2', () =>
                upsertAccount('camt:TESTBANK', [tx('shared', { amount: -99 }), tx('own')]),
            );

            undoImport('batch-2');

            const ids = loadAll()
                .map((t) => t.id)
                .sort();
            expect(ids).toStrictEqual(['shared']);
        });

        await it('spans several accounts and reports which ones it touched', async () => {
            freshStore();
            withImportBatch('batch-1', () => {
                upsertAccount('camt:A', [tx('a1', { accountKey: 'camt:A' })]);
                upsertAccount('camt:B', [tx('b1', { accountKey: 'camt:B' })]);
            });

            const result = undoImport('batch-1');
            expect(result.accounts).toStrictEqual(['camt:A', 'camt:B']);
            expect(loadAll().length).toBe(0);
        });

        await it('is a no-op for an unknown batch', async () => {
            freshStore();
            upsertAccount('camt:TESTBANK', [tx('a')]);
            const result = undoImport('gibts-nicht');
            expect(result.ids.length).toBe(0);
            expect(loadAll().length).toBe(1);
        });

        await it('is idempotent — undoing twice removes nothing more', async () => {
            freshStore();
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('a')]));
            expect(undoImport('batch-1').ids.length).toBe(1);
            expect(undoImport('batch-1').ids.length).toBe(0);
        });

        await it('leaves the store readable afterwards, including an emptied account file', async () => {
            freshStore();
            withImportBatch('batch-1', () => upsertAccount('camt:TESTBANK', [tx('only')]));
            undoImport('batch-1');
            expect(loadAll()).toStrictEqual([]);
            // And a fresh write into the same account still works.
            upsertAccount('camt:TESTBANK', [tx('neu')]);
            expect(loadAll().map((t) => t.id)).toStrictEqual(['neu']);
        });
    });
};
