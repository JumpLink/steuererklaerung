/**
 * How this app starts a copy of itself for work that must not run on the GLib main loop — a
 * backup (`<app> backup`) — and what an external agent runs for `<app> mcp`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import GLib from '@girs/glib-2.0';

import { packageLauncher, type McpInstallation, type McpPlatform } from '../../core/actions/mcp-clients.ts';
import { isDemoMode } from '../../core/config/demo.ts';
import { getManifestPath } from '../../core/config/manifest.ts';

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

/**
 * argv that runs this app's bundle with `args` instead of opening a window. The Windows and macOS
 * packages run under node, which takes the bundle as a plain script path (no `-m`).
 */
export function selfCommand(args: string[], gjs: boolean = isGjsRuntime()): string[] {
    return gjs ? [interpreter(), '-m', bundlePath(), ...args] : [process.execPath, bundlePath(), ...args];
}

// `imports` alone is not enough: @gjsify/node-gi defines it under node too (the Windows and macOS
// packages), and that sent the backup to a `gjs` that is not installed there. Same probe as node-gi.
function isGjsRuntime(): boolean {
    const g = globalThis as { imports?: unknown; print?: unknown };
    return typeof g.imports !== 'undefined' && typeof g.print === 'function';
}

/** The one place `process.platform` is read for the MCP guide; everything below takes it as input. */
export function currentMcpPlatform(): McpPlatform {
    return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

/**
 * How THIS installation's MCP server is started — the facts `resolveMcpLaunch` turns into a
 * command. One answer for both callers: the snippets an external client is handed, and the
 * read-only server the assistant pane starts for its own agent.
 */
export function currentMcpInstallation(): McpInstallation {
    const platform = currentMcpPlatform();
    const onPath = platform === 'linux' ? GLib.find_program_in_path('steuererklaerung') : null;
    return {
        platform,
        flatpakId: process.env.FLATPAK_ID || undefined,
        appImage: process.env.APPIMAGE || undefined,
        installedBinary: packageLauncher(platform, process.execPath, existsSync) ?? onPath ?? undefined,
        nodeBin: platform === 'linux' ? undefined : process.execPath,
        bundlePath: bundlePath(),
        gjsifyBin: checkoutGjsify(bundlePath()),
        manifestPath: getManifestPath(),
        demo: isDemoMode(),
    };
}
