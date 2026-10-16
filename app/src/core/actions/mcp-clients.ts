/**
 * How an external agent starts this installation's MCP server — and the config snippet each client
 * wants for it. Behind the desktop's "Connect an external agent" dialog and docs/app/mcp-clients.md.
 *
 * The launch is the one thing that differs per installation: a Flatpak runs through `flatpak run`,
 * a package ships a launcher on PATH, a dev checkout only has the bundle `gjs -m` loads. The
 * workspace goes along explicitly (STEUER_WORKSPACE), because the client starts the server from
 * its own working directory, where no manifest lies.
 *
 * Pure: no disk, no GTK. The caller resolves the installation; this module only formats.
 */

import { posix, win32 } from 'node:path';

import { MCP_READONLY_ENV } from '../config/mcp-readonly.ts';

/** Name the server is registered under in every client. */
export const MCP_SERVER_NAME = 'steuererklaerung';

/** What a client runs: one program, its arguments, extra environment. */
export interface McpLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

/** The operating systems the app ships for — `process.platform`'s spelling, resolved by the caller. */
export type McpPlatform = 'linux' | 'darwin' | 'win32';

/** The facts about the running installation the launch depends on. */
export interface McpInstallation {
    /** Default `linux`. Decides the quoting and the config paths, never read from the process here. */
    platform?: McpPlatform;
    /** `$APPIMAGE`: the AppImage file itself — the bundle's mount path is gone after the next start. */
    appImage?: string;
    /**
     * The interpreter a Windows/macOS package runs under (`process.execPath`), absolute. Only for
     * a package without a launcher beside it: `<node> <bundle> mcp`, like `selfCommand()`.
     */
    nodeBin?: string;
    /** `FLATPAK_ID` when the app runs sandboxed. */
    flatpakId?: string;
    /**
     * The launcher the package ships, absolute: on PATH for deb/rpm, `steuererklaerung.exe` in the
     * Windows program directory, `Contents/MacOS/steuererklaerung` in the `.app`.
     */
    installedBinary?: string;
    /** The bundle the app runs from, absolute — the fallback when there is neither. */
    bundlePath: string;
    /**
     * The checkout's `gjsify` binary, absolute. A bare `gjs -m <bundle>` fails in a dev checkout:
     * the native bridges' typelibs live under node_modules, and only `gjsify run` puts them on
     * GI_TYPELIB_PATH.
     */
    gjsifyBin?: string;
    /** The manifest the app currently uses. */
    manifestPath: string;
    demo: boolean;
    /**
     * Force the server read-only, whatever `mcp.allowWrite` says. For a server the APP starts for
     * an agent of its own — never for the snippets, where the person configured the client by hand
     * and their write decision is theirs. Default false, so those stay byte-identical.
     */
    readOnly?: boolean;
}

/**
 * The launcher a Windows or macOS package puts beside its interpreter: `steuererklaerung.exe` in
 * the program directory, `Contents/MacOS/steuererklaerung` in the `.app` (gjsify ship layouts).
 * Undefined on Linux, where the launcher is on PATH or the AppImage, and when the file is missing.
 */
export function packageLauncher(
    platform: McpPlatform,
    execPath: string,
    exists: (path: string) => boolean,
    binaryName: string = 'steuererklaerung',
): string | undefined {
    if (platform === 'linux') return undefined;
    const path = platform === 'win32' ? win32 : posix;
    const candidate = path.join(path.dirname(execPath), platform === 'win32' ? `${binaryName}.exe` : binaryName);
    return exists(candidate) ? candidate : undefined;
}

export function resolveMcpLaunch(inst: McpInstallation): McpLaunch {
    const env: Record<string, string> = { STEUER_WORKSPACE: inst.manifestPath };
    if (inst.demo) env.STEUER_DEMO = '1';
    if (inst.readOnly) env[MCP_READONLY_ENV] = '1';
    if (inst.flatpakId) {
        // `--env=` instead of the client's env block: flatpak run filters the caller's environment,
        // the flag is the documented way into the sandbox.
        const flags = Object.entries(env).map(([k, v]) => `--env=${k}=${v}`);
        return { command: 'flatpak', args: ['run', ...flags, inst.flatpakId, 'mcp'], env: {} };
    }
    if (inst.appImage) return { command: inst.appImage, args: ['mcp'], env };
    if (inst.installedBinary) return { command: inst.installedBinary, args: ['mcp'], env };
    if (inst.nodeBin) return { command: inst.nodeBin, args: [inst.bundlePath, 'mcp'], env };
    if (inst.gjsifyBin) return { command: inst.gjsifyBin, args: ['run', inst.bundlePath, 'mcp'], env };
    return { command: 'gjs', args: ['-m', inst.bundlePath, 'mcp'], env };
}

export type McpClientId = 'claude-desktop' | 'claude-code' | 'opencode' | 'cursor' | 'vscode';

export interface McpClientSnippet {
    id: McpClientId;
    /** Product name — not translated. */
    name: string;
    /** Where the snippet goes: a file path or "terminal". */
    target: string;
    kind: 'json' | 'shell';
    text: string;
    /** The official page this format was checked against. */
    docsUrl: string;
}

const withEnv = <T extends object>(base: T, key: string, env: Record<string, string>): T =>
    Object.keys(env).length > 0 ? { ...base, [key]: env } : base;

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** POSIX shell quoting — only where needed, so the common case stays readable. */
export function shellQuote(word: string): string {
    return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell quoting: single quotes, a quote doubled. Backslashes and `ä` need no escape inside them. */
export function powershellQuote(word: string): string {
    return /^[\w@%+=:,./\\-]+$/.test(word) ? word : `'${word.replace(/'/g, `''`)}'`;
}

/** Where each OS keeps Claude Desktop's config; Linux has no official build. */
function claudeDesktopTarget(platform: McpPlatform): string | undefined {
    if (platform === 'darwin') return '~/Library/Application Support/Claude/claude_desktop_config.json';
    if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
    return undefined;
}

export function mcpClientSnippets(
    launch: McpLaunch,
    platform: McpPlatform = 'linux',
    name: string = MCP_SERVER_NAME,
): McpClientSnippet[] {
    const { command, args, env } = launch;
    const quote = platform === 'win32' ? powershellQuote : shellQuote;
    const home = platform === 'win32' ? '%USERPROFILE%\\' : '~/';
    const sep = platform === 'win32' ? '\\' : '/';
    const stdio = withEnv({ command, args }, 'env', env);
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['--env', quote(`${k}=${v}`)]);
    const desktopTarget = claudeDesktopTarget(platform);
    const snippets: McpClientSnippet[] = [
        {
            // Checked 2026-10-10 against https://code.claude.com/docs/en/mcp — options before the
            // name, `--` before the server command. `--scope` sits between `--env` and the name,
            // because the variadic `--env` would otherwise swallow the name.
            id: 'claude-code',
            name: 'Claude Code',
            target: 'terminal',
            kind: 'shell',
            text: [
                'claude mcp add --transport stdio',
                ...envFlags,
                '--scope user',
                quote(name),
                '--',
                quote(command),
                ...args.map(quote),
            ].join(' '),
            docsUrl: 'https://code.claude.com/docs/en/mcp',
        },
        {
            // Checked 2026-10-10 against https://opencode.ai/docs/mcp-servers/ — `mcp` with
            // type "local", the command as one array, `environment`. Global config checked
            // 2026-10-16 against https://opencode.ai/docs/config/: `~/.config/opencode/opencode.json`,
            // the same spelling on every OS (on Windows under the user profile).
            id: 'opencode',
            name: 'opencode',
            target: `${home}.config${sep}opencode${sep}opencode.json`,
            kind: 'json',
            text: json({
                $schema: 'https://opencode.ai/config.json',
                mcp: {
                    [name]: withEnv({ type: 'local', command: [command, ...args], enabled: true }, 'environment', env),
                },
            }),
            docsUrl: 'https://opencode.ai/docs/mcp-servers/',
        },
        {
            // Checked 2026-10-10 against https://cursor.com/docs/context/mcp — `mcpServers`, type "stdio".
            // Global file `~/.cursor/mcp.json` re-checked 2026-10-16; the docs name no per-OS path,
            // so the Windows form is the user profile.
            id: 'cursor',
            name: 'Cursor',
            target: `${home}.cursor${sep}mcp.json`,
            kind: 'json',
            text: json({ mcpServers: { [name]: { type: 'stdio', ...stdio } } }),
            docsUrl: 'https://cursor.com/docs/context/mcp',
        },
        {
            // Checked 2026-10-10 against https://code.visualstudio.com/docs/agent-customization/mcp-servers
            // — `.vscode/mcp.json` uses `servers`, not `mcpServers`.
            id: 'vscode',
            name: 'VS Code',
            target: '.vscode/mcp.json',
            kind: 'json',
            text: json({ servers: { [name]: { type: 'stdio', ...stdio } } }),
            docsUrl: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
        },
    ];
    if (desktopTarget) {
        snippets.unshift({
            // Checked 2026-10-16 against https://modelcontextprotocol.io/docs/develop/connect-local-servers
            // — `mcpServers` with command/args/env; the docs name macOS and Windows only, so Linux
            // gets no entry rather than a path that does not exist.
            id: 'claude-desktop',
            name: 'Claude Desktop',
            target: desktopTarget,
            kind: 'json',
            text: json({ mcpServers: { [name]: stdio } }),
            docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
        });
    }
    return snippets;
}
