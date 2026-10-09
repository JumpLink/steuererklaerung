/**
 * Config consolidation (steuererklaerung.json v1 manifest) — migrate/loader/writer regression net.
 *
 * Drives `migrateConfig` against COPIES of the tracked legacy fixtures in
 * tests/fixtures/legacy-config/ (fictional Muster values). Asserts:
 *   (a) round-trip — the resolved per-entity elster/est + global paperless equal the OLD loaders,
 *   (b) idempotency — a second migrate is a no-op (no second backup),
 *   (c) the SOURCE config files are byte-identical (sha256) after migrate — data-safety guarantee,
 *   (d) `//`-comment + unknown-key survival through the raw-preserving `mutateManifest`,
 *   (e) an ambiguous orphan mapping ABORTS without writing anything.
 *
 * Every test copies the fixtures into a fresh temp dir and runs there — the tracked fixtures and the
 * real gitignored configs in app/ are never touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeElsterConfig, ElsterConfigRawSchema } from '../../../src/core/config/schema/elster.ts';
import { EstConfigRawSchema } from '../../../src/core/config/schema/est.ts';
import { SyncConfigLenientSchema } from '../../../src/core/config/schema/paperless.ts';
import { loadManifest, mutateManifest } from '../../../src/core/config/manifest.ts';
import { readPaperless, resolveEntity } from '../../../src/core/config/accessors.ts';
import { migrateConfig } from '../../../src/core/config/migrate.ts';

/** Reference resolvers — the SAME normalisation the deleted loaders applied, read straight from the fixture. */
const readJson = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf-8'));
const refElster = (dir: string, f: string) => normalizeElsterConfig(ElsterConfigRawSchema.parse(readJson(dir, f)));
const refEst = (dir: string, f: string) => EstConfigRawSchema.parse(readJson(dir, f));
const refPaperless = (dir: string, f: string) => SyncConfigLenientSchema.parse(readJson(dir, f));

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'legacy-config');
const SOURCE_FILES = [
    'sync-config.json',
    'fints-config.json',
    'elster-config.json',
    'elster-config-gbr.json',
    'est-config.json',
    'recurring-invoices.json',
];

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Copy every tracked legacy fixture into `dest` (flat dir — no subdirs). */
function copyFixturesTo(dest: string): void {
    for (const f of readdirSync(FIXTURE_DIR)) copyFileSync(join(FIXTURE_DIR, f), join(dest, f));
}

export default async () => {
    await describe('config manifest — migrate/loader/writer', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'cfg-migrate-'));
            copyFixturesTo(dir);
        });
        afterEach(() => {
            rmSync(dir, { recursive: true, force: true });
            vi.unstubAllEnvs();
        });

        await it('loadManifest FAILS LOUD on a not-yet-migrated legacy registry (hints at migrate)', async () => {
            expect(() => loadManifest(join(dir, 'steuererklaerung.json'))).toThrow(/config migrate|migrate/);
        });

        await it('(a) round-trip: resolved elster/est/paperless equal what the OLD loaders produce', async () => {
            migrateConfig({ dir, now: '2026-07-15T00-00-00-000Z' });
            const manifest = loadManifest(join(dir, 'steuererklaerung.json'));

            // Each entity's inline elster resolves identically to the former loadElsterConfig on its file.
            expect(resolveEntity(manifest, 'gbr').elster).toStrictEqual(refElster(dir, 'elster-config-gbr.json'));
            expect(resolveEntity(manifest, 'soleprop').elster).toStrictEqual(refElster(dir, 'elster-config.json'));
            // The privat entity's inline est equals the former loadEstConfig on est-config.json.
            expect(resolveEntity(manifest, 'privat').est).toStrictEqual(refEst(dir, 'est-config.json'));

            // Global paperless equals the lenient sync-config (the fixture has 0 doc-type ids).
            expect(readPaperless(manifest)).toStrictEqual(refPaperless(dir, 'sync-config.json'));

            // Entities that had no such config get none.
            expect(resolveEntity(manifest, 'gbr').est).toBeUndefined();
            expect(resolveEntity(manifest, 'privat').elster).toBeUndefined();
        });

        await it('(a) recurring is grouped per entity with the standalone entityId dropped', async () => {
            migrateConfig({ dir, now: 'T' });
            const manifest = loadManifest(join(dir, 'steuererklaerung.json'));
            const sole = resolveEntity(manifest, 'soleprop');
            expect(sole.recurring.length).toBe(2);
            // entityId is gone (implied by the entity it now lives under).
            expect((sole.recurring[0] as Record<string, unknown>).entityId).toBeUndefined();
            expect(sole.recurring[0].id).toBe('example-hosting-basic');
            // Other entities have no recurring invoices.
            expect(resolveEntity(manifest, 'gbr').recurring.length).toBe(0);
        });

        await it('migrate assembles a v1 manifest, writes a timestamped backup, and preserves comments', async () => {
            const result = migrateConfig({ dir, now: 'TS1' });
            expect(result.wrote).toBe(true);
            expect(result.alreadyV1).toBe(false);
            expect(result.backupPath).toBe(join(dir, 'steuererklaerung.json.bak-TS1'));
            expect(existsSync(join(dir, 'steuererklaerung.json.bak-TS1'))).toBe(true);

            const raw = JSON.parse(readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8')) as Record<
                string,
                unknown
            >;
            expect(raw.version).toBe(1);
            // assistant/mcp moved under `app`; the top-level `//` comment survived the move.
            expect((raw.app as { assistant: { enabled: boolean } }).assistant.enabled).toBe(true);
            expect(typeof raw['//']).toBe('string');
            // The per-entity `//invoicing` comment survived the entity structure move.
            const sole = (raw.entities as Array<Record<string, unknown>>).find((e) => e.id === 'soleprop');
            expect(typeof sole?.['//invoicing']).toBe('string');
            // The path fields are gone; inline sections replace them.
            expect('elster_config' in (sole ?? {})).toBe(false);
            expect(sole?.elster).toBeDefined();
        });

        await it('(b) idempotency: a second migrate is a no-op — no second backup, manifest unchanged', async () => {
            const r1 = migrateConfig({ dir, now: 'TS1' });
            expect(r1.wrote).toBe(true);
            const afterFirst = readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8');

            const r2 = migrateConfig({ dir, now: 'TS2' });
            expect(r2.alreadyV1).toBe(true);
            expect(r2.wrote).toBe(false);
            expect(r2.backupPath).toBe(null);
            // The manifest is byte-for-byte the same, and only ONE backup exists.
            expect(readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8')).toBe(afterFirst);
            expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toStrictEqual([
                'steuererklaerung.json.bak-TS1',
            ]);
        });

        await it('(c) the SOURCE config files are byte-identical (sha256) after migrate', async () => {
            const before = SOURCE_FILES.map((f) => sha256(join(dir, f)));
            migrateConfig({ dir, now: 'TS' });
            const after = SOURCE_FILES.map((f) => sha256(join(dir, f)));
            expect(after).toStrictEqual(before);
        });

        await it('--dry-run assembles the v1 manifest + mapping but writes NOTHING', async () => {
            const before = readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8');
            const result = migrateConfig({ dir, now: 'TS', dryRun: true });
            expect(result.wrote).toBe(false);
            expect(result.backupPath).toBe(null);
            expect(result.manifest.version).toBe(1);
            expect(result.mapping?.recurringTotal).toBe(2);
            expect(result.mapping?.paperless).toBe('sync-config.json');
            expect(result.mapping?.fints).toBe('fints-config.json');
            // On disk: still the legacy registry, no backup written.
            expect(readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8')).toBe(before);
            expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false);
        });

        await it('(d) mutateManifest preserves `//`-comments + unknown keys and validates before writing', async () => {
            migrateConfig({ dir, now: 'TS' });
            const path = join(dir, 'steuererklaerung.json');
            const commentBefore = (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)['//'];

            mutateManifest(path, (raw) => {
                raw.someFutureKey = { keep: 'me' };
                (raw.entities as Array<Record<string, unknown>>)[0].name = 'Renamed GbR';
            });
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            expect(raw['//']).toBe(commentBefore); // comment preserved
            expect((raw.someFutureKey as { keep: string }).keep).toBe('me'); // unknown key preserved
            expect((raw.entities as Array<Record<string, unknown>>)[0].name).toBe('Renamed GbR');

            // An invalid mutation (empty entities) throws and leaves the file uncorrupted.
            expect(() =>
                mutateManifest(path, (r) => {
                    r.entities = [];
                }),
            ).toThrow();
            expect((JSON.parse(readFileSync(path, 'utf-8')) as { entities: unknown[] }).entities.length).toBe(3);
        });
    });

    await describe('config manifest — abort on ambiguous orphan mapping', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'cfg-ambiguous-'));
        });
        afterEach(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        await it('(e) an orphan file matching two entities via alias ABORTS and writes nothing', async () => {
            // `elster-config-gbr.json` is unreferenced; suffix "gbr" ∈ aliases('gbr') AND ∈ aliases('artcode').
            writeFileSync(
                join(dir, 'steuererklaerung.json'),
                JSON.stringify({
                    entities: [
                        { id: 'gbr', name: 'GbR', kind: 'gbr', accounts: ['camt:*'] },
                        { id: 'artcode', name: 'Art', kind: 'gbr', accounts: ['camt:*'] },
                    ],
                }),
            );
            writeFileSync(join(dir, 'elster-config-gbr.json'), JSON.stringify({ period: { year: 2025, quarter: 1 } }));
            const before = readdirSync(dir).sort();

            expect(() => migrateConfig({ dir, now: 'TS' })).toThrow(/[Mm]ehrdeutig|abgebrochen/);
            // Nothing written: registry unchanged (still no `version`), no `.bak` file created.
            const raw = JSON.parse(readFileSync(join(dir, 'steuererklaerung.json'), 'utf-8')) as Record<
                string,
                unknown
            >;
            expect(raw.version).toBeUndefined();
            expect(readdirSync(dir).sort()).toStrictEqual(before);
        });

        await it('recurring pointing at an unknown entity ABORTS and writes nothing', async () => {
            writeFileSync(
                join(dir, 'steuererklaerung.json'),
                JSON.stringify({
                    entities: [{ id: 'soleprop', name: 'S', kind: 'einzelunternehmen', accounts: ['qonto:*'] }],
                }),
            );
            writeFileSync(
                join(dir, 'recurring-invoices.json'),
                JSON.stringify({
                    invoices: [
                        {
                            id: 'x',
                            entityId: 'nobody',
                            customer: { name: 'C' },
                            nextPeriod: { start: '2026-01-01', end: '2026-12-31' },
                            items: [{ title: 'T', unitPrice: 1 }],
                        },
                    ],
                }),
            );
            const before = readdirSync(dir).sort();
            expect(() => migrateConfig({ dir, now: 'TS' })).toThrow(/unbekannte Entität|abgebrochen/);
            expect(readdirSync(dir).sort()).toStrictEqual(before);
        });
    });
};
