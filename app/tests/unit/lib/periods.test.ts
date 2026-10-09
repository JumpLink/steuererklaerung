import { describe, it, expect } from '@gjsify/unit';
import { openLedger, migrate, getPeriodStatus, lockPeriod, unlockPeriod } from '@steuererklaerung/store';
import { seedEntities } from '../../../src/core/lib/ledger/seed.ts';

export default async () => {
    await describe('ledger periods', async () => {
        await it('locks, reads, and reopens an entity year with an audit trail', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            seedEntities(db);

            expect(getPeriodStatus(db, 'artcode', 2025)).toBeNull();

            lockPeriod(db, 'artcode', 2025, '2026-06-19T00:00:00Z');
            expect(getPeriodStatus(db, 'artcode', 2025)).toBe('locked');

            // Idempotent re-lock.
            lockPeriod(db, 'artcode', 2025, '2026-06-19T01:00:00Z');
            expect(getPeriodStatus(db, 'artcode', 2025)).toBe('locked');

            unlockPeriod(db, 'artcode', 2025, '2026-06-19T02:00:00Z');
            expect(getPeriodStatus(db, 'artcode', 2025)).toBe('open');

            const audit = db.prepare(`SELECT count(*) AS n FROM audit_log`).get() as { n: number };
            expect(audit.n).toBe(3);
            db.close();
        });
    });
};
