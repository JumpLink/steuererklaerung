import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    openLedger,
    migrate,
    schemaVersion,
    SCHEMA_VERSION,
    lockPeriod,
    upsertAccount,
    ledgerDbPath,
    type UnifiedTransaction,
} from '@steuererklaerung/store';
import { seedEntities } from '../../../src/core/lib/ledger/seed.ts';
import {
    BuiltinDmsProvider,
    parseExtraction,
    extractionToMeta,
    proposeTransactionLinks,
    excludeTaggedDocs,
} from '@steuererklaerung/dms';
import type { Document } from '@steuererklaerung/paperless';

export default async () => {
    await describe('dms', async () => {
        await describe('schema v2 migration', async () => {
            await it('creates the documents / document_links / document_ocr tables', async () => {
                const db = openLedger(':memory:');
                migrate(db);
                expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
                // DMS tables landed in v2; the live schema has since advanced (contacts v3, invoices v4).
                expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
                const names = (
                    db
                        .prepare(
                            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents','document_links','document_ocr')",
                        )
                        .all() as unknown as { name: string }[]
                ).map((r) => r.name);
                expect(names.includes('documents')).toBe(true);
                expect(names.includes('document_links')).toBe(true);
                expect(names.includes('document_ocr')).toBe(true);
                db.close();
            });
        });

        await describe('extract (pure helpers)', async () => {
            await it('parses the {metadata, fullText} JSON the model returns', async () => {
                const raw =
                    'Hier:\n{"metadata":{"invoiceNumber":"R-2025-9","date":"2025-03-04","correspondent":"ACME GmbH","net":100,"gross":119,"vat":19,"direction":"incoming"},"fullText":"Rechnung ACME ..."}';
                const ex = parseExtraction(raw);
                expect(ex.metadata.invoiceNumber).toBe('R-2025-9');
                expect(ex.metadata.gross).toBe(119);
                expect(ex.metadata.direction).toBe('incoming');
                expect(ex.fullText).toBe('Rechnung ACME ...');
            });
            await it('maps an extraction onto the DMS metadata shape (ocrSource ai)', async () => {
                const meta = extractionToMeta({
                    metadata: {
                        invoiceNumber: 'X',
                        date: '2025-01-02',
                        correspondent: 'C',
                        net: 10,
                        gross: 11.9,
                        vat: 1.9,
                        direction: 'outgoing',
                    },
                    fullText: 'volltext',
                });
                expect(meta.created).toBe('2025-01-02');
                expect(meta.ocrText).toBe('volltext');
                expect(meta.ocrSource).toBe('ai');
            });
            await it('proposes no links without a gross amount or date', async () => {
                expect(
                    proposeTransactionLinks({
                        invoiceNumber: null,
                        date: null,
                        correspondent: null,
                        net: null,
                        gross: null,
                        vat: null,
                        direction: null,
                    }).length,
                ).toBe(0);
            });
            await it('throws a clear error on unreadable model output', async () => {
                let threw = false;
                try {
                    parseExtraction('not json at all');
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });
        });

        await describe('BuiltinDmsProvider (temp store)', async () => {
            let dir = '';
            let prevDir: string | undefined;
            let prevLedger: string | undefined;
            beforeEach(async () => {
                prevDir = process.env.TRANSACTIONS_DATA_DIR;
                prevLedger = process.env.LEDGER_DB_PATH;
                dir = mkdtempSync(join(tmpdir(), 'bh-dms-'));
                process.env.TRANSACTIONS_DATA_DIR = dir;
                // Pin the ledger DB into the fresh temp dir too. Without this the suite inherits a
                // LEDGER_DB_PATH left set by an earlier suite (@gjsify/unit's before/afterEach are a
                // single global slot, so a sibling suite's cleanup can fail to run under GJS) and both
                // tests below then share one ledger → content-addressing appears to insert a duplicate.
                process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            });
            afterEach(async () => {
                if (prevDir === undefined) delete process.env.TRANSACTIONS_DATA_DIR;
                else process.env.TRANSACTIONS_DATA_DIR = prevDir;
                if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
                else process.env.LEDGER_DB_PATH = prevLedger;
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    /* best-effort */
                }
            });

            await it('stores a file, lists/gets it, sets metadata + ocr, and links a tx', async () => {
                const p = new BuiltinDmsProvider('jumplink');
                const bytes = Buffer.from('%PDF-1.4 fake receipt');
                const doc = await p.store({ bytes, filename: 'rechnung.pdf', mimeType: 'application/pdf' });
                expect(doc.dms).toBe('builtin');
                expect(doc.mimeType).toBe('application/pdf');

                const all = await p.list({ from: '2000-01-01', to: '2999-12-31' });
                expect(all.length).toBe(1);
                expect(all[0].id).toBe(doc.id);

                const file = await p.getFile(doc.id);
                expect(file?.mimeType).toBe('application/pdf');
                expect(Buffer.from(file?.bytes ?? new Uint8Array()).toString()).toBe('%PDF-1.4 fake receipt');

                await p.setMetadata(doc.id, {
                    invoiceNumber: 'INV-1',
                    net: 50,
                    gross: 59.5,
                    vat: 9.5,
                    ocrText: 'voller text',
                    ocrSource: 'ai',
                });
                const got = await p.get(doc.id);
                expect(got?.invoiceNumber).toBe('INV-1');
                expect(got?.gross).toBe(59.5);
                expect(got?.ocrText).toBe('voller text');
                expect(got?.ocrSource).toBe('ai');
                expect(got?.aiNote).toBe(null); // built-in DMS has no KI-Hinweis column

                await p.link(doc.id, 'tx-abc');
                const linked = await p.get(doc.id);
                expect(linked?.linkedTxIds.includes('tx-abc')).toBe(true);
            });

            await it('unlinks a tx again (inverse of link, idempotent)', async () => {
                const p = new BuiltinDmsProvider('jumplink');
                const doc = await p.store({
                    bytes: Buffer.from('unlink-me'),
                    filename: 'u.pdf',
                    mimeType: 'application/pdf',
                });
                await p.link(doc.id, 'tx-u1');
                await p.link(doc.id, 'tx-u2');
                await p.unlink(doc.id, 'tx-u1');
                expect((await p.get(doc.id))?.linkedTxIds.join(',')).toBe('tx-u2');
                await p.unlink(doc.id, 'tx-u1'); // not linked → idempotent no-op
                expect((await p.get(doc.id))?.linkedTxIds.join(',')).toBe('tx-u2');
            });

            await it('refuses to unlink in a festgeschriebene (locked) period (GoBD)', async () => {
                const tx: UnifiedTransaction = {
                    id: 'tx-locked-u',
                    source: 'camt',
                    accountKey: 'camt:DE89370400440532013000',
                    bookingDate: '2025-06-01',
                    amount: -50,
                    currency: 'EUR',
                };
                upsertAccount(tx.accountKey, [tx]);
                const p = new BuiltinDmsProvider('gbr');
                const doc = await p.store({ bytes: Buffer.from('y'), filename: 's.pdf', mimeType: 'application/pdf' });
                await p.link(doc.id, 'tx-locked-u'); // link while the period is still open

                const db = openLedger(ledgerDbPath());
                migrate(db);
                seedEntities(db);
                lockPeriod(db, 'artcode', 2025, '2026-01-01T00:00:00.000Z');
                db.close();

                let threw = false;
                try {
                    await p.unlink(doc.id, 'tx-locked-u');
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
                expect((await p.get(doc.id))?.linkedTxIds.join(',')).toBe('tx-locked-u');
            });

            await it('content-addresses bytes (re-upload of the same file is one document)', async () => {
                const p = new BuiltinDmsProvider('jumplink');
                const bytes = Buffer.from('same-bytes');
                const a = await p.store({ bytes, filename: 'a.pdf', mimeType: 'application/pdf' });
                const b = await p.store({ bytes, filename: 'b.pdf', mimeType: 'application/pdf' });
                expect(a.id).toBe(b.id);
                expect((await p.list({ from: '2000-01-01', to: '2999-12-31' })).length).toBe(1);
            });

            await it('refuses to link a transaction in a festgeschriebene (locked) period (GoBD)', async () => {
                // Seed a camt transaction (→ ledger entity "artcode") and lock its year.
                const tx: UnifiedTransaction = {
                    id: 'tx-locked',
                    source: 'camt',
                    accountKey: 'camt:DE89370400440532013000',
                    bookingDate: '2025-06-01',
                    amount: -119,
                    currency: 'EUR',
                };
                upsertAccount(tx.accountKey, [tx]);
                const db = openLedger(ledgerDbPath());
                migrate(db);
                seedEntities(db);
                lockPeriod(db, 'artcode', 2025, '2026-01-01T00:00:00.000Z');
                db.close();

                const p = new BuiltinDmsProvider('gbr');
                const doc = await p.store({ bytes: Buffer.from('x'), filename: 'r.pdf', mimeType: 'application/pdf' });
                let threw = false;
                try {
                    await p.link(doc.id, 'tx-locked');
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });
        });
    });

    // The Beleg-Eingang / reconciliation must never show privately-paid receipts. They are typed as
    // incoming invoices in the shared Paperless but carry a "* Privat" tag — one per household member.
    await describe('excludeTaggedDocs', async () => {
        const d = (id: number, tags: number[]) => ({ id, tags }) as unknown as Document;
        const docs = [d(1, [4, 24]), d(2, [4, 17]), d(3, []), d(4, [23, 24]), d(5, [15])];

        await it('returns every doc when no exclude ids are configured', async () => {
            expect(
                excludeTaggedDocs(docs, undefined)
                    .map((x) => x.id)
                    .join(','),
            ).toBe('1,2,3,4,5');
            expect(
                excludeTaggedDocs(docs, [])
                    .map((x) => x.id)
                    .join(','),
            ).toBe('1,2,3,4,5');
        });

        await it('drops docs bearing any "* Privat" tag (15/17/23), keeps the business ones', async () => {
            const kept = excludeTaggedDocs(docs, [15, 17, 23]).map((x) => x.id);
            expect(kept.join(',')).toBe('1,3'); // 2, 4, 5 excluded — each bears a "* Privat" tag
        });

        await it('treats a doc with no tags as in-scope', async () => {
            expect(
                excludeTaggedDocs([d(9, [])], [17])
                    .map((x) => x.id)
                    .join(','),
            ).toBe('9');
        });
    });
};
