/**
 * Per-user app settings — how THIS person wants the app to behave, as opposed to the manifest,
 * which describes their businesses.
 *
 * The two are kept apart on purpose. The manifest is tax master data: it may sit in a project
 * directory, be shared by the CLI, the MCP server and the web UI, and a write to it is a write to
 * someone's Steuernummern. Whether the welcome was seen, whether the app starts in demo mode or
 * where backups go is none of that — and the welcome flow runs BEFORE a manifest exists, so it has
 * nowhere else to write. Only the setup assistant creates the manifest.
 *
 * Location: `$XDG_CONFIG_HOME/eu.jumplink.Steuererklaerung/settings.json`. The directory carries the
 * canonical application id, not `STEUER_APP_ID`: that override exists so a test instance can own a
 * separate D-Bus name, and following it would scatter one person's preferences across ids. A test
 * isolates through `XDG_CONFIG_HOME` instead.
 *
 * The file holds no secrets, but it does name a backup folder, so it is written 0600 inside a 0700
 * directory, atomically (tmp + rename) like the manifest. Reading never throws: a missing or broken
 * file yields the defaults, and a broken one says so on stderr rather than locking the person out
 * of their app over a preference.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { xdgConfigHome, xdgDataHome } from '../paths.ts';
import { getManifestPath } from './manifest.ts';

/** The canonical application id — the settings directory name. */
export const SETTINGS_APP_ID = 'eu.jumplink.Steuererklaerung';

export const USER_SETTINGS_VERSION = 1;

/** How many backups are kept when the person has not chosen. */
export const DEFAULT_BACKUP_KEEP = 10;

const BackupSettingsSchema = z
    .object({
        /** Absolute target folder; unset = {@link defaultBackupRoot}. */
        dir: z.string().optional(),
        /** Keep the newest N backups, delete older ones after a successful backup. */
        keep: z.number().int().min(1).max(1000).default(DEFAULT_BACKUP_KEEP),
        /** ISO timestamp of the last successful backup. */
        lastAt: z.string().optional(),
        /** Folder the last successful backup was written to. */
        lastPath: z.string().optional(),
    })
    .default({ keep: DEFAULT_BACKUP_KEEP });

export const UserSettingsSchema = z.looseObject({
    version: z.literal(USER_SETTINGS_VERSION).default(USER_SETTINGS_VERSION),
    /** The welcome flow was finished or skipped. */
    welcomeCompleted: z.boolean().default(false),
    /** What the app starts with when no flag or env decides: the sample data or the person's own. */
    preferredMode: z.enum(['demo', 'own']).optional(),
    /**
     * Explicit AI opt-in from the welcome or Settings. UNSET means "never asked" and keeps the
     * behaviour from before this setting existed (assistant available); only an explicit `false`
     * hides it. Existing installations therefore change nothing until the person decides.
     */
    aiAssistant: z.boolean().optional(),
    backup: BackupSettingsSchema,
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

/** `$XDG_CONFIG_HOME/eu.jumplink.Steuererklaerung/settings.json`. */
export function userSettingsPath(): string {
    return join(xdgConfigHome(), SETTINGS_APP_ID, 'settings.json');
}

/** Where backups go unless the person picks a folder: `$XDG_DATA_HOME/eu.jumplink.Steuererklaerung/backups`. */
export function defaultBackupRoot(): string {
    return join(xdgDataHome(), SETTINGS_APP_ID, 'backups');
}

/** The defaults — what a person who never opened Settings has. */
export function defaultUserSettings(): UserSettings {
    return UserSettingsSchema.parse({});
}

/** Read the settings; a missing or unreadable file yields the defaults (never throws). */
export function loadUserSettings(path: string = userSettingsPath()): UserSettings {
    if (!existsSync(path)) return defaultUserSettings();
    try {
        const parsed = UserSettingsSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
        if (parsed.success) return parsed.data;
        console.error(`[settings] ${path} ist ungültig — es gelten die Voreinstellungen: ${parsed.error.message}`);
    } catch (err) {
        console.error(
            `[settings] ${path} konnte nicht gelesen werden — es gelten die Voreinstellungen: ` +
                (err instanceof Error ? err.message : String(err)),
        );
    }
    return defaultUserSettings();
}

/** Write the whole settings object atomically: 0700 directory, 0600 file. */
export function saveUserSettings(settings: UserSettings, path: string = userSettingsPath()): void {
    const valid = UserSettingsSchema.parse(settings);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

/** Read-modify-write: `mutate` changes a fresh copy, which is validated and saved. Returns it. */
export function updateUserSettings(
    mutate: (settings: UserSettings) => void,
    path: string = userSettingsPath(),
): UserSettings {
    const settings = loadUserSettings(path);
    mutate(settings);
    saveUserSettings(settings, path);
    return loadUserSettings(path);
}

/**
 * Whether the app should open the welcome flow on launch.
 *
 * Only for a genuinely NEW person: the welcome was never completed AND no manifest resolves. The
 * second half is what protects existing installations — anyone who already has a
 * `steuererklaerung.json`, or the pre-rename `buchhaltung.json` that {@link getManifestPath} still
 * falls back to, has been using the app since before the welcome existed and has no settings file
 * at all. They must land in their data, not in an introduction.
 */
export function shouldShowWelcome(
    settings: UserSettings = loadUserSettings(),
    manifestPath: string = getManifestPath(),
): boolean {
    if (settings.welcomeCompleted) return false;
    return !existsSync(manifestPath);
}
