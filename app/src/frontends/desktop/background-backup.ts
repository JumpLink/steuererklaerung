/**
 * "Back up now" without freezing the window.
 *
 * A backup is synchronous all the way down — recursive copies and SQLite's `VACUUM INTO` — and on
 * a real store that takes seconds in which the GLib loop would draw nothing. So the app runs it in
 * a child process (`<app> backup`, see main.ts) and only waits for the result asynchronously. The
 * child takes the same per-user lock as the CLI and the pre-migration backup, so the runs never
 * overlap; closing the window does not abort a backup that is already being written.
 */

import Gio from '@girs/gio-2.0';

import { selfCommand } from './self-launch.ts';

export interface BackgroundBackupResult {
    path: string;
}

/** The line the child prints last on stdout; anything before it (library chatter) is ignored. */
export const BACKUP_RESULT_PREFIX = 'steuererklaerung-backup-result ';

let running: Promise<BackgroundBackupResult> | null = null;

export function isBackupRunning(): boolean {
    return running !== null;
}

/** Start a backup in a child process; a second call while one runs gets the same promise. */
export function runBackupInBackground(reason = 'manual'): Promise<BackgroundBackupResult> {
    running ??= spawnBackup(reason).finally(() => {
        running = null;
    });
    return running;
}

function spawnBackup(reason: string): Promise<BackgroundBackupResult> {
    return new Promise((resolve, reject) => {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        // The resolved workspace and demo redirection live in process.env — pass them on explicitly.
        launcher.set_environ(
            Object.entries(process.env)
                .filter((e): e is [string, string] => e[1] !== undefined)
                .map(([k, v]) => `${k}=${v}`),
        );
        let proc: Gio.Subprocess;
        try {
            proc = launcher.spawnv(selfCommand(['backup', reason]));
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        proc.communicate_utf8_async(null, null, (_p, res) => {
            let stdout = '';
            let stderr = '';
            try {
                const [, out, errText] = proc.communicate_utf8_finish(res);
                stdout = out ?? '';
                stderr = errText ?? '';
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            const line = stdout
                .split('\n')
                .reverse()
                .find((l) => l.startsWith(BACKUP_RESULT_PREFIX));
            if (line) {
                const parsed = JSON.parse(line.slice(BACKUP_RESULT_PREFIX.length)) as
                    | { ok: true; path: string }
                    | { ok: false; error: string };
                if (parsed.ok) resolve({ path: parsed.path });
                else reject(new Error(parsed.error));
                return;
            }
            const lastErr = stderr
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .at(-1);
            reject(new Error(lastErr ?? `exit ${proc.get_exit_status()}`));
        });
    });
}
