/**
 * Demo mode — run every surface (CLI, web, native app) against the isolated, shipped-with-the-repo
 * demo workspace under `app/demo/` instead of the user's real financial data.
 *
 * Activated by `STEUER_DEMO=1` (or a `--demo` CLI flag). All it does is REDIRECT the config/store path
 * env vars at process start — the consolidated `steuererklaerung.json` manifest, the NDJSON store dir and
 * the ledger DB — so the fictional "Fischer & Weber GbR" data lives entirely under `app/demo/` and
 * never mixes with real data. Real usage (no flag) is the unchanged default.
 *
 * MUST be called once at process entry, BEFORE any config or store is read. Each already-set env var
 * is respected (never overwritten), so an explicit override — or the MCP registration's own
 * STEUER_WORKSPACE — still wins.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether demo mode is requested: `STEUER_DEMO` truthy, or a `--demo` flag on the command line.
 * `BH_DEMO` was the variable's name before the rename to `steuererklaerung` and is still honoured —
 * it is documented in older READMEs and may sit in a shell profile or a launcher.
 */
export function isDemoMode(): boolean {
    const env = process.env.STEUER_DEMO ?? process.env.BH_DEMO;
    if (env === '1' || env === 'true') return true;
    return process.argv.includes('--demo');
}

/**
 * The shipped demo workspace directory (`<app>/demo`), found by walking UP from this module.
 *
 * It used to count directory levels — `dist/` meant up 1, source meant up 3 — and that broke the
 * moment the app bundle moved from `dist/` to `dist/app/` so packaging would stop shipping the
 * test bundles. The demo then resolved to `<app>/dist/demo`, which does not exist, and demo mode
 * silently became first-run mode: the assistant opened where the sample data should have been.
 *
 * A fixed depth is a claim about a layout nobody promised to keep. Searching for the directory
 * that is actually there survives the next move — and there IS no next move to remember.
 */
export function demoDir(): string {
    // A copy elsewhere wins when it really is a demo workspace — the E2E runs point here so a run
    // never seeds or migrates the demo that is checked into the repository.
    const override = process.env.STEUER_DEMO_DIR;
    if (override && existsSync(join(override, 'steuererklaerung.json'))) return override;
    let dir = dirname(fileURLToPath(import.meta.url));
    // Bounded: `<app>/src/core/config` is three up, `<app>/dist/app` is two. Six is room to spare
    // without ever climbing out of the project into somebody else's `demo/`.
    for (let up = 0; up < 6; up++) {
        const candidate = join(dir, 'demo');
        if (existsSync(join(candidate, 'steuererklaerung.json'))) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }
    // Nothing found: report the conventional location so the error names a path a person can look
    // at, rather than an empty string.
    return join(dirname(dirname(fileURLToPath(import.meta.url))), 'demo');
}

/**
 * If demo mode is on, point the config/store env vars at `app/demo/` (each only when unset).
 * No-op when demo mode is off. Safe to call more than once.
 */
export function applyDemoEnv(): void {
    if (!isDemoMode()) return;
    const dir = demoDir();
    // Normalise the switch so downstream detection (banner, meta) sees STEUER_DEMO even for `--demo`.
    process.env.STEUER_DEMO ??= '1';
    process.env.STEUER_WORKSPACE ??= join(dir, 'steuererklaerung.json');
    process.env.TRANSACTIONS_DATA_DIR ??= join(dir, 'transactions-data');
    // Always the demo ledger unless LEDGER_DB_PATH is set explicitly: left to `getStoreDir()` it would
    // follow a TRANSACTIONS_DATA_DIR that points at the real store.
    process.env.LEDGER_DB_PATH ??= join(dir, 'ledger.db');
}
