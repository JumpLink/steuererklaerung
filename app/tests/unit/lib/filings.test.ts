import { describe, it, expect } from '@gjsify/unit';
import {
    addFilingDocument,
    entityIdAliases,
    type Filing,
    listFilingDocuments,
    openLedger,
    migrate,
    getFiling,
    listFilings,
    removeFiling,
    removeFilingDocument,
    upsertFiling,
    SCHEMA_VERSION,
    schemaVersion,
} from '@steuererklaerung/store';
import { sumFiledUstvaVat } from '../../../src/core/actions/filings.ts';

const AT = '2026-07-04T10:00:00.000Z';

/** A filed USt-VA filing with sensible defaults; override any field. */
function filing(over: Partial<Filing>): Filing {
    return {
        entityId: 'gbr',
        kind: 'ustva',
        period: '2025-Q1',
        filedAt: '2025-04-10',
        paidAt: null,
        amount: 100,
        declaredAmount: null,
        surcharge: null,
        assessedAmount: null,
        assessedAt: null,
        note: null,
        createdAt: AT,
        updatedAt: AT,
        ...over,
    };
}

export default async () => {
    await describe('filings repo', async () => {
        await it('inserts and reads back a filing', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = upsertFiling(
                db,
                { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', filedAt: '2026-07-05', amount: 58.17 },
                AT,
            );
            expect(saved.filedAt).toBe('2026-07-05');
            expect(saved.amount).toBe(58.17);
            expect(saved.paidAt).toBeNull();
            const read = getFiling(db, 'jumplink', 'ustva', '2026-Q1');
            expect(read?.amount).toBe(58.17);
            db.close();
        });

        await it('merge-updates: a later paid_at preserves the earlier filed_at + amount', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', filedAt: '2026-07-05', amount: 58.17 }, AT);
            const paid = upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', paidAt: '2026-07-10' }, AT);
            expect(paid.filedAt).toBe('2026-07-05'); // preserved
            expect(paid.amount).toBe(58.17); // preserved
            expect(paid.paidAt).toBe('2026-07-10'); // updated
            db.close();
        });

        await it('stores declared_amount + surcharge distinctly from the paid amount (v10)', async () => {
            // The concrete GbR 2025-Q4 shape: declared 440,57 · paid 444,57 · Säumniszuschlag 4,00.
            const db = openLedger(':memory:');
            migrate(db);
            const saved = upsertFiling(
                db,
                {
                    entityId: 'gbr',
                    kind: 'ustva',
                    period: '2025-Q4',
                    filedAt: '2026-03-20',
                    paidAt: '2026-04-29',
                    declaredAmount: 440.57,
                    amount: 444.57,
                    surcharge: 4.0,
                },
                AT,
            );
            expect(saved.declaredAmount).toBe(440.57);
            expect(saved.amount).toBe(444.57);
            expect(saved.surcharge).toBe(4.0);
            // A later payment-only patch preserves the declared Soll + surcharge (merge).
            const patched = upsertFiling(db, { entityId: 'gbr', kind: 'ustva', period: '2025-Q4', paidAt: '2026-05-01' }, AT);
            expect(patched.declaredAmount).toBe(440.57);
            expect(patched.surcharge).toBe(4.0);
            expect(patched.paidAt).toBe('2026-05-01');
            db.close();
        });

        await it('legacy rows (no declared_amount column value) read back as null', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = upsertFiling(db, { entityId: 'gbr', kind: 'ustva', period: '2025-Q1', amount: 100 }, AT);
            expect(saved.amount).toBe(100);
            expect(saved.declaredAmount).toBeNull();
            expect(saved.surcharge).toBeNull();
            db.close();
        });

        await it('lists newest period first and filters by entity + year', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', filedAt: '2026-07-05' }, AT);
            upsertFiling(db, { entityId: 'jumplink', kind: 'ust-jahr', period: '2025', filedAt: '2026-07-20' }, AT);
            upsertFiling(db, { entityId: 'gbr', kind: 'gewst', period: '2025', filedAt: '2026-07-21' }, AT);

            const all = listFilings(db);
            expect(all.length).toBe(3);
            expect(all[0].period).toBe('2026-Q1'); // newest period first

            const jl2025 = listFilings(db, { entityId: 'jumplink', year: 2025 });
            expect(jl2025.map((f) => f.kind)).toStrictEqual(['ust-jahr']);

            const y2025 = listFilings(db, { year: 2025 });
            expect(y2025.length).toBe(2); // jumplink ust-jahr + gbr gewst
            db.close();
        });

        await it('removes a filing and reports whether one existed', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1' }, AT);
            expect(removeFiling(db, 'jumplink', 'ustva', '2026-Q1')).toBe(true);
            expect(removeFiling(db, 'jumplink', 'ustva', '2026-Q1')).toBe(false);
            expect(getFiling(db, 'jumplink', 'ustva', '2026-Q1')).toBeNull();
            db.close();
        });

        await it('clears a field when null is passed explicitly', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', note: 'draft' }, AT);
            const cleared = upsertFiling(db, { entityId: 'jumplink', kind: 'ustva', period: '2026-Q1', note: null }, AT);
            expect(cleared.note).toBeNull();
            db.close();
        });
    });

    await describe('schema migration idempotency (additive ADD COLUMN)', async () => {
        await it('re-runs safely when an upgrade column already exists (half-applied prior run)', async () => {
            const db = openLedger(':memory:');
            migrate(db); // → SCHEMA_VERSION; all v10 columns (declared_amount, surcharge, …) present
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

            // Simulate the real-DB state: the ALTER-added columns exist, but the persisted
            // schema_version fell behind (an interrupted process bumped the columns, not the version).
            db.exec(`UPDATE schema_meta SET value = '8' WHERE key = 'schema_version'`);

            // Migrating again must NOT throw a "duplicate column name" — the ADD COLUMN upgrades for
            // v9 + v10 are no-ops because the columns are already there — and must re-reach the version.
            migrate(db);
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

            // The declared/paid/surcharge columns still work after the re-migration.
            const saved = upsertFiling(
                db,
                { entityId: 'gbr', kind: 'ustva', period: '2025-Q4', declaredAmount: 440.57, surcharge: 4.0 },
                AT,
            );
            expect(saved.declaredAmount).toBe(440.57);
            expect(saved.surcharge).toBe(4.0);
            db.close();
        });
    });

    await describe('entityIdAliases', async () => {
        await it('bridges the GbR ledger id and its workspace alias, both directions', async () => {
            expect(entityIdAliases('artcode').sort()).toStrictEqual(['artcode', 'gbr']);
            expect(entityIdAliases('gbr').sort()).toStrictEqual(['artcode', 'gbr']);
            expect(entityIdAliases('private').sort()).toStrictEqual(['privat', 'private']);
        });

        await it('deduplicates when the two namespaces coincide (jumplink)', async () => {
            expect(entityIdAliases('jumplink')).toStrictEqual(['jumplink']);
        });

        await it('returns an unknown id unchanged', async () => {
            expect(entityIdAliases('foo')).toStrictEqual(['foo']);
        });
    });

    await describe('sumFiledUstvaVat', async () => {
        await it('sums the year\'s filed USt-VA Zahllasten, alias-tolerant', async () => {
            const filings = [
                filing({ period: '2025-Q1', amount: 155.65 }),
                filing({ period: '2025-Q2', amount: 58.17 }),
            ];
            // Querying by the ledger id must match filings recorded under the workspace id.
            expect(sumFiledUstvaVat(filings, 'artcode')).toBe(213.82);
            expect(sumFiledUstvaVat(filings, 'gbr')).toBe(213.82);
        });

        await it('ignores other entities, other kinds, unfiled rows and null amounts', async () => {
            const filings = [
                filing({ period: '2025-Q1', amount: 100 }), // gbr ustva filed → counts
                filing({ entityId: 'jumplink', period: '2025-Q1', amount: 999 }), // other entity
                filing({ period: '2025-Q2', kind: 'ust-jahr', amount: 500 }), // other kind
                filing({ period: '2025-Q3', filedAt: null, amount: 200 }), // not filed
                filing({ period: '2025-Q4', amount: null }), // no amount / no declared
            ];
            expect(sumFiledUstvaVat(filings, 'gbr')).toBe(100);
        });

        await it('sums the DECLARED Anmeldungssoll, NOT the payment — a Säumniszuschlag never enters Z119', async () => {
            // GbR 2025-Q4: declared 440,57 · paid 444,57 · Säumniszuschlag 4,00 → Z119 must be 440,57.
            const filings = [
                filing({ period: '2025-Q4', declaredAmount: 440.57, amount: 444.57, surcharge: 4.0 }),
            ];
            expect(sumFiledUstvaVat(filings, 'gbr')).toBe(440.57);
        });

        await it('falls back to the legacy amount when declaredAmount is null (pre-v10 rows)', async () => {
            const filings = [
                filing({ period: '2025-Q1', declaredAmount: null, amount: 155.65 }), // legacy → uses amount
                filing({ period: '2025-Q2', declaredAmount: 58.17, amount: 60.0, surcharge: 1.83 }), // uses declared
            ];
            expect(sumFiledUstvaVat(filings, 'gbr')).toBe(213.82);
        });

        await it('returns null when the entity has no filed USt-VA (so callers fall back to config)', async () => {
            expect(sumFiledUstvaVat([], 'gbr')).toBeNull();
            expect(sumFiledUstvaVat([filing({ entityId: 'jumplink' })], 'gbr')).toBeNull();
            expect(sumFiledUstvaVat([filing({ filedAt: null })], 'gbr')).toBeNull();
            // A row with only a surcharge (no declared, no amount) is not a Soll → null.
            expect(sumFiledUstvaVat([filing({ amount: null, declaredAmount: null, surcharge: 4.0 })], 'gbr')).toBeNull();
        });
    });

    await describe('filing documents repo (schema v11)', async () => {
        await it('attaches, lists and detaches a document on a filing', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = addFilingDocument(
                db,
                { entityId: 'gbr', kind: 'ust-jahr', period: '2025', documentRef: 'paperless:2900', role: 'bescheid' },
                AT,
            );
            expect(saved.role).toBe('bescheid');
            expect(saved.documentRef).toBe('paperless:2900');
            const listed = listFilingDocuments(db, { entityId: 'gbr', kind: 'ust-jahr', period: '2025' });
            expect(listed.length).toBe(1);
            expect(removeFilingDocument(db, 'gbr', 'ust-jahr', '2025', 'paperless:2900')).toBe(true);
            expect(removeFilingDocument(db, 'gbr', 'ust-jahr', '2025', 'paperless:2900')).toBe(false);
            expect(listFilingDocuments(db).length).toBe(0);
            db.close();
        });

        await it('re-attaching the same documentRef merge-updates role/note instead of duplicating', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            addFilingDocument(db, { entityId: 'gbr', kind: 'ust-jahr', period: '2025', documentRef: 'paperless:1' }, AT);
            const updated = addFilingDocument(
                db,
                { entityId: 'gbr', kind: 'ust-jahr', period: '2025', documentRef: 'paperless:1', role: 'mahnung', note: 'FA-Mahnung' },
                AT,
            );
            expect(updated.role).toBe('mahnung');
            expect(updated.note).toBe('FA-Mahnung');
            expect(listFilingDocuments(db).length).toBe(1);
            db.close();
        });

        await it('defaults the role to sonstiges and filters by documentRef across filings', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const saved = addFilingDocument(
                db,
                { entityId: 'gbr', kind: 'ust-jahr', period: '2025', documentRef: 'paperless:7' },
                AT,
            );
            expect(saved.role).toBe('sonstiges');
            addFilingDocument(db, { entityId: 'gbr', kind: 'gewst', period: '2025', documentRef: 'paperless:7' }, AT);
            // One document attached to two filings → documentRef filter finds both.
            expect(listFilingDocuments(db, { documentRef: 'paperless:7' }).length).toBe(2);
            expect(listFilingDocuments(db, { documentRef: 'paperless:7', kind: 'gewst' }).length).toBe(1);
            db.close();
        });
    });
};
