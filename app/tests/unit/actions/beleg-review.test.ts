import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ledgerDbPath,
    lockPeriod,
    migrate,
    openLedger,
    upsertAccount,
    type UnifiedTransaction,
} from '@steuererklaerung/store';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import { seedEntities } from '../../../src/core/lib/ledger/seed.ts';
import { confirmBelegDecision, undoBelegConfirmation } from '../../../src/core/actions/beleg-review.ts';
import { getClassificationDecision, recordClassificationDecision } from '../../../src/core/actions/classifications.ts';

// The feature's ONE write path, exercised end-to-end on the builtin DMS against a temp workspace
// (manifest via STEUER_WORKSPACE, store + ledger via env — the same seams the demo mode uses).
export default async () => {
    await describe('actions/beleg-review — confirm + undo (builtin, temp workspace)', async () => {
        let dir = '';
        const prev = new Map<string, string | undefined>();
        const setEnv = (k: string, v: string) => {
            prev.set(k, process.env[k]);
            process.env[k] = v;
        };
        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-beleg-review-'));
            setEnv('TRANSACTIONS_DATA_DIR', dir);
            setEnv('LEDGER_DB_PATH', join(dir, 'ledger.db'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        { id: 'gbr', name: 'Test GbR', kind: 'gbr', accounts: ['camt:*'], dms: { type: 'builtin' } },
                    ],
                }),
            );
            setEnv('STEUER_WORKSPACE', manifest);
        });
        afterEach(async () => {
            for (const [k, v] of prev) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            prev.clear();
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });

        const tx = (id: string): UnifiedTransaction =>
            ({
                id,
                source: 'camt',
                accountKey: 'camt:DE00TESTKONTO',
                bookingDate: '2025-06-01',
                amount: -119,
                currency: 'EUR',
            }) as UnifiedTransaction;

        await it('confirm links + merges the decision; undo restores the prior record verbatim', async () => {
            upsertAccount('camt:DE00TESTKONTO', [tx('tx-1')]);
            const p = new BuiltinDmsProvider('gbr');
            const doc = await p.store({ bytes: Buffer.from('r1'), filename: 'r1.pdf', mimeType: 'application/pdf' });
            // A pre-existing manual override on the same booking MUST survive confirm + undo.
            recordClassificationDecision({ transactionId: 'tx-1', category: '4930 Bürobedarf', note: 'alt' });

            const res = await confirmBelegDecision({ entityId: 'gbr', documentId: doc.id, txId: 'tx-1', note: 'neu' });
            expect(res.undo.wasLinked).toBe(false);
            expect(res.documentWrite).toBe('skipped'); // builtin: no Paperless mark-up
            expect((await p.get(doc.id))?.linkedTxIds.join(',')).toBe('tx-1');
            const after = getClassificationDecision('tx-1');
            expect(after?.aiNoteAccepted).toBe(true); // accept recorded
            expect(after?.category).toBe('4930 Bürobedarf'); // merge keeps the prior override
            expect(after?.note).toBe('neu');

            await undoBelegConfirmation(res.undo);
            expect((await p.get(doc.id))?.linkedTxIds.length).toBe(0); // confirm's link removed
            const restored = getClassificationDecision('tx-1');
            expect(restored?.category).toBe('4930 Bürobedarf'); // prior record restored …
            expect(restored?.note).toBe('alt'); // … not blind-deleted
            expect(restored?.aiNoteAccepted).toBe(null);
        });

        await it('undo keeps a pre-existing link and removes a decision that had no prior', async () => {
            upsertAccount('camt:DE00TESTKONTO', [tx('tx-2')]);
            const p = new BuiltinDmsProvider('gbr');
            const doc = await p.store({ bytes: Buffer.from('r2'), filename: 'r2.pdf', mimeType: 'application/pdf' });
            await p.link(doc.id, 'tx-2'); // linked BEFORE the confirm

            const res = await confirmBelegDecision({ entityId: 'gbr', documentId: doc.id, txId: 'tx-2' });
            expect(res.undo.wasLinked).toBe(true);
            expect(getClassificationDecision('tx-2')?.aiNoteAccepted).toBe(true);

            await undoBelegConfirmation(res.undo);
            expect((await p.get(doc.id))?.linkedTxIds.join(',')).toBe('tx-2'); // pre-existing link stays
            expect(getClassificationDecision('tx-2')).toBe(null); // no prior → removed entirely
        });

        await it('GoBD: a confirm into a locked period throws and records NOTHING', async () => {
            // camt:DE89370400440532013000 maps to ledger entity "artcode" via seedEntities.
            const locked: UnifiedTransaction = {
                ...tx('tx-locked'),
                accountKey: 'camt:DE89370400440532013000',
            } as UnifiedTransaction;
            upsertAccount('camt:DE89370400440532013000', [locked]);
            const db = openLedger(ledgerDbPath());
            migrate(db);
            seedEntities(db);
            lockPeriod(db, 'artcode', 2025, '2026-01-01T00:00:00.000Z');
            db.close();

            const p = new BuiltinDmsProvider('gbr');
            const doc = await p.store({ bytes: Buffer.from('rl'), filename: 'rl.pdf', mimeType: 'application/pdf' });
            let message = '';
            try {
                await confirmBelegDecision({ entityId: 'gbr', documentId: doc.id, txId: 'tx-locked' });
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('festgeschrieben')).toBe(true);
            expect((await p.get(doc.id))?.linkedTxIds.length).toBe(0); // no link
            expect(getClassificationDecision('tx-locked')).toBe(null); // no decision
        });

        await it('confirm with a category override records it as the manual category', async () => {
            upsertAccount('camt:DE00TESTKONTO', [tx('tx-3')]);
            const p = new BuiltinDmsProvider('gbr');
            const doc = await p.store({ bytes: Buffer.from('r3'), filename: 'r3.pdf', mimeType: 'application/pdf' });

            const res = await confirmBelegDecision({
                entityId: 'gbr',
                documentId: doc.id,
                txId: 'tx-3',
                category: '4964 Software/Lizenzen',
            });
            const rec = getClassificationDecision('tx-3');
            expect(rec?.category).toBe('4964 Software/Lizenzen');
            expect(rec?.status).toBe('confirmed');

            await undoBelegConfirmation(res.undo);
            expect(getClassificationDecision('tx-3')).toBe(null);
        });
    });
};
