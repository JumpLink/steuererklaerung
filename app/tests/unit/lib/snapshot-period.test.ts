import { describe, it, expect } from '@gjsify/unit';
import {
    createSnapshot,
    insertSignoff,
    latestSignoff,
    latestSnapshot,
    listSnapshots,
    migrate,
    openLedger,
    SCHEMA_VERSION,
    schemaVersion,
} from '@steuererklaerung/store';

const snap = (formType: string, period: string | null, at: string) => ({
    entityId: 'gbr',
    year: 2025,
    formType,
    period,
    fingerprint: `fp-${period ?? 'jahr'}`,
    xml: `<x>${period ?? 'jahr'}</x>`,
    figures: { period },
});

export default async () => {
    await describe('period-scoped filing snapshots', async () => {
        await it('keeps two quarters of one year apart', async () => {
            // The defect this exists for: with no period column, "the latest ustva snapshot of
            // 2025" returned Q2 after Q2 was captured — including to a submission the user had
            // started for Q1. Sending the wrong period's XML is not a display bug.
            const db = openLedger(':memory:');
            migrate(db);
            createSnapshot(db, snap('ustva', '2025-Q1', ''), '2026-04-01T10:00:00Z');
            createSnapshot(db, snap('ustva', '2025-Q2', ''), '2026-07-01T10:00:00Z');

            expect(latestSnapshot(db, 'gbr', 2025, 'ustva', '2025-Q1')?.xml).toBe('<x>2025-Q1</x>');
            expect(latestSnapshot(db, 'gbr', 2025, 'ustva', '2025-Q2')?.xml).toBe('<x>2025-Q2</x>');
            expect(latestSnapshot(db, 'gbr', 2025, 'ustva', '2025-Q3')).toBe(null);
            db.close();
        });

        await it('leaves the annual forms unfiltered, where every row is NULL anyway', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            createSnapshot(db, snap('euer', null, ''), '2026-05-01T10:00:00Z');
            // No period argument — the call every annual caller already makes.
            expect(latestSnapshot(db, 'gbr', 2025, 'euer')?.xml).toBe('<x>jahr</x>');
            // And explicitly asking for "no period" finds the same row.
            expect(latestSnapshot(db, 'gbr', 2025, 'euer', null)?.xml).toBe('<x>jahr</x>');
            db.close();
        });

        await it('reads the period back on every snapshot, listed or fetched', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            createSnapshot(db, snap('ustva', '2025-Q4', ''), '2026-10-01T10:00:00Z');
            createSnapshot(db, snap('euer', null, ''), '2026-05-01T10:00:00Z');
            const all = listSnapshots(db, 'gbr', 2025);
            expect(all.map((s) => s.period).sort()).toStrictEqual(['2025-Q4', null].sort());
            db.close();
        });

        await it('scopes a sign-off to its period, so a Q1 release cannot cover Q2', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const q1 = createSnapshot(db, snap('ustva', '2025-Q1', ''), '2026-04-01T10:00:00Z');
            insertSignoff(
                db,
                {
                    snapshotId: q1.id,
                    entityId: 'gbr',
                    year: 2025,
                    formType: 'ustva',
                    period: '2025-Q1',
                    fingerprint: q1.fingerprint,
                    crossChecksClean: true,
                },
                '2026-04-02T10:00:00Z',
            );
            expect(latestSignoff(db, { entityId: 'gbr', year: 2025, formType: 'ustva', period: '2025-Q1' })).not.toBe(
                null,
            );
            expect(latestSignoff(db, { entityId: 'gbr', year: 2025, formType: 'ustva', period: '2025-Q2' })).toBe(null);
            db.close();
        });

        await it('refuses to hand a Q1 request the Q2 artefact', async () => {
            // The whole point, stated as the failure it prevents: a user opens the USt-VA for Q1,
            // presses send, and the pipeline transmits Q2 because that snapshot is newer. Both are
            // valid XML for the same entity and year, so nothing downstream would notice.
            const db = openLedger(':memory:');
            migrate(db);
            createSnapshot(db, snap('ustva', '2025-Q1', ''), '2026-04-01T10:00:00Z');
            createSnapshot(db, snap('ustva', '2025-Q2', ''), '2026-07-01T10:00:00Z');

            const unscoped = latestSnapshot(db, 'gbr', 2025, 'ustva');
            const scoped = latestSnapshot(db, 'gbr', 2025, 'ustva', '2025-Q1');
            // Unscoped is Q2 — which is exactly why a periodic form must never ask unscoped.
            expect(unscoped?.period).toBe('2025-Q2');
            expect(scoped?.period).toBe('2025-Q1');
            expect(scoped?.xml).not.toBe(unscoped?.xml);
            db.close();
        });

        await it('upgrades a pre-v14 database instead of failing on the missing column', async () => {
            // The migration is the risky half: an existing ledger has rows and no `period` column,
            // and CREATE TABLE IF NOT EXISTS cannot add one. Build the OLD shape by hand, migrate,
            // and check both that the column arrived and that the existing row survived as NULL.
            const db = openLedger(':memory:');
            db.exec(
                `CREATE TABLE filing_snapshots (
                   id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, year INTEGER NOT NULL, form_type TEXT NOT NULL,
                   created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, xml TEXT NOT NULL, figures TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'draft', transfer_ticket TEXT, server_protocol TEXT, note TEXT,
                   submission_source TEXT, submitted_at TEXT)`,
            );
            db.exec(
                `CREATE TABLE filing_signoffs (
                   id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, entity_id TEXT NOT NULL, year INTEGER NOT NULL,
                   form_type TEXT NOT NULL, fingerprint TEXT NOT NULL, signed_by TEXT, signed_at TEXT NOT NULL,
                   note TEXT, cross_checks_clean INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)`,
            );
            db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            db.exec(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '13')`);
            db.exec(
                `INSERT INTO filing_snapshots (id, entity_id, year, form_type, created_at, fingerprint, xml, figures)
                 VALUES ('snap_old', 'gbr', 2024, 'euer', '2025-05-01T10:00:00Z', 'fp-old', '<old/>', '{}')`,
            );

            migrate(db);

            const survived = latestSnapshot(db, 'gbr', 2024, 'euer');
            expect(survived?.xml).toBe('<old/>');
            expect(survived?.period).toBe(null);
            // And the upgraded database accepts a periodic snapshot, which the old shape could not store.
            createSnapshot(db, snap('ustva', '2025-Q1', ''), '2026-04-01T10:00:00Z');
            expect(latestSnapshot(db, 'gbr', 2025, 'ustva', '2025-Q1')?.period).toBe('2025-Q1');
            // Assert that the migration RAN TO COMPLETION, not that the schema is at some fixed
            // number: pinning the literal made every later, unrelated schema addition fail here
            // (v15 added filings.assessed_amount and did exactly that). The invariant this test
            // is about is "a pre-v14 database is carried all the way up", and that is what the
            // persisted version proves.
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
            db.close();
        });
    });
};
