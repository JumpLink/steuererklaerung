import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertAccount, type UnifiedTransaction } from '@steuererklaerung/store';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import { createPresenterSession } from '../../../src/core/presenters/session.ts';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'x',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2025-06-01',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

// A single builtin-DMS entity — `documents()` then resolves offline (local SQLite). `aggregate()`
// rejects offline: with positive invoice document_type_ids configured (below) euer attempts a Paperless
// `listDocuments`, which throws "PAPERLESS_BASE_URL not set". Both are the deterministic build
// behaviours the memoization tests below rely on.
// v1 manifest with an inline `paperless` section. Positive invoice type ids so euer's Paperless invoice
// fetch is actually attempted (and, with no PAPERLESS_BASE_URL, throws) — otherwise the lenient default
// of 0 skips the fetch and aggregate resolves.
const MANIFEST = JSON.stringify({
    version: 1,
    entities: [{ id: 'test', name: 'Test GbR', kind: 'gbr', accounts: ['camt:test'] }],
    paperless: { document_type_ids: { incoming_invoice: 7, outgoing_invoice: 8 } },
});

export default async () => {
    await describe('presenters/session', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};

        beforeEach(async () => {
            prev = {
                TRANSACTIONS_DATA_DIR: process.env.TRANSACTIONS_DATA_DIR,
                LEDGER_DB_PATH: process.env.LEDGER_DB_PATH,
                STEUER_WORKSPACE: process.env.STEUER_WORKSPACE,
                PAPERLESS_BASE_URL: process.env.PAPERLESS_BASE_URL,
            };
            dir = mkdtempSync(join(tmpdir(), 'bh-session-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(manifest, MANIFEST);
            process.env.STEUER_WORKSPACE = manifest;
            // No Paperless → aggregate() rejects deterministically (offline).
            delete process.env.PAPERLESS_BASE_URL;

            upsertAccount('camt:test', [
                tx({ id: 'a', bookingDate: '2024-06-01' }),
                tx({ id: 'b', bookingDate: '2025-06-01' }),
            ]);
            // Create + migrate the ledger DB so the built-in DMS list() resolves (empty is fine).
            await new BuiltinDmsProvider('test').store({
                bytes: Buffer.from('%PDF-1.4 seed'),
                filename: 'seed.pdf',
                mimeType: 'application/pdf',
                created: '2025-06-15',
            });
        });

        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });

        await it('documents(): one build per entity-year (memoized), survives resolution', async () => {
            const s = createPresenterSession();
            const p1 = s.documents('test', 2025);
            const p2 = s.documents('test', 2025);
            expect(p1).toBe(p2); // same in-flight promise → built once
            const model = await p1;
            expect(model.dmsKind).toBe('builtin');
            // The seeded doc lands in 2025 → the list is non-empty (proves a real build ran).
            expect(model.docs.length).toBe(1);
            expect(s.documents('test', 2025)).toBe(p1); // still cached after it resolved
        });

        await it('aggregate(): one build per entity-year (memoized in-flight)', async () => {
            const s = createPresenterSession();
            const a1 = s.aggregate('test', 2025);
            const a2 = s.aggregate('test', 2025);
            expect(a1).toBe(a2); // one build, shared
            await a1.catch(() => {}); // (rejects offline — swallow)
        });

        await it('invalidate(entity, year) drops only that year; invalidate(entity) + global drop more', async () => {
            const s = createPresenterSession();
            const y24 = s.documents('test', 2024);
            const y25 = s.documents('test', 2025);
            await Promise.all([y24, y25]);

            // Scoped to one year: 2025 rebuilds, 2024 is untouched.
            s.invalidate('test', 2025);
            expect(s.documents('test', 2025)).not.toBe(y25);
            expect(s.documents('test', 2024)).toBe(y24);

            // Whole entity: both years rebuild.
            const y25b = s.documents('test', 2025);
            await y25b;
            s.invalidate('test');
            expect(s.documents('test', 2024)).not.toBe(y24);
            expect(s.documents('test', 2025)).not.toBe(y25b);

            // Global: everything rebuilds.
            const y24c = s.documents('test', 2024);
            await y24c;
            s.invalidate();
            expect(s.documents('test', 2024)).not.toBe(y24c);
        });

        await it('a rejected build is not cached — the next call rebuilds', async () => {
            const s = createPresenterSession();
            const a1 = s.aggregate('test', 2025);
            let threw = false;
            try {
                await a1;
            } catch {
                threw = true;
            }
            expect(threw).toBe(true); // offline → the Paperless fetch throws
            const a2 = s.aggregate('test', 2025);
            expect(a2).not.toBe(a1); // rejection evicted → a fresh build
            await a2.catch(() => {});
        });
    });
};
