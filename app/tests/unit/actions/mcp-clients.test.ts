/**
 * The "Connect an external agent" snippets — one launch per installation kind, one format per client.
 *
 *   - Flatpak goes through `flatpak run` with `--env=` flags (the sandbox filters the caller's env),
 *   - an installed launcher runs directly, a dev checkout through `gjsify run <bundle>`,
 *   - the workspace always travels along, the demo flag only in demo mode,
 *   - each client gets the key its docs name (`mcpServers`, `servers`, `mcp`).
 */
import { describe, expect, it } from '@gjsify/unit';

import { mcpClientSnippets, resolveMcpLaunch, shellQuote } from '../../../src/core/actions/mcp-clients.ts';

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
            const snippets = mcpClientSnippets(resolveMcpLaunch(base));
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
            const snippets = mcpClientSnippets({ command: 'flatpak', args: ['run', 'x', 'mcp'], env: {} });
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
    });
};
