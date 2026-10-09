/**
 * The rename fallback: `buchhaltung` → `steuererklaerung` must not orphan an existing installation.
 *
 * The config manifest is the app's ONLY copy of the entity registry, the Steuernummern, the account
 * bindings and the recurring invoices, and it is resolved relative to the CURRENT WORKING DIRECTORY.
 * If the renamed app knew only the new filename, a pre-rename installation would find nothing —
 * and, worse, could start building a parallel, empty data set beside the real one.
 *
 * The chosen way is FALLBACK, not migration (see `core/config/manifest.ts`): prefer the new name,
 * keep reading the old one, say so once, and never move or rewrite the user's file. These tests
 * cover the ALTBESTAND case, not just a fresh install:
 *
 *   1. resolution order + precedence (file and env)
 *   2. the notice: emitted on the legacy hit, once per process, naming both paths
 *   3. a v1 manifest under the OLD name loads end-to-end — entities intact, no empty start
 *   4. writes land in the legacy file IN PLACE — no second, diverging manifest appears
 *   5. `config migrate` migrates the file that was actually found, under its own name
 *   6. with neither file present the error names BOTH filenames
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    LEGACY_MANIFEST_FILENAME,
    MANIFEST_FILENAME,
    getManifestPath,
    loadManifest,
    mutateManifest,
    resetConfigNotices,
} from '../../../src/core/config/manifest.ts';
import { resolveEntity } from '../../../src/core/config/accessors.ts';
import { isDemoMode } from '../../../src/core/config/demo.ts';
import { migrateConfig } from '../../../src/core/config/migrate.ts';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'legacy-config');

/** A minimal but schema-valid v1 manifest — stands in for a real, pre-rename workspace. */
function v1Manifest(): string {
    return JSON.stringify(
        {
            version: 1,
            entities: [
                {
                    id: 'soleprop',
                    name: 'Muster Einzelunternehmen',
                    kind: 'einzelunternehmen',
                    accounts: ['qonto:muster'],
                },
            ],
        },
        null,
        2,
    );
}

/** Run `fn` with `console.error` captured; returns everything it was called with. */
function captureStderr(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
    };
    try {
        fn();
    } finally {
        console.error = original;
    }
    return lines;
}

export default async () => {
    await describe('rename fallback — the pre-rename config keeps working', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'rename-fallback-'));
            resetConfigNotices();
            // Neither override set by default: these tests exercise the cwd-relative resolution.
            vi.stubEnv('STEUER_WORKSPACE', undefined);
            vi.stubEnv('BUCHHALTUNG_WORKSPACE', undefined);
        });
        afterEach(() => {
            rmSync(dir, { recursive: true, force: true });
            vi.unstubAllEnvs();
            resetConfigNotices();
        });

        await it('(1) prefers the new filename when BOTH exist', async () => {
            writeFileSync(join(dir, MANIFEST_FILENAME), v1Manifest());
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            expect(getManifestPath(dir)).toBe(join(dir, MANIFEST_FILENAME));
        });

        await it('(1) falls back to the old filename when only it exists', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            expect(getManifestPath(dir)).toBe(join(dir, LEGACY_MANIFEST_FILENAME));
        });

        await it('(1) reports the NEW path when neither exists (so a fresh install adopts the new name)', async () => {
            expect(getManifestPath(dir)).toBe(join(dir, MANIFEST_FILENAME));
        });

        await it('(1) STEUER_WORKSPACE wins over BUCHHALTUNG_WORKSPACE', async () => {
            vi.stubEnv('STEUER_WORKSPACE', '/tmp/new.json');
            vi.stubEnv('BUCHHALTUNG_WORKSPACE', '/tmp/old.json');
            expect(getManifestPath(dir)).toBe('/tmp/new.json');
        });

        await it('(1) BUCHHALTUNG_WORKSPACE is still honoured when the new variable is unset', async () => {
            vi.stubEnv('BUCHHALTUNG_WORKSPACE', '/tmp/old.json');
            const notices = captureStderr(() => {
                expect(getManifestPath(dir)).toBe('/tmp/old.json');
            });
            expect(notices.join('\n')).toMatch(/STEUER_WORKSPACE/);
        });

        await it('(2) the legacy hit prints ONE notice naming both paths and the rename command', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            const notices = captureStderr(() => {
                getManifestPath(dir);
            });
            expect(notices.length).toBe(1);
            const text = notices[0];
            expect(text).toMatch(new RegExp(LEGACY_MANIFEST_FILENAME));
            expect(text).toMatch(new RegExp(MANIFEST_FILENAME));
            expect(text).toMatch(/mv /);
        });

        await it('(2) the notice is printed once per process, not on every config read', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            const notices = captureStderr(() => {
                getManifestPath(dir);
                getManifestPath(dir);
                getManifestPath(dir);
            });
            expect(notices.length).toBe(1);
        });

        await it('(2) no notice at all when the new filename is in place', async () => {
            writeFileSync(join(dir, MANIFEST_FILENAME), v1Manifest());
            expect(captureStderr(() => getManifestPath(dir))).toStrictEqual([]);
        });

        await it('(3) ALTBESTAND: a v1 manifest under the OLD name loads with its entities intact', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            const loaded = loadManifest(getManifestPath(dir));
            expect(loaded.version).toBe(1);
            expect(loaded.entities.length).toBe(1);
            expect(resolveEntity(loaded, 'soleprop').name).toBe('Muster Einzelunternehmen');
        });

        await it('(4) a write lands in the legacy file IN PLACE — no second manifest appears', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            const path = getManifestPath(dir);

            mutateManifest(path, (raw) => {
                (raw.entities as Array<Record<string, unknown>>)[0].name = 'Umbenannt';
            });

            // The old file was updated …
            const raw = JSON.parse(readFileSync(join(dir, LEGACY_MANIFEST_FILENAME), 'utf-8')) as {
                entities: Array<{ name: string }>;
            };
            expect(raw.entities[0].name).toBe('Umbenannt');
            // … and NOTHING was created under the new name (that would be the silent fresh start).
            expect(existsSync(join(dir, MANIFEST_FILENAME))).toBe(false);
        });

        await it('(5) config migrate migrates the file it found, under its own name', async () => {
            // A pre-v1 split-config workspace whose registry still carries the OLD filename.
            for (const f of readdirSync(FIXTURE_DIR)) {
                const target = f === MANIFEST_FILENAME ? LEGACY_MANIFEST_FILENAME : f;
                copyFileSync(join(FIXTURE_DIR, f), join(dir, target));
            }
            const registryFile = LEGACY_MANIFEST_FILENAME;
            expect(getManifestPath(dir)).toBe(join(dir, registryFile));

            const result = migrateConfig({ dir, now: 'TS1', registryFile });
            expect(result.wrote).toBe(true);
            expect(result.manifestPath).toBe(join(dir, registryFile));
            expect(result.backupPath).toBe(join(dir, `${registryFile}.bak-TS1`));

            // The consolidated manifest replaced the OLD file; no parallel new-name file was forked.
            const migrated = loadManifest(join(dir, registryFile));
            expect(migrated.version).toBe(1);
            expect(existsSync(join(dir, MANIFEST_FILENAME))).toBe(false);
        });

        await it('(6) with neither file present the error names BOTH filenames', async () => {
            let message = '';
            try {
                loadManifest(getManifestPath(dir));
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toMatch(new RegExp(MANIFEST_FILENAME));
            expect(message).toMatch(new RegExp(LEGACY_MANIFEST_FILENAME));
        });
    });

    await describe('rename fallback — the demo switch', async () => {
        afterEach(() => {
            vi.unstubAllEnvs();
        });

        await it('honours the pre-rename BH_DEMO as well as STEUER_DEMO', async () => {
            vi.stubEnv('STEUER_DEMO', undefined);
            vi.stubEnv('BH_DEMO', undefined);
            expect(isDemoMode()).toBe(false);

            vi.stubEnv('BH_DEMO', '1');
            expect(isDemoMode()).toBe(true);

            vi.stubEnv('BH_DEMO', undefined);
            vi.stubEnv('STEUER_DEMO', '1');
            expect(isDemoMode()).toBe(true);
        });
    });
};
