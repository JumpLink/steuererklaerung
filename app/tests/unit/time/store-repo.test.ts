import { describe, expect, it } from '@gjsify/unit';
import {
    findTimeEntryByExternalId,
    getRunningTimeEntry,
    type LedgerDatabase,
    listTimeEntries,
    markTimeEntriesInvoiced,
    migrate,
    openLedger,
    schemaVersion,
    SCHEMA_VERSION,
    secondsBetween,
    startTimeEntry,
    stopTimeEntry,
    summarizeTime,
    upsertTimeEntry,
} from '@steuererklaerung/store';

const AT = '2026-08-12T10:00:00Z';

function fresh(): LedgerDatabase {
    const db = openLedger(':memory:');
    migrate(db);
    return db;
}

export default async () => {
    await describe('time entry repo', async () => {
        await it('derives the duration from the interval when none is given', async () => {
            const db = fresh();
            const e = upsertTimeEntry(
                db,
                {
                    entityId: 'jumplink',
                    project: 'Nordwerk',
                    startedAt: '2026-08-12T08:00:00Z',
                    endedAt: '2026-08-12T09:30:00Z',
                },
                AT,
            );
            expect(e.durationSeconds).toBe(5400);
            db.close();
        });

        await it('keeps an explicitly passed duration (rounded billing) over the raw interval', async () => {
            const db = fresh();
            const e = upsertTimeEntry(
                db,
                {
                    entityId: 'jumplink',
                    project: 'Nordwerk',
                    startedAt: '2026-08-12T08:00:00Z',
                    endedAt: '2026-08-12T08:50:00Z',
                    durationSeconds: 3600,
                },
                AT,
            );
            expect(e.durationSeconds).toBe(3600);
            db.close();
        });

        await it('refuses a second running timer for the same entity', async () => {
            const db = fresh();
            startTimeEntry(db, { entityId: 'jumplink', project: 'A', startedAt: AT }, AT);
            let threw = false;
            try {
                startTimeEntry(db, { entityId: 'jumplink', project: 'B', startedAt: AT }, AT);
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            // A different entity is unaffected — they are separate books.
            const other = startTimeEntry(db, { entityId: 'gbr', project: 'B', startedAt: AT }, AT);
            expect(other.endedAt).toBe(null);
            db.close();
        });

        await it('stops the running timer and computes its duration', async () => {
            const db = fresh();
            startTimeEntry(db, { entityId: 'jumplink', project: 'Nordwerk', startedAt: '2026-08-12T08:00:00Z' }, AT);
            const stopped = stopTimeEntry(db, 'jumplink', '2026-08-12T08:45:00Z');
            expect(stopped.durationSeconds).toBe(2700);
            expect(getRunningTimeEntry(db, 'jumplink')).toBe(null);
            db.close();
        });

        await it('never returns a negative duration for an inverted interval', async () => {
            expect(secondsBetween('2026-08-12T10:00:00Z', '2026-08-12T09:00:00Z')).toBe(0);
        });

        await it('filters unbilled entries by the absence of an invoice link', async () => {
            const db = fresh();
            const a = upsertTimeEntry(
                db,
                { entityId: 'jumplink', project: 'Nordwerk', startedAt: AT, endedAt: '2026-08-12T11:00:00Z' },
                AT,
            );
            upsertTimeEntry(
                db,
                {
                    entityId: 'jumplink',
                    project: 'Nordwerk',
                    startedAt: AT,
                    endedAt: '2026-08-12T11:00:00Z',
                    invoiceId: 'inv_1',
                },
                AT,
            );
            const unbilled = listTimeEntries(db, { entityId: 'jumplink', unbilled: true });
            expect(unbilled.length).toBe(1);
            expect(unbilled[0].id).toBe(a.id);
            db.close();
        });

        await it('refuses to move an entry to a second invoice', async () => {
            const db = fresh();
            const e = upsertTimeEntry(
                db,
                { entityId: 'jumplink', project: 'Nordwerk', startedAt: AT, endedAt: '2026-08-12T11:00:00Z' },
                AT,
            );
            expect(markTimeEntriesInvoiced(db, [e.id], 'inv_1', AT)).toBe(1);
            // Same invoice again is a no-op, not an error — re-running a bill run must be safe.
            expect(markTimeEntriesInvoiced(db, [e.id], 'inv_1', AT)).toBe(0);
            let threw = false;
            try {
                markTimeEntriesInvoiced(db, [e.id], 'inv_2', AT);
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            db.close();
        });

        await it('excludes the running entry from summaries', async () => {
            const db = fresh();
            upsertTimeEntry(
                db,
                {
                    entityId: 'jumplink',
                    project: 'Nordwerk',
                    startedAt: '2026-08-12T08:00:00Z',
                    endedAt: '2026-08-12T09:00:00Z',
                },
                AT,
            );
            startTimeEntry(db, { entityId: 'jumplink', project: 'Nordwerk', startedAt: '2026-08-12T10:00:00Z' }, AT);
            const rows = summarizeTime(db, { entityId: 'jumplink' });
            expect(rows.length).toBe(1);
            expect(rows[0].seconds).toBe(3600);
            expect(rows[0].entries).toBe(1);
            db.close();
        });

        await it('includes the whole last day when `to` is a plain date', async () => {
            const db = fresh();
            upsertTimeEntry(
                db,
                {
                    entityId: 'jumplink',
                    project: 'Nordwerk',
                    startedAt: '2026-08-12T20:00:00Z',
                    endedAt: '2026-08-12T21:00:00Z',
                },
                AT,
            );
            expect(listTimeEntries(db, { entityId: 'jumplink', to: '2026-08-12' }).length).toBe(1);
            db.close();
        });

        await it('finds a previously imported entry by its external id, per entity', async () => {
            const db = fresh();
            upsertTimeEntry(
                db,
                { entityId: 'jumplink', project: 'Nordwerk', startedAt: AT, externalId: '9876543210987' },
                AT,
            );
            expect(findTimeEntryByExternalId(db, 'jumplink', '9876543210987')).not.toBe(null);
            expect(findTimeEntryByExternalId(db, 'gbr', '9876543210987')).toBe(null);
            db.close();
        });

        await it('keeps the project id on an update that omits it and drops it on null', async () => {
            const db = fresh();
            const base = { entityId: 'jumplink', project: 'Nordwerk', startedAt: AT, endedAt: '2026-08-12T11:00:00Z' };
            const first = upsertTimeEntry(db, { ...base, projectId: 'nordwerk-website' }, AT);
            expect(upsertTimeEntry(db, { ...base, id: first.id }, AT).projectId).toBe('nordwerk-website');
            expect(upsertTimeEntry(db, { ...base, id: first.id, projectId: null }, AT).projectId).toBe(null);
            db.close();
        });

        await it('stores the project id and filters and groups by it', async () => {
            const db = fresh();
            const base = { entityId: 'jumplink', project: 'Nordwerk', startedAt: AT, endedAt: '2026-08-12T11:00:00Z' };
            upsertTimeEntry(db, { ...base, projectId: 'nordwerk-website' }, AT);
            upsertTimeEntry(db, base, AT);
            expect(listTimeEntries(db, { projectId: 'nordwerk-website' }).length).toBe(1);
            // The label-only entry stays a separate group: it is not guessed onto the project.
            const rows = summarizeTime(db, { entityId: 'jumplink' });
            expect(rows.length).toBe(2);
            expect(rows.filter((r) => r.projectId === null).length).toBe(1);
            expect(rows.filter((r) => r.projectId === 'nordwerk-website').length).toBe(1);
            db.close();
        });

        await it('upgrades a pre-v16 database and keeps its entries label-only', async () => {
            // An existing ledger has rows and no `project_id` column; CREATE TABLE IF NOT EXISTS
            // cannot add one. Build the OLD shape by hand, migrate, check the row survived as NULL.
            const db = openLedger(':memory:');
            db.exec(
                `CREATE TABLE time_entries (
                   id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, contact_id TEXT, project TEXT NOT NULL,
                   description TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER,
                   billable INTEGER NOT NULL DEFAULT 1, invoice_id TEXT,
                   source TEXT NOT NULL DEFAULT 'manual', external_id TEXT, note TEXT,
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            );
            db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            db.exec(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '15')`);
            db.exec(
                `INSERT INTO time_entries (id, entity_id, project, started_at, created_at, updated_at)
                 VALUES ('t_old', 'jumplink', 'Nordwerk', '2026-01-02T08:00:00Z', '${AT}', '${AT}')`,
            );

            migrate(db);

            const [old] = listTimeEntries(db, { entityId: 'jumplink' });
            expect(old.project).toBe('Nordwerk');
            expect(old.projectId).toBe(null);
            const added = upsertTimeEntry(
                db,
                { entityId: 'jumplink', project: 'Nordwerk', projectId: 'p1', startedAt: AT },
                AT,
            );
            expect(added.projectId).toBe('p1');
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
            db.close();
        });
    });
};
