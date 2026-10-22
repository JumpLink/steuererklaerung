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

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    launchArgv = ownCommandLine();
}

/**
 * The command that starts this app again. Linux reads `/proc`; Windows has none, but the program
 * directory holds the launcher (`steuererklaerung.exe`) next to the `node.exe` this runs under, and
 * the launcher needs no arguments beyond the user's own.
 *
 * macOS has no `/proc` either. Under node (the `.app`) `execPath` and `argv` are the whole command:
 * the `.app` launcher only exports variables, which are in the snapshot already. Under GJS there is
 * no honest answer — see {@link relaunchesThroughNode} — so the app asks for a manual restart.
 */
export function ownCommandLine(
    platform: string = process.platform,
    execPath: string = process.execPath,
    argv: string[] = process.argv,
    exists: (path: string) => boolean = existsSync,
    gjs: boolean = isGjsRuntime(),
): string[] | undefined {
    if (platform === 'win32') {
        const launcher = join(dirname(execPath), 'steuererklaerung.exe');
        return exists(launcher) ? [launcher, ...argv.slice(2)] : undefined;
    }
    if (platform === 'darwin') return gjs ? undefined : [execPath, ...argv.slice(1)];
    try {
        const parts = readFileSync('/proc/self/cmdline', 'utf8').split('\0');
        if (parts.at(-1) === '') parts.pop();
        return parts.length > 0 ? parts : undefined;
    } catch {
        return undefined;
    }
}

// A throwaway node waits for our pid, then starts the successor — see {@link relaunchesThroughNode}.
const WAIT_THEN_START =
    'const p=+process.argv[1];const t=setInterval(()=>{try{process.kill(p,0)}catch{clearInterval(t);' +
    "require('child_process').spawn(process.argv[2],process.argv.slice(3),{detached:true,stdio:'ignore'}).unref()}},100)";

/** Whether this process can start a successor at all (Linux with `/proc`, Windows with the launcher). */
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

/**
 * Remember `mode` as the person's choice, so the next launch opens in it. Also when this process
 * cannot restart itself: "please restart the app yourself" is only true advice if the restart
 * then lands in the mode that was picked.
 */
export function rememberMode(mode: 'demo' | 'own'): void {
    updateUserSettings((settings) => {
        settings.preferredMode = mode;
    });
}

/** Remember `mode` as the person's choice and restart into it. */
export function restartInMode(app: Gio.Application, mode: 'demo' | 'own'): void {
    rememberMode(mode);
    requestRestart(app, mode === 'demo' ? { STEUER_DEMO: '1' } : { STEUER_DEMO: undefined, BH_DEMO: undefined });
}

/** Start the successor requested by {@link requestRestart}, if any. Call after the main loop ends. */
export function relaunchIfRequested(): void {
    if (!pending || !launchEnv || !launchArgv) return;
    if (relaunchesThroughNode()) {
        spawn(process.execPath, ['-e', WAIT_THEN_START, String(process.pid), ...launchArgv], {
            env: launchEnv,
            detached: true,
            stdio: 'ignore',
        }).unref();
        return;
    }
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

/**
 * Whether the successor is started by a throwaway node rather than `sh`. Windows has no `sh` and no
 * `kill -0`. macOS has both, but `/bin/sh` is SIP-protected and drops every `DYLD_*` variable on
 * exec, while the `.app` has re-exec'd itself with `DYLD_FALLBACK_LIBRARY_PATH` pointing at its GTK
 * and `GJSIFY_GTK_REEXEC` set so it does not do so twice: through `sh` the successor would start
 * with the marker and without the path. Node is not protected, so it passes both on.
 */
export function relaunchesThroughNode(platform: string = process.platform, gjs: boolean = isGjsRuntime()): boolean {
    return platform === 'win32' || (platform === 'darwin' && !gjs);
}

// gjsify's process shim on GJS reports `versions.gjs`; node's own process never does.
function isGjsRuntime(): boolean {
    return typeof (process.versions as Record<string, string | undefined>).gjs === 'string';
}
