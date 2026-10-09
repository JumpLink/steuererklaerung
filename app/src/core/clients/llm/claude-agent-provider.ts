/**
 * LLMProvider backed by the Claude Agent SDK.
 *
 * Authenticates via the logged-in Claude CLI session, so requests draw on the
 * user's Claude subscription (no per-token API key) — set ANTHROPIC_API_KEY only
 * to bill per-token in CI. Transient transport errors are retried with
 * exponential backoff + jitter. Pattern ported from faktenforum/crawler.
 */

import { emptyTelemetry } from './types.ts';
import type { LLMProvider, LLMCompleteOptions, LLMResult, LLMTelemetry } from './types.ts';
import { DEFAULT_CLAUDE_MODEL } from '@steuererklaerung/shared';

// Type-only: the SDK is an optionalDependency and may be absent at runtime, which is why
// {@link loadQuery} imports the VALUE lazily. `import type` is erased, so naming it here costs
// nothing and keeps the annotation out of an inline `import()`.
import type { query as AgentSdkQuery } from '@anthropic-ai/claude-agent-sdk';

// Re-exported for back-compat: the constant now lives in @steuererklaerung/shared (single source).
export { DEFAULT_CLAUDE_MODEL };

const TRANSPORT_RETRY_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

const JSON_INSTRUCTION = 'Respond with a single valid JSON object and nothing else — no prose, no markdown fences.';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A credentials problem: no login, a rejected key, an exhausted balance.
 *
 * Checked FIRST, because the Agent SDK reports it as a dead child process — "process exited with
 * code 1" — which the transient patterns below also match. The commonest failure of all (nobody is
 * logged in) was therefore retried three times with backoff and then reported as a transport
 * problem: three wasted attempts, and an error message that sends the user to look at their
 * network. Retrying a wrong password never becomes a right one.
 */
export function isAuthError(error: unknown): boolean {
    const msg = errMsg(error).toLowerCase();
    return /\b(401|403)\b|unauthoriz|authentication|not logged in|invalid api key|invalid x-api-key|api key|credit balance|anthropic_api_key|please run .?claude login|oauth/.test(
        msg,
    );
}

/**
 * Transient transport failures worth retrying: rate limits / throttles, an
 * overloaded API, 5xx, network blips, and Agent-SDK process-exit crashes (which
 * the SDK surfaces for throttled child processes).
 *
 * An AUTH failure is never one of these, however it is spelled — see {@link isAuthError}.
 */
export function isRetriableError(error: unknown): boolean {
    if (isAuthError(error)) return false;
    const msg = errMsg(error).toLowerCase();
    return /\b(429|529|502|503|504)\b|overloaded|rate.?limit|temporarily limiting|timeout|timed out|econnreset|etimedout|enotfound|fetch failed|socket hang up|process exited|exited with code/.test(
        msg,
    );
}

/**
 * Load the Agent SDK, or say plainly that it is not installed.
 *
 * The package is NOT redistributed with this program: its own LICENSE.md reads "© Anthropic PBC.
 * All rights reserved", which is a licence to USE, not one to pass on inside somebody else's
 * installer. Anthropic's Commercial Terms govern using the service, not shipping their npm package
 * in a .deb. So the assistant is an optional extra a user installs, exactly as this app's central
 * claim — usable without AI — already implies.
 *
 * The failure message therefore has to be a real instruction, not a stack trace: "cannot find
 * module" is the shape of a broken installation, and this is not one.
 */
async function loadQuery(): Promise<typeof AgentSdkQuery> {
    try {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        return sdk.query;
    } catch (error) {
        throw new Error(
            'Der Assistent braucht das Claude Agent SDK, das nicht mitgeliefert wird ' +
                '(Anthropic behält sich alle Rechte vor). Nachinstallieren mit ' +
                '`npm i @anthropic-ai/claude-agent-sdk` — alles Übrige funktioniert ohne. ' +
                `[${errMsg(error)}]`,
        );
    }
}

export class ClaudeAgentProvider implements LLMProvider {
    readonly name = 'claude-agent';
    readonly model: string;

    constructor(modelOverride?: string) {
        this.model = modelOverride || process.env.LLM_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
    }

    async complete(opts: LLMCompleteOptions): Promise<LLMResult> {
        // Lazy-load the Agent SDK so non-LLM commands don't pay its init cost.
        //
        // NOT bundled under GJS, despite what this comment claimed until 2026-08-31: every
        // build script passes `--external @anthropic-ai/claude-agent-sdk` (it must not be
        // redistributed, see loadQuery), so the bare specifier below survives into the bundle
        // and GJS has no node_modules resolver to satisfy it — `Module not found`, even though
        // npm installed it. On Node it resolves. Consequence: the extraction commands are
        // Node-only until a provider that speaks plain HTTPS replaces this one.
        const query = await loadQuery();
        const systemPrompt = opts.json ? `${opts.system}\n\n${JSON_INSTRUCTION}` : opts.system;
        const model = opts.model || this.model;

        let lastError: unknown;
        for (let attempt = 0; attempt <= TRANSPORT_RETRY_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                const backoff =
                    Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
                await sleep(backoff);
            }
            try {
                const telemetry = emptyTelemetry();
                let text: string | undefined;
                // The SDK's message shape varies by version; read fields defensively.
                for await (const message of query({
                    prompt: opts.user,
                    options: { model, systemPrompt, allowedTools: [], maxTurns: 1 },
                }) as AsyncIterable<Record<string, unknown>>) {
                    if (message.type !== 'result') continue;
                    accumulate(telemetry, message);
                    if (message.subtype === 'success' && typeof message.result === 'string') {
                        text = message.result;
                    }
                }
                if (text === undefined) throw new Error('Claude Agent SDK returned no result');
                return { text, telemetry };
            } catch (error) {
                lastError = error;
                // Say what happened. The SDK reports "process exited with code 1" for a missing
                // login, which reads as a crash and sends the user to look at their network.
                if (isAuthError(error)) {
                    throw new Error(
                        'Claude ist nicht angemeldet oder der Schlüssel wird abgelehnt. ' +
                            `Anmeldung prüfen (claude login) oder ANTHROPIC_API_KEY setzen. [${errMsg(error)}]`,
                    );
                }
                if (!isRetriableError(error) || attempt === TRANSPORT_RETRY_ATTEMPTS) throw error;
            }
        }
        throw lastError ?? new Error('Claude Agent SDK query failed');
    }
}

/** Pull cost/usage/duration off a result message (best-effort across SDK versions). */
function accumulate(t: LLMTelemetry, message: Record<string, unknown>): void {
    t.durationMs += typeof message.duration_ms === 'number' ? message.duration_ms : 0;
    t.costUsd += typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0;
    const usage = message.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }> | undefined;
    for (const u of Object.values(usage ?? {})) {
        t.inputTokens += u.inputTokens ?? 0;
        t.outputTokens += u.outputTokens ?? 0;
    }
}
