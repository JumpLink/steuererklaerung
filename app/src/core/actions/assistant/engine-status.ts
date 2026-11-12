/**
 * What the AI engine actually is, and whether it answers — the honest answer to a question the app
 * never let anyone ask.
 *
 * The assistant is a switch labelled "Integrierter Assistent" and nothing else: no provider, no
 * model, no way to find out whether it works before typing a question into it and waiting. The
 * commonest state on a fresh installation is "nobody is logged in", and that state was reported as
 * a dead child process after three retries (see `clients/llm/claude-agent-provider.ts`).
 *
 * The probe deliberately asks the model something trivial rather than pinging a URL: an endpoint
 * that answers proves nothing about credentials, and credentials are what actually fail here.
 */

import type { AgentCommand, LoginSession } from '@lotse/core';

import { getLLMProvider } from '../../clients/llm/index.ts';

export interface EngineStatus {
    /** Provider id as configured (`claude` | `scaleway` | `opencode`). */
    provider: string;
    /** The model that would be used. */
    model: string;
    /** Where the provider choice comes from — env override, or the built-in default. */
    source: 'env' | 'default';
}

/** The engine as configured, without contacting anything. */
export function engineStatus(): EngineStatus {
    const configured = process.env.LLM_PROVIDER?.trim();
    const provider = getLLMProvider();
    return {
        provider: configured || 'claude',
        model: provider.model,
        source: configured ? 'env' : 'default',
    };
}

/**
 * Whether the engine has a provider connected — asked without running a job.
 *
 * - `connected`: at least one provider (or a local custom one) is logged in.
 * - `none`: the agent answered and nobody is logged in; the free hosted models still work.
 * - `unknown`: this engine has no cheap way to tell, or the question failed. Say nothing then —
 *   the probe button is the honest answer for those.
 */
export type EngineConnection = 'connected' | 'none' | 'unknown';

export interface EngineConnectionDeps {
    /** Test seam: the real login server is never opened in a test. */
    probe?: {
        open?: (agent: AgentCommand) => Promise<LoginSession>;
        reason?: (agent: AgentCommand) => string | null;
        timeoutMs?: number;
    };
    command?: AgentCommand;
}

/**
 * Only the `opencode` engine can say: lotse reads the provider catalog off a private login server
 * that is closed again at once. `claude` authenticates inside the Agent SDK and `scaleway` is a bare
 * API key, so neither has a question cheaper than {@link probeEngine} — they are `unknown`.
 */
export async function engineConnection(deps: EngineConnectionDeps = {}): Promise<EngineConnection> {
    try {
        if ((process.env.LLM_PROVIDER ?? '').trim().toLowerCase() !== 'opencode') return 'unknown';
        const lotse = await import('@lotse/core');
        let command = deps.command;
        if (!command) {
            const embed = await import('./lotse-embed.ts');
            const { agent } = embed.resolveLotseAgent(lotse.lotsePathsUnder(embed.lotseDataRoot()));
            if (!agent) return 'unknown';
            command = agent.command;
        }
        const facts = await lotse.probeConnections(command, deps.probe);
        return facts.kind === 'connected' || facts.kind === 'none' ? facts.kind : 'unknown';
    } catch {
        return 'unknown';
    }
}

export interface EngineProbeResult {
    ok: boolean;
    /** German, ready to show. */
    message: string;
    /** Round-trip in ms — only meaningful when `ok`. */
    durationMs: number;
}

/**
 * Ask the engine one trivial question and report what came back.
 *
 * Costs a few tokens on purpose. Anything cheaper — reading a key from the environment, opening a
 * socket — answers a different question than "will the assistant work when I press send", which is
 * the only question worth a button.
 */
export async function probeEngine(): Promise<EngineProbeResult> {
    const started = Date.now();
    try {
        const provider = getLLMProvider();
        const result = await provider.complete({
            system: 'Antworte mit genau einem Wort.',
            user: 'Sag "bereit".',
            maxTokens: 16,
        });
        const durationMs = Date.now() - started;
        const text = result.text.trim().slice(0, 40);
        return {
            ok: true,
            message: `Antwort in ${(durationMs / 1000).toFixed(1)} s: „${text}"`,
            durationMs,
        };
    } catch (err) {
        return {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - started,
        };
    }
}
