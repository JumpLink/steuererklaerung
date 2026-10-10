/**
 * Per-user settings and the welcome decision — above all, the ALTBESTAND case.
 *
 * The welcome flow is for a person who has never used the app. Everyone who used it before the
 * welcome existed has no settings file at all, so "no settings" alone would greet them with an
 * introduction instead of their data. What protects them is the manifest: if one resolves — under
 * the current name OR the pre-rename `buchhaltung.json` that `getManifestPath()` still falls back
 * to — there is no welcome. These tests pin that, mirroring `rename-fallback.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    LEGACY_MANIFEST_FILENAME,
    MANIFEST_FILENAME,
    getManifestPath,
    resetConfigNotices,
} from '../../../src/core/config/manifest.ts';
import {
    DEFAULT_BACKUP_KEEP,
    SETTINGS_APP_ID,
    defaultBackupRoot,
    loadUserSettings,
    saveUserSettings,
    shouldShowWelcome,
    updateUserSettings,
    userSettingsPath,
} from '../../../src/core/config/user-settings.ts';

function v1Manifest(): string {
    return JSON.stringify({
        version: 1,
        entities: [{ id: 'gbr', name: 'Muster & Partner GbR', kind: 'gbr', accounts: [] }],
    });
}

/** Silence the expected stderr notices (rename fallback, broken settings file). */
function quiet<T>(fn: () => T): T {
    const original = console.error;
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.error = original;
    }
}

export default async () => {
    await describe('user settings — store', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'user-settings-'));
            vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'));
            vi.stubEnv('XDG_DATA_HOME', join(dir, 'data'));
        });
        afterEach(() => {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('lives under XDG_CONFIG_HOME/<canonical app id>, backups under XDG_DATA_HOME', async () => {
            expect(userSettingsPath()).toBe(join(dir, 'config', SETTINGS_APP_ID, 'settings.json'));
            expect(defaultBackupRoot()).toBe(join(dir, 'data', SETTINGS_APP_ID, 'backups'));
        });

        await it('a missing file yields the defaults and creates nothing', async () => {
            const s = loadUserSettings();
            expect(s.welcomeCompleted).toBe(false);
            expect(s.preferredMode).toBeUndefined();
            expect(s.aiAssistant).toBeUndefined();
            expect(s.backup.keep).toBe(DEFAULT_BACKUP_KEEP);
            expect(existsSync(userSettingsPath())).toBe(false);
        });

        await it('writes 0600 in a 0700 directory and round-trips', async () => {
            updateUserSettings((s) => {
                s.welcomeCompleted = true;
                s.preferredMode = 'demo';
                s.aiAssistant = false;
                s.backup.keep = 3;
            });
            const path = userSettingsPath();
            expect(statSync(path).mode & 0o777).toBe(0o600);
            expect(statSync(join(dir, 'config', SETTINGS_APP_ID)).mode & 0o777).toBe(0o700);
            const s = loadUserSettings();
            expect(s.welcomeCompleted).toBe(true);
            expect(s.preferredMode).toBe('demo');
            expect(s.aiAssistant).toBe(false);
            expect(s.backup.keep).toBe(3);
            expect(existsSync(`${path}.tmp`)).toBe(false);
        });

        await it('a broken file falls back to the defaults instead of throwing', async () => {
            saveUserSettings(loadUserSettings());
            writeFileSync(userSettingsPath(), '{ not json');
            const s = quiet(() => loadUserSettings());
            expect(s.welcomeCompleted).toBe(false);
        });

        await it('keeps unknown keys from a newer version', async () => {
            saveUserSettings(loadUserSettings());
            const raw = JSON.parse(readFileSync(userSettingsPath(), 'utf-8'));
            raw.futureKey = 42;
            writeFileSync(userSettingsPath(), JSON.stringify(raw));
            updateUserSettings((s) => {
                s.welcomeCompleted = true;
            });
            expect(JSON.parse(readFileSync(userSettingsPath(), 'utf-8')).futureKey).toBe(42);
        });
    });

    await describe('welcome — shown to new people only (Altbestand protection)', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'welcome-altbestand-'));
            resetConfigNotices();
            vi.stubEnv('STEUER_WORKSPACE', undefined);
            vi.stubEnv('BUCHHALTUNG_WORKSPACE', undefined);
            vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'));
        });
        afterEach(() => {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
            resetConfigNotices();
        });

        await it('fresh install: no settings, no manifest → welcome', async () => {
            expect(shouldShowWelcome(loadUserSettings(), getManifestPath(dir))).toBe(true);
        });

        await it('existing steuererklaerung.json, no settings file → NO welcome', async () => {
            writeFileSync(join(dir, MANIFEST_FILENAME), v1Manifest());
            expect(shouldShowWelcome(loadUserSettings(), getManifestPath(dir))).toBe(false);
        });

        await it('pre-rename buchhaltung.json only, no settings file → NO welcome', async () => {
            writeFileSync(join(dir, LEGACY_MANIFEST_FILENAME), v1Manifest());
            const path = quiet(() => getManifestPath(dir));
            expect(path).toBe(join(dir, LEGACY_MANIFEST_FILENAME));
            expect(shouldShowWelcome(loadUserSettings(), path)).toBe(false);
        });

        await it('a manifest via STEUER_WORKSPACE / BUCHHALTUNG_WORKSPACE → NO welcome', async () => {
            const elsewhere = join(dir, 'elsewhere.json');
            writeFileSync(elsewhere, v1Manifest());
            vi.stubEnv('STEUER_WORKSPACE', elsewhere);
            expect(shouldShowWelcome(loadUserSettings(), getManifestPath(dir))).toBe(false);
            vi.stubEnv('STEUER_WORKSPACE', undefined);
            vi.stubEnv('BUCHHALTUNG_WORKSPACE', elsewhere);
            expect(
                shouldShowWelcome(
                    loadUserSettings(),
                    quiet(() => getManifestPath(dir)),
                ),
            ).toBe(false);
        });

        await it('welcome completed → never again, even without a manifest', async () => {
            updateUserSettings((s) => {
                s.welcomeCompleted = true;
            });
            expect(shouldShowWelcome(loadUserSettings(), getManifestPath(dir))).toBe(false);
        });

        await it('„Later" → not on the next launch either, without completing it', async () => {
            updateUserSettings((s) => {
                s.welcomeDeferred = true;
            });
            const s = loadUserSettings();
            expect(s.welcomeCompleted).toBe(false);
            expect(shouldShowWelcome(s, getManifestPath(dir))).toBe(false);
        });

        await it('deciding about the welcome never touches the manifest location', async () => {
            shouldShowWelcome(loadUserSettings(), getManifestPath(dir));
            expect(existsSync(join(dir, MANIFEST_FILENAME))).toBe(false);
            expect(existsSync(join(dir, LEGACY_MANIFEST_FILENAME))).toBe(false);
        });
    });
};
