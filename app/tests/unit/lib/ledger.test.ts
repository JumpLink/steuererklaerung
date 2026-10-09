import { describe, it, expect } from '@gjsify/unit';
import {
    openLedger,
    migrate,
    schemaVersion,
    SCHEMA_VERSION,
    entityForAccountKey,
    ledgerEntityForWorkspaceEntity,
    type UnifiedTransaction,
} from '@steuererklaerung/store';
import {
    importTransactions,
    ledgerStatus,
    seedChartOfAccounts,
    seedEntities,
    upsertAccounts,
} from '../../../src/core/lib/ledger/seed.ts';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: 'x', source: 'camt', accountKey: 'camt:DE15', bookingDate: '2025-01-01', amount: -10, currency: 'EUR', ...over };
}

export default async () => {
    await describe('ledger', async () => {
        await it('maps account keys to their entity', async () => {
            expect(entityForAccountKey('camt:DE89370400440532013000')).toBe('artcode');
            expect(entityForAccountKey('qonto:01234567')).toBe('jumplink');
            expect(entityForAccountKey('fints:musterbank-privat:1234567890')).toBe('private');
            expect(entityForAccountKey('weird:x')).toBeNull();
        });

        await it('maps workspace entity ids to ledger entities', async () => {
            expect(ledgerEntityForWorkspaceEntity('gbr')).toBe('artcode');
            expect(ledgerEntityForWorkspaceEntity('jumplink')).toBe('jumplink');
            expect(ledgerEntityForWorkspaceEntity('privat')).toBe('private');
            // A ledger id passes through unchanged; unknown ids mean "no ledger entity".
            expect(ledgerEntityForWorkspaceEntity('artcode')).toBe('artcode');
            expect(ledgerEntityForWorkspaceEntity('unknown')).toBeNull();
        });

        await it('migrates, seeds master data, and imports RAW transactions idempotently', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
            // Re-running migrate on an up-to-date database is a no-op (idempotent baseline).
            migrate(db);
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

            seedEntities(db);
            expect(seedChartOfAccounts(db)).toBeGreaterThanOrEqual(30);

            const txs = [
                tx({ id: 'a', accountKey: 'camt:DE15', amount: -10, bookingDate: '2025-01-02' }),
                tx({ id: 'b', accountKey: 'camt:DE15', amount: 1190, bookingDate: '2025-03-01' }),
                tx({ id: 'c', accountKey: 'qonto:019a', source: 'qonto', amount: -5, bookingDate: '2025-02-01' }),
            ];
            expect(upsertAccounts(db, txs)).toBe(2);

            expect(importTransactions(db, txs, '2026-06-18T00:00:00Z')).toStrictEqual({ added: 3, updated: 0 });
            // Re-importing the same data changes nothing new (idempotent upsert).
            expect(importTransactions(db, txs, '2026-06-18T00:00:00Z')).toStrictEqual({ added: 0, updated: 3 });

            const s = ledgerStatus(db, ':memory:');
            expect(s.transactions).toBe(3);
            expect(s.entities).toBe(3);
            expect(s.accounts).toBe(2);
            expect(s.classifications).toBe(0); // decision layer stays empty/open

            const artcode = s.byAccount.find((a) => a.accountKey === 'camt:DE15');
            expect(artcode?.entityId).toBe('artcode');
            expect(artcode?.count).toBe(2);
            expect(artcode?.from).toBe('2025-01-02');
            expect(artcode?.to).toBe('2025-03-01');
            db.close();
        });

        await it('enforces foreign keys (transaction needs a known account)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            seedEntities(db);
            // No accounts seeded → importing must fail rather than orphan the row.
            expect(() => importTransactions(db, [tx({ id: 'z' })], '2026-06-18T00:00:00Z')).toThrow();
            expect(ledgerStatus(db, ':memory:').transactions).toBe(0);
            db.close();
        });
    });

};
