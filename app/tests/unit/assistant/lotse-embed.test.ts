/**
 * The four promises `lotse-embed.ts` makes, each as a test that would fail without it.
 *
 * The interesting one is the first: "no AI" has to mean no process, and the only way to check that
 * without a display is to check that the caller is handed NOTHING to build from. A test that
 * asserted on a window would need GTK and would still not prove the absence of a spawn.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@lotse/core';

import {
    AI_ENGINE_ENV,
    assistantGateAnswer,
    ensureLotseDataRoot,
    launchIsReadOnly,
    lotseDataRoot,
    lotseEmbedPlan,
    lotseMcpLaunch,
    LOTSE_DATA_DIR_NAME,
    resolveAiEngine,
    type LotseEmbedOptions,
} from '../../../src/core/actions/assistant/lotse-embed.ts';
import { MCP_SERVER_NAME, resolveMcpLaunch, type McpInstallation } from '../../../src/core/actions/mcp-clients.ts';
import { MCP_READONLY_ENV, readOnlyRequested, restrictMcpToReadOnly } from '../../../src/core/config/mcp-readonly.ts';
import { defaultAppSettings } from '../../../src/core/config/schema/app-settings.ts';
import { UserSettingsSchema, type UserSettings } from '../../../src/core/config/user-settings.ts';

const APP_DATA = '/home/someone/.local/share/steuererklaerung';

const settings = (patch: Partial<UserSettings> = {}): UserSettings => ({
    ...UserSettingsSchema.parse({}),
    ...patch,
});

const installation: McpInstallation = {
    bundlePath: '/opt/steuererklaerung/steuer.gjs.mjs',
    installedBinary: '/usr/bin/steuer',
    manifestPath: '/home/someone/.config/steuererklaerung/steuererklaerung.json',
    demo: true,
};

/**
 * The env pairs off an `McpServer`, read back the way the agent would.
 *
 * `McpServer` is a union whose members all carry ACP's `[key: string]: unknown`, so `env` is
 * `unknown` on every branch and `'env' in server` narrows nothing — the type says "an opaque object
 * lotse forwards", which is exactly what it is. So read it as data instead of casting it.
 */
const envPairs = (server: McpServer | undefined): { name: string; value: string }[] => {
    const raw = server?.env;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (entry): entry is { name: string; value: string } =>
            typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string',
    );
};

/** A plan built with everything said yes — the baseline the other cases differ from. */
const plan = (patch: Partial<LotseEmbedOptions> = {}) =>
    lotseEmbedPlan({
        installation,
        settings: settings({ aiEngine: 'lotse' }),
        env: {},
        appDataDir: APP_DATA,
        assistantEnabled: true,
        ...patch,
    });

export default async () => {
    await describe('lotseEmbedPlan — nothing to build from means nothing is started', async () => {
        await it('returns null with the AI switch off, whatever the engine says', async () => {
            expect(plan({ assistantEnabled: false })).toBe(null);
            expect(
                lotseEmbedPlan({
                    installation,
                    settings: settings({ aiAssistant: false, aiEngine: 'lotse' }),
                    env: {},
                    appDataDir: APP_DATA,
                }),
            ).toBe(null);
        });

        await it('returns null for the built-in engine, which is what an unset setting is', async () => {
            expect(plan({ settings: settings({ aiEngine: 'builtin' }) })).toBe(null);
            expect(plan({ settings: settings() })).toBe(null);
        });

        await it('ignores the engine env hook unless it names an engine', async () => {
            expect(plan({ settings: settings(), env: { [AI_ENGINE_ENV]: 'lotse' } })).not.toBe(null);
            // A typo falls back to the setting (builtin), it does not become a default yes.
            expect(plan({ settings: settings(), env: { [AI_ENGINE_ENV]: 'lotze' } })).toBe(null);
        });
    });

    await describe('lotseEmbedPlan — the agent writes under the app, not beside it', async () => {
        await it('puts every lotse path under the app data directory', async () => {
            const built = plan();
            expect(built).not.toBe(null);
            if (!built) return;
            expect(built.dataRoot).toBe(join(APP_DATA, LOTSE_DATA_DIR_NAME));
            expect(built.cwd).toBe(built.dataRoot);
            for (const path of Object.values(built.paths)) {
                expect(path.startsWith(`${built.dataRoot}/`)).toBe(true);
            }
        });

        await it('never resolves into the personal lotse directory', async () => {
            const built = plan();
            if (!built) return;
            expect(built.paths.sessionsFile.includes('/.local/share/lotse/')).toBe(false);
            expect(lotseDataRoot(APP_DATA)).toBe(`${APP_DATA}/${LOTSE_DATA_DIR_NAME}`);
        });

        await it('creates the data root 0700 even when it already exists wider', async () => {
            const parent = mkdtempSync(join(tmpdir(), 'steuer-lotse-'));
            try {
                const root = ensureLotseDataRoot(lotseDataRoot(parent));
                expect(statSync(root).mode & 0o777).toBe(0o700);
                // Idempotent, and a second call re-asserts the mode rather than trusting the umask.
                expect(statSync(ensureLotseDataRoot(root)).mode & 0o777).toBe(0o700);
            } finally {
                rmSync(parent, { recursive: true, force: true });
            }
        });
    });

    await describe('lotseEmbedPlan — one server, read-only', async () => {
        await it('hands the agent this app’s MCP server and no other', async () => {
            const built = plan();
            if (!built) return;
            expect(built.mcpServers.length).toBe(1);
            expect(built.mcpServers[0]?.name).toBe(MCP_SERVER_NAME);
            expect(built.mcpServers[0]?.command).toBe(installation.installedBinary);
            expect(JSON.stringify(built.mcpServers[0]?.args)).toBe('["mcp"]');
        });

        await it('carries the read-only marker in the server env', async () => {
            const built = plan();
            if (!built) return;
            expect(envPairs(built.mcpServers[0]).some((e) => e.name === MCP_READONLY_ENV && e.value === '1')).toBe(
                true,
            );
            expect(launchIsReadOnly(lotseMcpLaunch(installation))).toBe(true);
        });

        await it('carries it as an --env flag in a Flatpak, where the env block is filtered', async () => {
            const launch = lotseMcpLaunch({ ...installation, flatpakId: 'eu.jumplink.Steuererklaerung' });
            expect(launch.command).toBe('flatpak');
            expect(launch.args.includes(`--env=${MCP_READONLY_ENV}=1`)).toBe(true);
            expect(launchIsReadOnly(launch)).toBe(true);
        });

        await it('leaves what an externally configured client is handed untouched', async () => {
            const external = resolveMcpLaunch(installation);
            expect(MCP_READONLY_ENV in external.env).toBe(false);
            expect(launchIsReadOnly(external)).toBe(false);
        });
    });

    await describe('assistantGateAnswer — a restriction, never an approval', async () => {
        await it('declines the destructive kinds without asking anyone', async () => {
            for (const kind of ['delete', 'move', 'edit', 'write', 'execute']) {
                expect(assistantGateAnswer({ tool: 'whatever', kind })).toBe('decline');
            }
            // The kind arrives from the agent, so neither case nor padding may decide this.
            expect(assistantGateAnswer({ tool: 'bash', kind: ' Execute ' })).toBe('decline');
        });

        await it('asks the person about reading and about fetching a URL', async () => {
            expect(assistantGateAnswer({ tool: 'read', kind: 'read' })).toBe('ask');
            expect(assistantGateAnswer({ tool: 'webfetch', kind: 'fetch' })).toBe('ask');
            // An unknown kind is a question, not an approval — there is no value that approves.
            expect(assistantGateAnswer({ tool: 'something-new', kind: 'other' })).toBe('ask');
        });
    });

    await describe('restrictMcpToReadOnly — it can only take away', async () => {
        const base = defaultAppSettings().mcp;
        const writable = { ...base, allowWrite: true };

        await it('takes the write tools away when the environment asks', async () => {
            expect(restrictMcpToReadOnly(writable, { [MCP_READONLY_ENV]: '1' }).allowWrite).toBe(false);
        });

        await it('never grants a write the settings did not', async () => {
            const readOnly = { ...base, allowWrite: false };
            for (const value of ['1', 'true', '0', 'false', '', undefined]) {
                expect(restrictMcpToReadOnly(readOnly, { [MCP_READONLY_ENV]: value }).allowWrite).toBe(false);
            }
        });

        await it('leaves the settings alone when the variable is off', async () => {
            for (const value of [undefined, '', '0', 'false', ' FALSE ']) {
                expect(readOnlyRequested({ [MCP_READONLY_ENV]: value })).toBe(false);
                expect(restrictMcpToReadOnly(writable, { [MCP_READONLY_ENV]: value }).allowWrite).toBe(true);
            }
        });
    });

    await describe('resolveAiEngine', async () => {
        await it('defaults to the assistant an existing installation has', async () => {
            expect(resolveAiEngine(settings(), {})).toBe('builtin');
        });

        await it('lets the env hook win over the setting, in either direction', async () => {
            expect(resolveAiEngine(settings({ aiEngine: 'builtin' }), { [AI_ENGINE_ENV]: 'LOTSE' })).toBe('lotse');
            expect(resolveAiEngine(settings({ aiEngine: 'lotse' }), { [AI_ENGINE_ENV]: 'builtin' })).toBe('builtin');
        });
    });
};
