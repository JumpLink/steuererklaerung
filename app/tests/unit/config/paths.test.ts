/**
 * Where a FRESH installation puts its files — and, far more importantly, where it does NOT.
 *
 * The bug: every path came from `process.cwd()` (the manifest) or the module's own location (the
 * store). Both are right for a developer in `app/` and for the MCP server, whose registration sets
 * `cwd` — and both fall over when the installed app is launched from the GNOME overview, where cwd
 * is `/` or `$HOME`. The app reported "kein Manifest gefunden" with no way forward.
 *
 * The fix is strictly additive, and THAT is what most of these tests pin: an installation that
 * already resolves to something must not be redirected. Two ways to get that wrong are covered
 * explicitly, because both would look like data loss to the person it happens to:
 *
 *   - a pre-rename `buchhaltung.json` in cwd must still win, so the app cannot start a second,
 *     empty configuration beside the only copy of someone's tax data;
 *   - an existing store must not be orphaned, so the check asks the STORE where it would look
 *     (module-relative) rather than guessing from cwd.
 */
import { afterEach, describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    APP_DIR_NAME,
    applyPathEnv,
    defaultDataDir,
    defaultManifestPath,
    userConfigDir,
    userDataDir,
    xdgConfigHome,
    xdgDataHome,
} from '../../../src/core/paths.ts';

/** Save + restore every environment variable these tests touch. */
const KEYS = ['STEUER_WORKSPACE', 'BUCHHALTUNG_WORKSPACE', 'TRANSACTIONS_DATA_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

export default async () => {
    const dirs: string[] = [];
    let saved: Record<string, string | undefined> = {};

    function stub(values: Record<string, string | undefined>): void {
        saved = {};
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        for (const [k, v] of Object.entries(values)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }

    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function tmp(): string {
        const dir = mkdtempSync(join(tmpdir(), 'bh-paths-'));
        dirs.push(dir);
        return dir;
    }

    await describe('XDG resolution', async () => {
        await it('honours XDG_CONFIG_HOME / XDG_DATA_HOME when absolute', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' });
            expect(xdgConfigHome()).toBe('/xdg/cfg');
            expect(xdgDataHome()).toBe('/xdg/data');
            expect(userConfigDir()).toBe(join('/xdg/cfg', APP_DIR_NAME));
            expect(userDataDir()).toBe(join('/xdg/data', APP_DIR_NAME));
        });

        await it('ignores a RELATIVE XDG value, as the spec requires', async () => {
            // A relative value is not merely unusual: honouring it would place the manifest
            // somewhere that moves with the working directory — the very bug this fixes.
            stub({ XDG_CONFIG_HOME: 'relative/path' });
            expect(xdgConfigHome().startsWith('/')).toBe(true);
            expect(xdgConfigHome().endsWith('/.config')).toBe(true);
        });

        await it('falls back to ~/.config and ~/.local/share when unset', async () => {
            stub({});
            expect(xdgConfigHome().endsWith('/.config')).toBe(true);
            expect(xdgDataHome().endsWith('/.local/share')).toBe(true);
        });

        await it('names the manifest and store under those roots', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' });
            expect(defaultManifestPath()).toBe('/xdg/cfg/steuererklaerung/steuererklaerung.json');
            expect(defaultDataDir()).toBe('/xdg/data/steuererklaerung/transactions-data');
        });
    });

    await describe('applyPathEnv — additive only', async () => {
        await it('gives a fresh install a home when cwd holds nothing', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' });
            const cwd = tmp(); // empty — the "launched from the GNOME overview" case
            applyPathEnv(cwd);
            expect(process.env.STEUER_WORKSPACE).toBe('/xdg/cfg/steuererklaerung/steuererklaerung.json');
        });

        await it('does NOT touch STEUER_WORKSPACE when a manifest sits in cwd', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg' });
            const cwd = tmp();
            writeFileSync(join(cwd, 'steuererklaerung.json'), '{"version":1,"entities":[{"id":"x","name":"X"}]}');
            applyPathEnv(cwd);
            // Left unset on purpose: getManifestPath() must take its own cwd branch, unchanged.
            expect(process.env.STEUER_WORKSPACE).toBe(undefined);
        });

        await it('does NOT step over a pre-rename buchhaltung.json', async () => {
            // The Altbestand case. Redirecting here would start a second, empty configuration
            // beside the only copy of someone's Steuernummern — and the rename notice, which
            // getManifestPath() prints on ITS cwd branch, would never appear.
            stub({ XDG_CONFIG_HOME: '/xdg/cfg' });
            const cwd = tmp();
            writeFileSync(join(cwd, 'buchhaltung.json'), '{"version":1,"entities":[{"id":"x","name":"X"}]}');
            applyPathEnv(cwd);
            expect(process.env.STEUER_WORKSPACE).toBe(undefined);
        });

        await it('leaves an explicit override alone', async () => {
            stub({ STEUER_WORKSPACE: '/somewhere/mine.json', XDG_CONFIG_HOME: '/xdg/cfg' });
            applyPathEnv(tmp());
            expect(process.env.STEUER_WORKSPACE).toBe('/somewhere/mine.json');
        });

        await it('leaves the pre-rename override alone too', async () => {
            stub({ BUCHHALTUNG_WORKSPACE: '/alt/buchhaltung.json', XDG_CONFIG_HOME: '/xdg/cfg' });
            applyPathEnv(tmp());
            expect(process.env.STEUER_WORKSPACE).toBe(undefined);
            expect(process.env.BUCHHALTUNG_WORKSPACE).toBe('/alt/buchhaltung.json');
        });

        await it('leaves an explicit TRANSACTIONS_DATA_DIR alone', async () => {
            const store = tmp();
            stub({ TRANSACTIONS_DATA_DIR: store, XDG_DATA_HOME: '/xdg/data' });
            applyPathEnv(tmp());
            expect(process.env.TRANSACTIONS_DATA_DIR).toBe(store);
        });

        await it('is idempotent', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' });
            const cwd = tmp();
            applyPathEnv(cwd);
            const first = process.env.STEUER_WORKSPACE;
            applyPathEnv(cwd);
            expect(process.env.STEUER_WORKSPACE).toBe(first);
        });

        await it('reports what it decided, for the first-run assistant to show', async () => {
            stub({ XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' });
            const result = applyPathEnv(tmp());
            expect(result.manifestPath).toBe('/xdg/cfg/steuererklaerung/steuererklaerung.json');
            expect(typeof result.dataDir).toBe('string');
        });
    });

    await describe('initManifest lands in a directory that does not exist yet', async () => {
        await it('creates the config directory on the way', async () => {
            // A fresh install has no ~/.config/steuererklaerung; initManifest must not fail on that.
            const root = tmp();
            const path = join(root, 'nested', 'deeper', 'steuererklaerung.json');
            const { initManifest, loadManifest } = await import('../../../src/core/config/index.ts');
            initManifest(path, { id: 'gbr', name: 'Muster GbR' });
            expect(loadManifest(path).entities[0].id).toBe('gbr');
        });

        await it('does not leave a directory behind when the manifest is rejected', async () => {
            const root = tmp();
            const path = join(root, 'nie-angelegt', 'steuererklaerung.json');
            const { initManifest } = await import('../../../src/core/config/index.ts');
            let threw = false;
            try {
                initManifest(path, { id: 'UNGÜLTIG', name: 'X' });
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            // mkdir runs AFTER validation, so a rejected id leaves the filesystem untouched.
            const { existsSync } = await import('node:fs');
            expect(existsSync(join(root, 'nie-angelegt'))).toBe(false);
        });

        await it('is happy when the directory already exists', async () => {
            const root = tmp();
            const dir = join(root, 'vorhanden');
            mkdirSync(dir, { recursive: true });
            const { initManifest } = await import('../../../src/core/config/index.ts');
            const m = initManifest(join(dir, 'steuererklaerung.json'), { id: 'gbr', name: 'X' });
            expect(m.entities.length).toBe(1);
        });
    });
};
