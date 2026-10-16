/**
 * The "Connect an external agent" snippets — one launch per installation kind, one format per client.
 *
 *   - Flatpak goes through `flatpak run` with `--env=` flags (the sandbox filters the caller's env),
 *   - an installed launcher runs directly, a dev checkout through `gjsify run <bundle>`,
 *   - the workspace always travels along, the demo flag only in demo mode,
 *   - each client gets the key its docs name (`mcpServers`, `servers`, `mcp`),
 *   - the platform is an input: quoting, config paths and the launcher differ per OS.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
    mcpClientSnippets,
    packageLauncher,
    powershellQuote,
    resolveMcpLaunch,
    shellQuote,
} from '../../../src/core/actions/mcp-clients.ts';

const base = { bundlePath: '/src/app/dist/app/steuer-app.gjs.mjs', manifestPath: '/home/u/steuer.json', demo: false };

export default async () => {
    await describe('mcp clients', async () => {
        await it('dev checkout runs the bundle through gjs -m', async () => {
            expect(resolveMcpLaunch(base)).toStrictEqual({
                command: 'gjs',
                args: ['-m', base.bundlePath, 'mcp'],
                env: { STEUER_WORKSPACE: base.manifestPath },
            });
        });

        await it('a checkout with gjsify goes through gjsify run (typelib path)', async () => {
            const l = resolveMcpLaunch({ ...base, gjsifyBin: '/src/node_modules/.bin/gjsify' });
            expect(l.command).toBe('/src/node_modules/.bin/gjsify');
            expect(l.args).toStrictEqual(['run', base.bundlePath, 'mcp']);
        });

        await it('an installed launcher runs directly; demo adds STEUER_DEMO', async () => {
            const l = resolveMcpLaunch({ ...base, installedBinary: '/usr/bin/steuererklaerung', demo: true });
            expect(l.command).toBe('/usr/bin/steuererklaerung');
            expect(l.args).toStrictEqual(['mcp']);
            expect(l.env).toStrictEqual({ STEUER_WORKSPACE: base.manifestPath, STEUER_DEMO: '1' });
        });

        await it('Flatpak passes the env as --env= flags, not as a client env block', async () => {
            const l = resolveMcpLaunch({ ...base, flatpakId: 'eu.jumplink.Steuererklaerung', installedBinary: '/x' });
            expect(l.command).toBe('flatpak');
            expect(l.args).toStrictEqual([
                'run',
                `--env=STEUER_WORKSPACE=${base.manifestPath}`,
                'eu.jumplink.Steuererklaerung',
                'mcp',
            ]);
            expect(l.env).toStrictEqual({});
        });

        await it('each client uses the key its docs name', async () => {
            const snippets = mcpClientSnippets(resolveMcpLaunch(base), 'darwin');
            const byId = Object.fromEntries(snippets.map((s) => [s.id, s]));
            const desktop = JSON.parse(byId['claude-desktop'].text);
            expect(desktop.mcpServers.steuererklaerung.command).toBe('gjs');
            expect(desktop.mcpServers.steuererklaerung.env.STEUER_WORKSPACE).toBe(base.manifestPath);
            const cursor = JSON.parse(byId.cursor.text);
            expect(cursor.mcpServers.steuererklaerung.type).toBe('stdio');
            const vscode = JSON.parse(byId.vscode.text);
            expect(vscode.servers.steuererklaerung.args).toStrictEqual(['-m', base.bundlePath, 'mcp']);
            const opencode = JSON.parse(byId.opencode.text);
            expect(opencode.mcp.steuererklaerung).toStrictEqual({
                type: 'local',
                command: ['gjs', '-m', base.bundlePath, 'mcp'],
                enabled: true,
                environment: { STEUER_WORKSPACE: base.manifestPath },
            });
            for (const s of snippets) expect(s.docsUrl.startsWith('https://')).toBe(true);
        });

        await it('an empty env leaves the env block out', async () => {
            const snippets = mcpClientSnippets({ command: 'flatpak', args: ['run', 'x', 'mcp'], env: {} }, 'darwin');
            const desktop = JSON.parse(snippets.find((s) => s.id === 'claude-desktop')!.text);
            expect('env' in desktop.mcpServers.steuererklaerung).toBe(false);
            const opencode = JSON.parse(snippets.find((s) => s.id === 'opencode')!.text);
            expect('environment' in opencode.mcp.steuererklaerung).toBe(false);
        });

        await it('Claude Code: options, then the name, then -- and the command', async () => {
            const cc = mcpClientSnippets(resolveMcpLaunch(base)).find((s) => s.id === 'claude-code')!;
            expect(cc.text).toBe(
                `claude mcp add --transport stdio --env STEUER_WORKSPACE=${base.manifestPath} --scope user ` +
                    `steuererklaerung -- gjs -m ${base.bundlePath} mcp`,
            );
        });

        await it('shellQuote quotes only where needed', async () => {
            expect(shellQuote('/usr/bin/x')).toBe('/usr/bin/x');
            expect(shellQuote('/home/a b/x')).toBe(`'/home/a b/x'`);
            expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
        });

        await it('AppImage: the file itself, not the mount path of the bundle', async () => {
            const l = resolveMcpLaunch({
                ...base,
                appImage: '/home/u/Apps/Steuererklaerung.AppImage',
                bundlePath: '/tmp/.mount_x/lib/b.mjs',
            });
            expect(l.command).toBe('/home/u/Apps/Steuererklaerung.AppImage');
            expect(l.args).toStrictEqual(['mcp']);
        });

        await it('deb/rpm: the launcher on PATH, absolute', async () => {
            const l = resolveMcpLaunch({
                ...base,
                installedBinary: '/usr/bin/steuererklaerung',
                gjsifyBin: '/x/gjsify',
            });
            expect(l.command).toBe('/usr/bin/steuererklaerung');
        });

        await it('Linux has no Claude Desktop entry; macOS and Windows have their own path', async () => {
            const launch = resolveMcpLaunch(base);
            const ids = (p: 'linux' | 'darwin' | 'win32') => mcpClientSnippets(launch, p).map((s) => s.id);
            expect(ids('linux').includes('claude-desktop')).toBe(false);
            const target = (p: 'darwin' | 'win32') =>
                mcpClientSnippets(launch, p).find((s) => s.id === 'claude-desktop')!.target;
            expect(target('darwin')).toBe('~/Library/Application Support/Claude/claude_desktop_config.json');
            expect(target('win32')).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
        });

        await it('Windows: the .exe launcher with an umlaut path, PowerShell-quoted', async () => {
            const exe = 'C:\\Program Files\\Steuererklärung\\steuererklaerung.exe';
            const launch = resolveMcpLaunch({
                platform: 'win32',
                installedBinary: exe,
                bundlePath: 'C:\\Program Files\\Steuererklärung\\app\\steuer-app.node.mjs',
                manifestPath: 'C:\\Users\\Jörg\\steuer.json',
                demo: false,
            });
            expect(launch.command).toBe(exe);
            const snippets = mcpClientSnippets(launch, 'win32');
            const cc = snippets.find((s) => s.id === 'claude-code')!;
            expect(cc.text).toBe(
                `claude mcp add --transport stdio --env 'STEUER_WORKSPACE=C:\\Users\\Jörg\\steuer.json' --scope user ` +
                    `steuererklaerung -- '${exe}' mcp`,
            );
            expect(snippets.find((s) => s.id === 'opencode')!.target).toBe(
                '%USERPROFILE%\\.config\\opencode\\opencode.json',
            );
            expect(snippets.find((s) => s.id === 'cursor')!.target).toBe('%USERPROFILE%\\.cursor\\mcp.json');
            const desktop = JSON.parse(snippets.find((s) => s.id === 'claude-desktop')!.text);
            expect(desktop.mcpServers.steuererklaerung.command).toBe(exe);
        });

        await it('macOS .app: the launcher in Contents/MacOS', async () => {
            const launcher = '/Applications/Steuererklärung.app/Contents/MacOS/steuererklaerung';
            const launch = resolveMcpLaunch({
                platform: 'darwin',
                installedBinary: launcher,
                bundlePath: '/Applications/Steuererklärung.app/Contents/Resources/lib/steuer-app.node.mjs',
                manifestPath: '/Users/u/steuer.json',
                demo: false,
            });
            expect(launch.command).toBe(launcher);
            const cc = mcpClientSnippets(launch, 'darwin').find((s) => s.id === 'claude-code')!;
            expect(cc.text.endsWith(`-- '${launcher}' mcp`)).toBe(true);
        });

        await it('without a launcher a node package runs <node> <bundle> mcp', async () => {
            const l = resolveMcpLaunch({ ...base, platform: 'win32', nodeBin: 'C:\\app\\node.exe' });
            expect(l.command).toBe('C:\\app\\node.exe');
            expect(l.args).toStrictEqual([base.bundlePath, 'mcp']);
        });

        await it('packageLauncher looks beside node: .exe on Windows, Contents/MacOS on macOS, never on Linux', async () => {
            const seen: string[] = [];
            const yes = (p: string) => (seen.push(p), true);
            expect(packageLauncher('win32', 'C:\\Program Files\\Steuererklärung\\node.exe', yes)).toBe(
                'C:\\Program Files\\Steuererklärung\\steuererklaerung.exe',
            );
            expect(packageLauncher('darwin', '/A/S.app/Contents/MacOS/node', yes)).toBe(
                '/A/S.app/Contents/MacOS/steuererklaerung',
            );
            expect(packageLauncher('linux', '/usr/bin/node', yes)).toBe(undefined);
            expect(packageLauncher('win32', 'C:\\x\\node.exe', () => false)).toBe(undefined);
        });

        await it('powershellQuote doubles quotes and leaves ä alone inside single quotes', async () => {
            expect(powershellQuote('C:\\x\\a.exe')).toBe('C:\\x\\a.exe');
            expect(powershellQuote('C:\\Pro Files\\ä.exe')).toBe(`'C:\\Pro Files\\ä.exe'`);
            expect(powershellQuote(`it's`)).toBe(`'it''s'`);
        });
    });
};
