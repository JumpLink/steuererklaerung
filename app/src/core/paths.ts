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
import { join } from 'node:path';

import { getStoreDir } from '@steuererklaerung/store';
import { LEGACY_MANIFEST_FILENAME, MANIFEST_FILENAME } from './config/manifest.ts';

/** Directory name used under both XDG roots. */
export const APP_DIR_NAME = 'steuererklaerung';

/** `$XDG_CONFIG_HOME`, or the specified fallback `~/.config`. A relative value is ignored, per spec. */
export function xdgConfigHome(): string {
    const env = process.env.XDG_CONFIG_HOME;
    return env?.startsWith('/') ? env : join(homedir(), '.config');
}

/** `$XDG_DATA_HOME`, or the specified fallback `~/.local/share`. */
export function xdgDataHome(): string {
    const env = process.env.XDG_DATA_HOME;
    return env?.startsWith('/') ? env : join(homedir(), '.local', 'share');
}

/** `~/.config/steuererklaerung` — where a fresh installation keeps its manifest. */
export function userConfigDir(): string {
    return join(xdgConfigHome(), APP_DIR_NAME);
}

/** `~/.local/share/steuererklaerung` — where a fresh installation keeps its store, ledger and Belege. */
export function userDataDir(): string {
    return join(xdgDataHome(), APP_DIR_NAME);
}

/** The manifest path a fresh installation should create and use. */
export function defaultManifestPath(): string {
    return join(userConfigDir(), MANIFEST_FILENAME);
}

/** The data directory a fresh installation should use. */
export function defaultDataDir(): string {
    return join(userDataDir(), 'transactions-data');
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
