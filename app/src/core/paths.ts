/**
 * Where a FRESH installation keeps its config and data — and nothing else.
 *
 * Every path in the app is derived from `process.cwd()` (the manifest) or from the module's own
 * location (the transaction store, and through it the ledger and the built-in DMS). Both are
 * correct for the way this has always been run — a developer in `app/`, an MCP server whose
 * registration sets `cwd` — and both fall over the moment someone launches the *installed* app from
 * the GNOME overview, where the working directory is `/` or `$HOME` and the module sits under
 * `/usr/lib`. The app then reports "kein Manifest gefunden" with no way forward.
 *
 * This module is deliberately **strictly additive**. It does not re-implement the existing
 * resolution and it never redirects an installation that already resolves to something: it only
 * supplies a home for the case where today's lookup finds nothing at all. Concretely,
 * {@link applyPathEnv} sets an environment variable only when
 *
 *   - no explicit override is set, AND
 *   - the existing lookup comes up empty.
 *
 * That ordering matters for two things that are easy to break:
 *
 *   - **The rename fallback stays intact.** `getManifestPath()` prints a one-time notice when it
 *     reads the pre-rename `buchhaltung.json`. Setting `STEUER_WORKSPACE` to that path would take
 *     the override branch and swallow the notice, so we leave the cwd case entirely alone.
 *   - **An existing store is never orphaned.** The store's own default is MODULE-relative, not
 *     cwd-relative, so it resolves for a developer from any directory in the repo. We ask the store
 *     where it would look and only step in when nothing is there.
 *
 * XDG is read from the environment rather than GLib: this is imported by the CLI, the MCP server
 * and the tests, which run on Node as well as GJS, and the values are identical either way.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

import { getStoreDir } from '@steuererklaerung/store';
import { LEGACY_MANIFEST_FILENAME, MANIFEST_FILENAME } from './config/manifest.ts';

/** Directory name used under both XDG roots. */
export const APP_DIR_NAME = 'steuererklaerung';

/** What decides a root: injectable so the Windows and macOS branches are testable on Linux. */
export interface PathContext {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    home?: string;
}

/**
 * Per-user root for `kind`. Linux (and anything else) keeps the XDG rule, byte for byte: absolute
 * `$XDG_*_HOME`, else `~/.config` / `~/.local/share`. Windows asks where GLib would — `%APPDATA%`
 * for config, `%LOCALAPPDATA%` for data — and macOS uses `~/Library/Application Support`; before,
 * those platforms got a Unix-style `~/.local/share` under the profile. XDG variables still win
 * there when set to an absolute path, so a deliberate override keeps working.
 */
function userRoot(kind: 'config' | 'data', ctx: PathContext): string {
    const platform = ctx.platform ?? process.platform;
    const env = ctx.env ?? process.env;
    const home = ctx.home ?? homedir();
    const xdg = env[kind === 'config' ? 'XDG_CONFIG_HOME' : 'XDG_DATA_HOME'];
    if (platform === 'win32') {
        if (xdg && win32.isAbsolute(xdg)) return xdg;
        const base = kind === 'config' ? env.APPDATA : env.LOCALAPPDATA;
        return base || win32.join(home, 'AppData', kind === 'config' ? 'Roaming' : 'Local');
    }
    if (xdg?.startsWith('/')) return xdg;
    if (platform === 'darwin') return join(home, 'Library', 'Application Support');
    return kind === 'config' ? join(home, '.config') : join(home, '.local', 'share');
}

/** `$XDG_CONFIG_HOME`, or the platform's per-user config root. A relative value is ignored, per spec. */
export function xdgConfigHome(ctx: PathContext = {}): string {
    return userRoot('config', ctx);
}

/** `$XDG_DATA_HOME`, or the platform's per-user data root. */
export function xdgDataHome(ctx: PathContext = {}): string {
    return userRoot('data', ctx);
}

/** Join with the separator of the platform being described, not of the one running the tests. */
export function joinFor(ctx: PathContext, ...parts: string[]): string {
    return (ctx.platform ?? process.platform) === 'win32' ? win32.join(...parts) : join(...parts);
}

/**
 * A path the way it should appear on screen: the home directory collapsed to `~`. Status rows and
 * notices would otherwise carry the user name of whoever is logged in — into every screenshot too.
 */
export function displayPath(path: string, ctx: PathContext = {}): string {
    const home = ctx.home ?? homedir();
    if (!home || home === '/') return path;
    if (path === home) return '~';
    const sep = (ctx.platform ?? process.platform) === 'win32' ? '\\' : '/';
    const prefix = home.endsWith(sep) ? home : home + sep;
    return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/** `~/.config/steuererklaerung` — where a fresh installation keeps its manifest. */
export function userConfigDir(ctx: PathContext = {}): string {
    return joinFor(ctx, xdgConfigHome(ctx), APP_DIR_NAME);
}

/** `~/.local/share/steuererklaerung` — where a fresh installation keeps its store, ledger and Belege. */
export function userDataDir(ctx: PathContext = {}): string {
    return joinFor(ctx, xdgDataHome(ctx), APP_DIR_NAME);
}

/** The manifest path a fresh installation should create and use. */
export function defaultManifestPath(ctx: PathContext = {}): string {
    return joinFor(ctx, userConfigDir(ctx), MANIFEST_FILENAME);
}

/** The data directory a fresh installation should use. */
export function defaultDataDir(ctx: PathContext = {}): string {
    return joinFor(ctx, userDataDir(ctx), 'transactions-data');
}

/**
 * True when a manifest is reachable without our help — an override, or either filename in `cwd`.
 * Both names are checked: an installation from before the rename has its ONLY copy under
 * `buchhaltung.json`, and stepping over it would start a second, empty configuration beside the
 * real one.
 */
function manifestAlreadyResolves(cwd: string): boolean {
    if (process.env.STEUER_WORKSPACE || process.env.BUCHHALTUNG_WORKSPACE) return true;
    return [MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME].some((name) => existsSync(join(cwd, name)));
}

/**
 * Publish a home for a fresh installation into the environment — each variable only when it is
 * both unset AND the existing lookup finds nothing.
 *
 * The environment is the seam because the transaction store lives in its own package and reads
 * `TRANSACTIONS_DATA_DIR`; there is no other way to hand it a value without the package reaching
 * back across the boundary. Same shape as `applyDemoEnv()`, and it must run AFTER that one so demo
 * mode still wins. Idempotent.
 *
 * Returns what it decided, so a caller (the first-run assistant) can say where things will go.
 */
export function applyPathEnv(cwd: string = process.cwd()): { manifestPath: string; dataDir: string } {
    if (!manifestAlreadyResolves(cwd)) {
        process.env.STEUER_WORKSPACE = defaultManifestPath();
    }
    // Ask the store where it WOULD look; only step in when that place does not exist yet.
    if (!process.env.TRANSACTIONS_DATA_DIR && !existsSync(getStoreDir())) {
        process.env.TRANSACTIONS_DATA_DIR = defaultDataDir();
    }
    return {
        manifestPath: process.env.STEUER_WORKSPACE ?? join(cwd, MANIFEST_FILENAME),
        dataDir: getStoreDir(),
    };
}
