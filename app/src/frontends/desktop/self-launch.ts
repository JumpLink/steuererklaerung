/**
 * How this app starts a copy of itself for work that must not run on the GLib main loop — a
 * backup (`<app> backup`) — and what an external agent runs for `<app> mcp`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bundle this app runs from. */
export function bundlePath(): string {
    const self = fileURLToPath(import.meta.url);
    if (self.endsWith('.mjs')) return self;
    // Unbundled (tests, tooling): <app>/src/frontends/desktop → <app>/dist/app/steuer-app.gjs.mjs.
    return join(dirname(self), '..', '..', '..', 'dist', 'app', 'steuer-app.gjs.mjs');
}

/** The nearest `node_modules/.bin/gjsify` above the bundle — present only in a dev checkout. */
export function checkoutGjsify(bundle: string = bundlePath()): string | undefined {
    let dir = dirname(bundle);
    for (let up = 0; up < 6; up++) {
        const candidate = join(dir, 'node_modules', '.bin', 'gjsify');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

/**
 * The interpreter this process runs under — the packaged one on macOS, the runtime's in a Flatpak.
 * The typelib path a dev checkout needs (set by `gjsify run`) is in the environment the child
 * inherits, so the interpreter and the bundle are enough.
 */
function interpreter(): string {
    try {
        const first = readFileSync('/proc/self/cmdline', 'utf8').split('\0')[0];
        if (first) return first;
    } catch {
        // No /proc (macOS): fall back to PATH.
    }
    return 'gjs';
}

/** argv that runs this app's bundle with `args` instead of opening a window. */
export function selfCommand(args: string[]): string[] {
    return [interpreter(), '-m', bundlePath(), ...args];
}
