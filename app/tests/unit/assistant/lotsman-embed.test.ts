/**
 * The five promises `lotsman-embed.ts` makes, each as a test that would fail without it.
 *
 * The interesting one is the first: "no AI" has to mean no process, and the only way to check that
 * without a display is to check that the caller is handed NOTHING to build from. A test that
 * asserted on a window would need GTK and would still not prove the absence of a spawn.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    denyFreeHostedModels,
    hostConfirmed,
    isFreeModel,
    lotsmanPathsUnder,
    type AgentDetection,
    type McpServer,
    type ResolveContext,
    type ToolRef,
} from '@lotsman/core';

import {
    agentInstallOffer,
    AI_ENGINE_ENV,
    assistantGateAnswer,
    ensureLotsmanDataRoot,
    installOfferedAgent,
    launchIsReadOnly,
    lotsmanDataRoot,
    lotsmanEmbedPlan,
    lotsmanMcpLaunch,
    LOTSMAN_DATA_DIR_NAME,
    LOTSMAN_MODEL_POLICY,
    resolveAgentSource,
    resolveAiEngine,
    resolveLotsmanAgentIn,
    DEFAULT_AGENT_SOURCE,
    type LotsmanEmbedOptions,
} from '../../../src/core/actions/assistant/lotsman-embed.ts';
import {
    TIER_A_HOST_CONFIRMED,
    TIER_A_TOOLS,
    TIER_B_TOOLS,
    writeTierOf,
} from '../../../src/core/actions/assistant/write-tiers.ts';
import type { AppContext } from '../../../src/core/context.ts';
import { describeMcpTools } from '../../../src/frontends/mcp/server.ts';
import { MCP_SERVER_NAME, resolveMcpLaunch, type McpInstallation } from '../../../src/core/actions/mcp-clients.ts';
import { MCP_READONLY_ENV, readOnlyRequested, restrictMcpToReadOnly } from '../../../src/core/config/mcp-readonly.ts';
import { defaultAppSettings } from '../../../src/core/config/schema/app-settings.ts';
import { DEFAULT_SYNC_CONFIG } from '../../../src/core/config/schema/paperless.ts';
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
 * lotsman forwards", which is exactly what it is. So read it as data instead of casting it.
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
const plan = (patch: Partial<LotsmanEmbedOptions> = {}) =>
    lotsmanEmbedPlan({
        installation,
        settings: settings({ aiEngine: 'lotsman' }),
        env: {},
        appDataDir: APP_DATA,
        assistantEnabled: true,
        ...patch,
    });

export default async () => {
    await describe('lotsmanEmbedPlan — nothing to build from means nothing is started', async () => {
        await it('returns null with the AI switch off, whatever the engine says', async () => {
            expect(plan({ assistantEnabled: false })).toBe(null);
            expect(
                lotsmanEmbedPlan({
                    installation,
                    settings: settings({ aiAssistant: false, aiEngine: 'lotsman' }),
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
            expect(plan({ settings: settings(), env: { [AI_ENGINE_ENV]: 'lotsman' } })).not.toBe(null);
            // A typo falls back to the setting (builtin), it does not become a default yes.
            expect(plan({ settings: settings(), env: { [AI_ENGINE_ENV]: 'lotze' } })).toBe(null);
        });
    });

    await describe('lotsmanEmbedPlan — the agent writes under the app, not beside it', async () => {
        await it('puts every lotsman path under the app data directory', async () => {
            const built = plan();
            expect(built).not.toBe(null);
            if (!built) return;
            expect(built.dataRoot).toBe(join(APP_DATA, LOTSMAN_DATA_DIR_NAME));
            expect(built.cwd).toBe(built.dataRoot);
            for (const path of Object.values(built.paths)) {
                expect(path.startsWith(`${built.dataRoot}/`)).toBe(true);
            }
        });

        await it('never resolves into the personal lotsman directory', async () => {
            const built = plan();
            if (!built) return;
            expect(built.paths.sessionsFile.includes('/.local/share/lotsman/')).toBe(false);
            expect(lotsmanDataRoot(APP_DATA)).toBe(`${APP_DATA}/${LOTSMAN_DATA_DIR_NAME}`);
        });

        await it('creates the data root 0700 even when it already exists wider', async () => {
            const parent = mkdtempSync(join(tmpdir(), 'steuer-lotsman-'));
            try {
                const root = ensureLotsmanDataRoot(lotsmanDataRoot(parent));
                expect(statSync(root).mode & 0o777).toBe(0o700);
                // Idempotent, and a second call re-asserts the mode rather than trusting the umask.
                expect(statSync(ensureLotsmanDataRoot(root)).mode & 0o777).toBe(0o700);
            } finally {
                rmSync(parent, { recursive: true, force: true });
            }
        });
    });

    await describe('lotsmanEmbedPlan — one server, read-only', async () => {
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
            expect(launchIsReadOnly(lotsmanMcpLaunch(installation))).toBe(true);
        });

        await it('carries it as an --env flag in a Flatpak, where the env block is filtered', async () => {
            const launch = lotsmanMcpLaunch({
                ...installation,
                flatpakId: 'eu.jumplink.Steuererklaerung',
            });
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

    await describe('free hosted models — warned about in the pane, blocked in unattended jobs', async () => {
        await it('keeps lotsman’s rule unmodified for background jobs', async () => {
            // Not a copy of the rule that could drift from it.
            expect(LOTSMAN_MODEL_POLICY).toBe(denyFreeHostedModels);
        });

        await it('denies what lotsman recognises as free, an empty id too, and allows a paid id', async () => {
            for (const id of ['opencode/big-pickle', 'opencode/fledge-alpha-free', 'x/any-free']) {
                expect(isFreeModel(id)).toBe(true);
                expect(LOTSMAN_MODEL_POLICY(id)).toBe('deny');
            }
            expect(LOTSMAN_MODEL_POLICY('')).toBe('deny');
            expect(LOTSMAN_MODEL_POLICY('   ')).toBe('deny');
            // The documented gap, asserted rather than left implied: an unrecognised id is allowed.
            expect(LOTSMAN_MODEL_POLICY('anthropic/claude-opus-5')).toBe('allow');
        });

        await it('the plan carries no policy, so the pane shows lotsman’s warning card instead', async () => {
            const built = plan();
            if (!built) return;
            expect('modelPolicy' in built).toBe(false);
        });

        /**
         * The panel needs GTK and cannot be built headless (Sandbox Exit 144), so the source is
         * checked: the interactive pane must not pass a policy (#95), or the warning card never
         * shows and a free model stays hidden. The headless job in `opencode-provider.ts` must
         * keep passing one, since nobody is there to read a card.
         */
        await it('the pane passes no modelPolicy, the unattended job still does', async () => {
            const panel = readFileSync(join(process.cwd(), 'src/frontends/desktop/lotsman-panel.ts'), 'utf-8');
            expect(panel.includes('modelPolicy:')).toBe(false);
            const job = readFileSync(join(process.cwd(), 'src/core/clients/llm/opencode-provider.ts'), 'utf-8');
            expect(job.includes('modelPolicy: embed.LOTSMAN_MODEL_POLICY')).toBe(true);
        });
    });

    await describe('agentInstallOffer — the "no agent" page offers lotsman’s pin, never a "latest"', async () => {
        const paths = lotsmanPathsUnder(mkdtempSync(join(tmpdir(), 'lotsman-offer-')));

        await it('offers the pinned opencode on a platform the catalog has a pin for, with its size', async () => {
            const offer = agentInstallOffer(paths, 'linux', 'x64');
            expect(offer?.agent.id).toBe('opencode');
            expect((offer?.megabytes ?? 0) > 0).toBe(true);
            expect(agentInstallOffer(paths, 'linux', 'arm64')?.agent.id).toBe('opencode');
        });

        await it('offers nothing where the catalog has no pin', async () => {
            expect(agentInstallOffer(paths, 'darwin', 'arm64')).toBe(null);
            expect(agentInstallOffer(paths, 'win32', 'x64')).toBe(null);
            expect(agentInstallOffer(paths, 'linux', 'riscv64')).toBe(null);
        });

        await it('reports a failed download as lotsman’s sentence and leaves nothing behind', async () => {
            const offer = agentInstallOffer(paths, 'linux', 'x64');
            if (!offer) return;
            const failing = (() => Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof fetch;
            const failure = await installOfferedAgent(offer, paths, { fetch: failing });
            expect(typeof failure).toBe('string');
            // Still offered: nothing was installed.
            expect(agentInstallOffer(paths, 'linux', 'x64')?.agent.id).toBe('opencode');
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

    await describe('assistantGateAnswer — tiers decide this app’s own write tools, not the ACP kind', async () => {
        // Registration only reads `ctx.config`, and the handlers are never invoked.
        const writeTools = describeMcpTools({ config: DEFAULT_SYNC_CONFIG } as unknown as AppContext)
            .flatMap((group) => group.tools)
            .filter((tool) => !tool.readOnly)
            .map((tool) => tool.name);

        await it('finds the write tools by the same registration code the server runs', async () => {
            // `describeMcpTools` swallows a group that throws while registering; a context too bare
            // for `crossSystem` would silently drop its tools, so both ends are checked.
            expect(writeTools.includes('submit_filing')).toBe(true);
            expect(writeTools.includes('push_document_to_qonto')).toBe(true);
        });

        await it('puts every write tool in exactly one tier, and nothing else in either', async () => {
            const tiered = [...TIER_A_TOOLS, ...TIER_B_TOOLS];
            expect(new Set(tiered).size).toBe(tiered.length);
            for (const name of writeTools) expect(writeTierOf(name) === null).toBe(false);
            expect([...writeTools].sort().join(',')).toBe([...tiered].sort().join(','));
        });

        await it('names tier A as the ADR does, and no read tool is classified', async () => {
            expect([...TIER_A_TOOLS].sort().join(',')).toBe(
                [
                    'submit_filing',
                    'elster_lock_period',
                    'sign_off_filing',
                    'revoke_signoff',
                    'remove_filing',
                    'remove_contact',
                    'invoices_delete_draft',
                    'invoices_cancel',
                    'detach_filing_document',
                ]
                    .sort()
                    .join(','),
            );
            expect(writeTierOf('paperless_list_tags')).toBe(null);
        });

        await it('never lets a tier A tool reach lotsman’s own approval', async () => {
            const policy = { hostConfirmed: TIER_A_HOST_CONFIRMED };
            const refFor = (tool: string): ToolRef => ({
                title: tool,
                kind: 'edit',
                names: [tool, `${MCP_SERVER_NAME}.${tool}`],
            });
            for (const tool of TIER_A_TOOLS) {
                // lotsman routes it to the app's dialog, which skips lotsman's gate and dialog entirely…
                expect(hostConfirmed(policy, refFor(tool))).toBe(true);
                // …and if the routing were ever missing, the gate itself refuses.
                for (const name of [tool, `${MCP_SERVER_NAME}.${tool}`, `${MCP_SERVER_NAME}_${tool}`.toUpperCase()]) {
                    for (const kind of ['edit', 'other', 'read']) {
                        expect(assistantGateAnswer({ tool: name, kind })).toBe('decline');
                    }
                }
            }
            for (const tool of TIER_B_TOOLS) expect(hostConfirmed(policy, refFor(tool))).toBe(false);
        });

        await it('asks about every tier B tool, whatever kind the agent reports', async () => {
            for (const tool of TIER_B_TOOLS) {
                for (const kind of ['edit', 'write', 'execute', 'other']) {
                    expect(assistantGateAnswer({ tool, kind })).toBe('ask');
                    expect(assistantGateAnswer({ tool: `${MCP_SERVER_NAME}_${tool}`, kind })).toBe('ask');
                }
            }
        });

        await it('answers only ask or decline, for every tool and kind', async () => {
            const tools = [...TIER_A_TOOLS, ...TIER_B_TOOLS, 'bash', 'read', '', 'unknown-tool'];
            for (const tool of tools) {
                for (const kind of ['read', 'edit', 'delete', 'move', 'write', 'execute', 'fetch', 'other', '']) {
                    const answer: string = assistantGateAnswer({ tool, kind });
                    expect(answer === 'ask' || answer === 'decline').toBe(true);
                }
            }
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
            expect(
                resolveAiEngine(settings({ aiEngine: 'builtin' }), {
                    [AI_ENGINE_ENV]: 'LOTSMAN',
                }),
            ).toBe('lotsman');
            expect(
                resolveAiEngine(settings({ aiEngine: 'lotsman' }), {
                    [AI_ENGINE_ENV]: 'builtin',
                }),
            ).toBe('builtin');
        });
    });

    await describe('agent source — which opencode the pane and the jobs start', async () => {
        const hostDetection: AgentDetection = {
            id: 'opencode',
            source: 'host',
            path: '/usr/bin/opencode',
            version: '1.0.0',
        };
        const context = (opts: { host: boolean; bundled: boolean }): ResolveContext => ({
            detections: opts.host ? [hostDetection] : [],
            isolationFor: (id) => ({
                home: `/tmp/x/${id}/home`,
                config: `/tmp/x/${id}/config`,
                data: `/tmp/x/${id}/data`,
                state: `/tmp/x/${id}/state`,
                cache: `/tmp/x/${id}/cache`,
            }),
            bundledAvailable: () => opts.bundled,
        });

        await it('is bundled unless the person chose otherwise', async () => {
            expect(DEFAULT_AGENT_SOURCE).toBe('bundled');
            expect(resolveAgentSource(settings())).toBe('bundled');
            expect(resolveAgentSource(settings({ aiAgentSource: 'host' }))).toBe('host');
        });

        await it('rejects a value that names no source', async () => {
            expect(UserSettingsSchema.safeParse({ aiAgentSource: 'cloud' }).success).toBe(false);
            expect(UserSettingsSchema.safeParse({ aiAgentSource: 'host' }).success).toBe(true);
        });

        await it('keeps a host install out of the way while bundled is chosen', async () => {
            const r = resolveLotsmanAgentIn(context({ host: true, bundled: true }), 'bundled');
            expect(r.agent?.source).toBe('bundled');
            expect(r.note).toBe(null);
        });

        await it('starts the host install only when asked for it', async () => {
            const r = resolveLotsmanAgentIn(context({ host: true, bundled: true }), 'host');
            expect(r.agent?.source).toBe('host');
        });

        await it('says so when the choice is unavailable, and has no agent when nothing is', async () => {
            const fallback = resolveLotsmanAgentIn(context({ host: true, bundled: false }), 'bundled');
            expect(fallback.note === null).toBe(false);
            const none = resolveLotsmanAgentIn(context({ host: false, bundled: false }), 'host');
            expect(none.agent).toBe(null);
            expect(none.note === null).toBe(false);
        });

        await it('is the one resolver both the pane and the jobs call', async () => {
            for (const file of ['frontends/desktop/lotsman-panel.ts', 'core/clients/llm/opencode-provider.ts']) {
                const text = readFileSync(join(process.cwd(), 'src', file), 'utf-8');
                expect(text.includes('resolveLotsmanAgent(')).toBe(true);
                expect(text.includes('resolveDefaultWithNote')).toBe(false);
            }
        });
    });
};
