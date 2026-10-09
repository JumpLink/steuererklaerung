/**
 * Restarting the app into the other data mode (demo ↔ own data).
 *
 * Demo mode is decided once, at process start, by redirecting the config/store env vars
 * (`applyDemoEnv`). Switching it inside a running process would mean re-pointing a store, a ledger
 * and every open view at another workspace — exactly the "data gets mixed" failure the switch must
 * rule out. So the switch quits and starts a fresh process instead.
 *
 * The new process gets the environment as it was BEFORE demo/path resolution touched it
 * ({@link snapshotLaunchEnv}), so it resolves its paths from scratch. It waits for this process to
 * be gone first: the application id is single-instance, and a second process started while the
 * first still owns the D-Bus name would only remote-activate it and exit.
 */

import { readFileSync } from 'node:fs';

import Gio from '@girs/gio-2.0';

import { updateUserSettings } from '../../core/config/user-settings.ts';

let launchEnv: Record<string, string> | undefined;
let launchArgv: string[] | undefined;
let pending = false;

/** Record the environment and command line as launched. Call before `applyDemoEnv()`. */
export function snapshotLaunchEnv(): void {
    launchEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) launchEnv[key] = value;
    }
    launchArgv = readOwnCommandLine();
}

function readOwnCommandLine(): string[] | undefined {
    try {
        const parts = readFileSync('/proc/self/cmdline', 'utf8').split('\0');
        if (parts.at(-1) === '') parts.pop();
        return parts.length > 0 ? parts : undefined;
    } catch {
        return undefined;
    }
}

/** Whether this process can start a successor at all (Linux with `/proc`). */
export function canRestart(): boolean {
    return launchArgv !== undefined;
}

/**
 * Ask for a restart with these env changes (`undefined` removes a variable), then quit `app`.
 * The successor is started by {@link relaunchIfRequested} once the main loop has returned.
 */
export function requestRestart(app: Gio.Application, env: Record<string, string | undefined>): void {
    if (!launchEnv || !launchArgv) return;
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete launchEnv[key];
        else launchEnv[key] = value;
    }
    // A `--demo` flag on the original command line would outvote a switch to own data.
    if ('STEUER_DEMO' in env && env.STEUER_DEMO === undefined)
        launchArgv = launchArgv.filter((arg) => arg !== '--demo');
    pending = true;
    app.quit();
}

/** Remember `mode` as the person's choice and restart into it. */
export function restartInMode(app: Gio.Application, mode: 'demo' | 'own'): void {
    updateUserSettings((settings) => {
        settings.preferredMode = mode;
    });
    requestRestart(app, mode === 'demo' ? { STEUER_DEMO: '1' } : { STEUER_DEMO: undefined, BH_DEMO: undefined });
}

/** Start the successor requested by {@link requestRestart}, if any. Call after the main loop ends. */
export function relaunchIfRequested(): void {
    if (!pending || !launchEnv || !launchArgv) return;
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
    launcher.set_environ(Object.entries(launchEnv).map(([key, value]) => `${key}=${value}`));
    // `sh` outlives us, polls until our pid is gone, then becomes the new app.
    launcher.spawnv([
        'sh',
        '-c',
        'while kill -0 "$0" 2>/dev/null; do sleep 0.1; done; exec "$@"',
        String(process.pid),
        ...launchArgv,
    ]);
}
