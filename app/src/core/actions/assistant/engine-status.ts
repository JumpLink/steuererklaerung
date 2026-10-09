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

import { getLLMProvider } from '../../clients/llm/index.ts';

export interface EngineStatus {
    /** Provider id as configured (`claude` | `scaleway`). */
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
