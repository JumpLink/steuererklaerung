/**
 * The decisions behind the lotse assistant pane — every one of them, and none of the GTK.
 *
 * lotse is an ACP client: it starts a coding agent (opencode) as a SUBPROCESS and talks to it over
 * stdio. That is a different animal from the built-in assistant, which calls an LLM provider
 * in-process, and the difference is exactly why the choice is explicit and why this file exists
 * apart from the widget. Five things have to be true before a single process is spawned, and all
 * five are decided here so a test can check them without a display:
 *
 *   1. **AI is on.** `isAssistantEnabled()` is the person's consent, unchanged. With it off,
 *      {@link lotseEmbedPlan} returns `null`, the pane is never built, and nothing is started —
 *      "no AI" stays an option in the literal sense, not as a hidden-but-running one.
 *   2. **This engine was chosen.** `aiEngine` defaults to `builtin`, so an existing installation
 *      sees no change until someone picks lotse in Settings.
 *   3. **The agent writes under OUR data directory**, not into `$XDG_DATA_HOME/lotse`. A session
 *      file holds the text of conversations about this person's tax data; it belongs with the rest
 *      of that data, in a 0700 directory, declared as `state` in `.werkstatt-state.json` — not
 *      mixed into another app's history. `lotsePathsUnder` is lotse's seam for precisely this.
 *   4. **The tools it gets are read-only.** The agent reaches this app through this app's own MCP
 *      server, started with {@link MCP_READONLY_ENV} — see `core/config/mcp-readonly.ts` for why
 *      the manifest's `allowWrite` is the wrong switch for an agent the app spawned itself.
 *   5. **No free hosted model may answer.** {@link LOTSE_MODEL_POLICY} is handed to `LotseChat` as
 *      its `modelPolicy`, which hides those models and refuses a prompt while one is selected.
 *      Everything this pane can read — receipts, Buchungen, Steuernummern — arrives through the MCP
 *      server above and ends up in the model's context, so the destination is as much a decision as
 *      the tools are.
 *
 * **What the gate can and cannot do.** {@link assistantGateAnswer} answers the agent's
 * `session/request_permission`: it declines the destructive kinds outright and asks the person
 * about everything else. It is a RESTRICTION — `HostGateAnswer` has no value that approves, so no
 * answer from here can widen what lotse would otherwise allow. It sees tool calls and nothing
 * else: it cannot see, and therefore cannot police, which MODEL the agent uses. That is point 5's
 * job, and it must not be claimed of the gate.
 *
 * Pure: no GTK, no spawning, and the only disk it touches is the one `mkdir` in
 * {@link ensureLotseDataRoot}. The panel builds the widget from a plan; everything above is here.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    denyFreeHostedModels,
    gatherResolveContext,
    lotsePathsUnder,
    resolveDefaultWithNote,
    type AgentChoice,
    type DefaultResolution,
    type ResolveContext,
    type LotsePaths,
    type McpServer,
    type ModelPolicy,
} from '@lotse/core';

import { isAssistantEnabled } from '../../config/assistant-preference.ts';
import { MCP_READONLY_ENV } from '../../config/mcp-readonly.ts';
import { loadUserSettings, type UserSettings } from '../../config/user-settings.ts';
import { userDataDir } from '../../paths.ts';
import { MCP_SERVER_NAME, resolveMcpLaunch, type McpInstallation, type McpLaunch } from '../mcp-clients.ts';

/** Subdirectory of the app's data directory that is lotse's alone. */
export const LOTSE_DATA_DIR_NAME = 'assistant-agent';

/** Dev hook: pick the engine without touching the person's settings. */
export const AI_ENGINE_ENV = 'STEUER_APP_AI_ENGINE';

export type AiEngine = 'builtin' | 'lotse';

/** What an installation from before `aiEngine` existed has — the assistant it has always had. */
export const DEFAULT_AI_ENGINE: AiEngine = 'builtin';

/**
 * Which assistant to show. The environment wins so a developer can start either one, but only with
 * a value that names an engine: a typo falls back to the setting rather than silently to a default.
 */
export function resolveAiEngine(
    settings: UserSettings = loadUserSettings(),
    env: Record<string, string | undefined> = process.env,
): AiEngine {
    const raw = env[AI_ENGINE_ENV]?.trim().toLowerCase();
    if (raw === 'builtin' || raw === 'lotse') return raw;
    return settings.aiEngine ?? DEFAULT_AI_ENGINE;
}

/** `<app data dir>/assistant-agent` — the root lotse resolves all of its paths under. */
export function lotseDataRoot(appDataDir: string = userDataDir()): string {
    return join(appDataDir, LOTSE_DATA_DIR_NAME);
}

/**
 * The launch for the server the PANE gets: the installation's own, plus read-only.
 *
 * The one place `readOnly` is set to true. `mcpClientSnippets` keeps the installation untouched, so
 * what an externally-configured client is handed does not change by a byte.
 */
export function lotseMcpLaunch(inst: McpInstallation): McpLaunch {
    return resolveMcpLaunch({ ...inst, readOnly: true });
}

/** The launch as lotse wants it: one stdio `McpServer`, its env as name/value pairs. */
export function lotseMcpServers(launch: McpLaunch, name: string = MCP_SERVER_NAME): McpServer[] {
    return [
        {
            name,
            command: launch.command,
            args: launch.args,
            env: Object.entries(launch.env).map(([key, value]) => ({
                name: key,
                value,
            })),
        },
    ];
}

/**
 * Tool kinds the person is never asked about, because there is no good answer. The agent is here to
 * read and explain this person's bookkeeping; a write of any shape is out of scope for it, and the
 * read-only MCP server already refuses the mutating tools. Declining is the honest echo of that:
 * the agent is told no straight away instead of making someone dismiss a dialog for a tool that
 * could not have worked.
 *
 * `fetch` is deliberately NOT here. It is how an agent looks up a Gesetzestext or a BMF page, which
 * is useful; the person sees the URL in the dialog and decides. The kinds are lotse's own
 * vocabulary (`PermissionView.kind`), not the agent's wording.
 */
const DECLINED_TOOL_KINDS: ReadonlySet<string> = new Set(['delete', 'move', 'edit', 'write', 'execute']);

/** `'decline'` or `'ask'` — never an approval; `HostGateAnswer` has no such value by design. */
export function assistantGateAnswer(view: { tool: string; kind: string }): 'ask' | 'decline' {
    return DECLINED_TOOL_KINDS.has(view.kind.trim().toLowerCase()) ? 'decline' : 'ask';
}

/**
 * Which models this pane's prompts may reach — lotse's ready-made rule, unmodified.
 *
 * `denyFreeHostedModels` is `isFreeModel`'s answer turned into a policy: the ids in lotse's
 * `free-models.json`, anything whose id ends in `-free`, and an empty id. The widget hides those
 * models from the dropdown and REFUSES a prompt while one is selected; it never switches the model
 * for the person, so the choice stays theirs and is only narrowed. Fail-closed on both edges lotse
 * documents: a policy that throws is a deny, and so is a model lotse cannot identify.
 *
 * **It is the model side of `providerOnboarding: false`, not a duplicate of it.** Not offering to
 * connect a provider keeps the app from *walking* anybody into a free hosted model; it does nothing
 * about a person who already has one connected, or about an agent whose own config names one. This
 * refuses the prompt either way.
 *
 * **Its one known gap, deliberately not papered over here:** an id the list does not recognise is
 * ALLOWED, because the list names free models rather than paid ones and denying the unrecognised
 * would deny nearly every model including the paid ones. An allowlist would close that gap and
 * would also need this app to maintain a list of every model it considers acceptable — a list that
 * rots silently and locks the person out of a model they pay for. The suffix rule is what catches
 * the one concrete case measured so far: `opencode/fledge-alpha-free`, what an opencode with no
 * provider connected answers with by default.
 */
export const LOTSE_MODEL_POLICY: ModelPolicy = denyFreeHostedModels;

/** Everything the panel needs to build a chat — and proof that it is allowed to. */
export interface LotseEmbedPlan {
    /** lotse's data root, under the app's own. Created by {@link ensureLotseDataRoot}. */
    dataRoot: string;
    paths: LotsePaths;
    /** This app's MCP server, read-only, as the only server the agent gets. */
    mcpServers: McpServer[];
    /** The directory a new conversation runs in — the data root, never a source checkout. */
    cwd: string;
    /** Where a prompt from this pane may go: {@link LOTSE_MODEL_POLICY}, part of the plan so a test sees it. */
    modelPolicy: ModelPolicy;
}

export interface LotseEmbedOptions {
    installation: McpInstallation;
    settings?: UserSettings;
    env?: Record<string, string | undefined>;
    appDataDir?: string;
    /** Overridable for the test; the real one reads `settings.json` and the manifest. */
    assistantEnabled?: boolean;
}

/**
 * The plan, or `null` when this pane must not exist: AI switched off, or another engine chosen.
 *
 * `null` is the whole contract of point 1 above — the caller has nothing to build from, so there is
 * no path on which a process starts.
 */
export function lotseEmbedPlan(options: LotseEmbedOptions): LotseEmbedPlan | null {
    const settings = options.settings ?? loadUserSettings();
    const enabled = options.assistantEnabled ?? isAssistantEnabled(settings);
    if (!enabled) return null;
    if (resolveAiEngine(settings, options.env ?? process.env) !== 'lotse') return null;

    const dataRoot = lotseDataRoot(options.appDataDir ?? userDataDir());
    return {
        dataRoot,
        paths: lotsePathsUnder(dataRoot),
        mcpServers: lotseMcpServers(lotseMcpLaunch(options.installation)),
        cwd: dataRoot,
        modelPolicy: LOTSE_MODEL_POLICY,
    };
}

/**
 * Create the data root 0700 — `chmod` as well as the mode argument, because `mkdir`'s mode is
 * masked by the umask and an existing directory ignores it entirely. Same shape as
 * `saveUserSettings`.
 */
export function ensureLotseDataRoot(root: string): string {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    return root;
}

export type AgentSource = 'bundled' | 'host';

/** The opencode other people configure: the one shipped with the app, in its own isolated config. */
export const DEFAULT_AGENT_SOURCE: AgentSource = 'bundled';

/**
 * The Flatpak has no way to reach the person's own opencode: that needs `org.freedesktop.Flatpak`
 * (host spawn), which the sandbox deliberately lacks.
 */
export function agentSourceLockedToBundled(): boolean {
    return !!process.env.FLATPAK_ID;
}

/** Which opencode the person chose; unset is {@link DEFAULT_AGENT_SOURCE}. Always bundled in a Flatpak. */
export function resolveAgentSource(settings: UserSettings = loadUserSettings()): AgentSource {
    if (agentSourceLockedToBundled()) return 'bundled';
    return settings.aiAgentSource ?? DEFAULT_AGENT_SOURCE;
}

/**
 * The agent the pane AND the one-shot jobs start. The choice is always passed to lotse explicitly —
 * without one lotse prefers a host install, which would put the person's own login behind an app
 * default. A choice that cannot be honoured falls back per lotse and comes back as `note` (and
 * `agent: null` when nothing runs, which is the pane's no-agent page / a job's `no-agent`).
 */
export function resolveLotseAgentIn(context: ResolveContext, source: AgentSource): DefaultResolution {
    const setting: AgentChoice = { id: 'opencode', source };
    return resolveDefaultWithNote(context, setting);
}

/**
 * One resolver for both, so a job never runs on a different agent than the conversation beside it.
 * (A recorded session is resumed by `resolveRecorded` in the pane; a job has no session to resume.)
 *
 * `gatherResolveContext(paths, false)` — no `--version` spawn, nothing waits on a child process.
 */
export function resolveLotseAgent(paths: LotsePaths, source: AgentSource = resolveAgentSource()): DefaultResolution {
    return resolveLotseAgentIn(gatherResolveContext(paths, false), source);
}

/** Whether a launch really carries the read-only marker — what the test asserts on. */
export function launchIsReadOnly(launch: McpLaunch): boolean {
    const direct = launch.env[MCP_READONLY_ENV];
    if (direct) return direct !== '0' && direct !== 'false';
    // The Flatpak form passes the environment as `--env=K=V` flags; `flatpak run` filters the rest.
    return launch.args.includes(`--env=${MCP_READONLY_ENV}=1`);
}
