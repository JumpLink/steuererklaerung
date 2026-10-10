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

/** Name the server is registered under in every client. */
export const MCP_SERVER_NAME = 'steuererklaerung';

/** What a client runs: one program, its arguments, extra environment. */
export interface McpLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

/** The facts about the running installation the launch depends on. */
export interface McpInstallation {
    /** `FLATPAK_ID` when the app runs sandboxed. */
    flatpakId?: string;
    /** The launcher a package put on PATH, absolute, when one exists. */
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
}

export function resolveMcpLaunch(inst: McpInstallation): McpLaunch {
    const env: Record<string, string> = { STEUER_WORKSPACE: inst.manifestPath };
    if (inst.demo) env.STEUER_DEMO = '1';
    if (inst.flatpakId) {
        // `--env=` instead of the client's env block: flatpak run filters the caller's environment,
        // the flag is the documented way into the sandbox.
        const flags = Object.entries(env).map(([k, v]) => `--env=${k}=${v}`);
        return { command: 'flatpak', args: ['run', ...flags, inst.flatpakId, 'mcp'], env: {} };
    }
    if (inst.installedBinary) return { command: inst.installedBinary, args: ['mcp'], env };
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

export function mcpClientSnippets(launch: McpLaunch, name: string = MCP_SERVER_NAME): McpClientSnippet[] {
    const { command, args, env } = launch;
    const stdio = withEnv({ command, args }, 'env', env);
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['--env', shellQuote(`${k}=${v}`)]);
    return [
        {
            // Checked 2026-10-10 against https://modelcontextprotocol.io/docs/develop/connect-local-servers
            // — `mcpServers` with command/args/env; Claude Desktop documents macOS and Windows only.
            id: 'claude-desktop',
            name: 'Claude Desktop',
            target: 'claude_desktop_config.json',
            kind: 'json',
            text: json({ mcpServers: { [name]: stdio } }),
            docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
        },
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
                shellQuote(name),
                '--',
                shellQuote(command),
                ...args.map(shellQuote),
            ].join(' '),
            docsUrl: 'https://code.claude.com/docs/en/mcp',
        },
        {
            // Checked 2026-10-10 against https://opencode.ai/docs/mcp-servers/ — `mcp` with
            // type "local", the command as one array, `environment`.
            id: 'opencode',
            name: 'opencode',
            target: '~/.config/opencode/opencode.json',
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
            id: 'cursor',
            name: 'Cursor',
            target: '~/.cursor/mcp.json',
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
}
