/**
 * Pluggable LLM engine — provider factory.
 *
 * Select the engine via env:
 *   LLM_PROVIDER = claude (default) | scaleway | opencode (lotse's runJob, ADR 0002)
 *   LLM_MODEL    = model id override (provider-specific)
 *
 * Existing call sites keep using their concrete clients; new code (e.g. the
 * headless document-analysis agent) should depend on getLLMProvider() so the
 * engine can move from Claude → OSS/local later without code changes.
 */

import { extractJsonCandidate, parseJsonLeniently } from '@steuererklaerung/shared';

import { ClaudeAgentProvider } from './claude-agent-provider.ts';
import { AiJobError } from './job-error.ts';
import { OpencodeProvider } from './opencode-provider.ts';
import { ScalewayProvider } from './scaleway-provider.ts';
import type { LLMJsonOptions, LLMJsonResult, LLMProvider } from './types.ts';

export type {
    LLMProvider,
    LLMCompleteOptions,
    LLMJsonOptions,
    LLMJsonResult,
    LLMResult,
    LLMTelemetry,
} from './types.ts';
export { ClaudeAgentProvider } from './claude-agent-provider.ts';
export { ScalewayProvider } from './scaleway-provider.ts';
export { OpencodeProvider } from './opencode-provider.ts';
export { AiJobError, aiJobErrorMessage, type AiJobErrorKind } from './job-error.ts';

export interface GetLLMProviderOptions {
    /** Force a provider, ignoring LLM_PROVIDER. */
    provider?: string;
    /** Model override, ignoring LLM_MODEL. */
    model?: string;
}

/** LLM_PROVIDER values that mean "no AI on purpose". */
const AI_OFF_NAMES = new Set(['none', 'off', 'aus']);

/** The message for a function that needs an AI when none is set up — German, ready to show. */
export const AI_NOT_CONFIGURED_MESSAGE =
    'Dafür ist eine KI nötig, und es ist keine eingerichtet. Richte unter Einstellungen → KI-Engine eine ein ' +
    '(LLM_PROVIDER=claude, scaleway oder opencode) oder trage die Angaben von Hand ein.';

let providerOverride: LLMProvider | null = null;

/** Test seam: make {@link getLLMProvider} return this provider (null removes it). */
export function setLLMProviderOverride(provider: LLMProvider | null): void {
    providerOverride = provider;
}

/**
 * Build the configured LLM provider. Defaults to the Claude Agent SDK
 * (subscription auth). Throws on an unknown provider name, and with
 * {@link AI_NOT_CONFIGURED_MESSAGE} when AI is switched off (`LLM_PROVIDER=none`).
 */
export function getLLMProvider(opts: GetLLMProviderOptions = {}): LLMProvider {
    if (providerOverride) return providerOverride;
    const name = (opts.provider ?? process.env.LLM_PROVIDER ?? 'claude').trim().toLowerCase();
    if (AI_OFF_NAMES.has(name)) throw new Error(AI_NOT_CONFIGURED_MESSAGE);
    switch (name) {
        case 'claude':
        case 'claude-agent':
        case 'anthropic':
            return new ClaudeAgentProvider(opts.model);
        case 'scaleway':
            return new ScalewayProvider(opts.model);
        case 'opencode':
            return new OpencodeProvider({ model: opts.model });
        default:
            throw new Error(`Unknown LLM_PROVIDER "${name}". Use "claude", "scaleway" or "opencode".`);
    }
}

/**
 * One completion whose answer is a value of `opts.schema`, or an {@link AiJobError}.
 *
 * The opencode provider validates inside lotse's `runJob`. The others answer with text, which is
 * read the way it always was (fences, prose, `jsonrepair`) and then held to the same schema — so
 * every provider fails the same way: `'malformed'` for no JSON, `'invalid'` for the wrong shape.
 * Neither error keeps the answer or the schema's complaint; both are about a private document.
 */
export async function completeJson<T>(provider: LLMProvider, opts: LLMJsonOptions<T>): Promise<LLMJsonResult<T>> {
    if (provider.completeJson) return provider.completeJson(opts);
    const { schema, ...rest } = opts;
    const { text, telemetry } = await provider.complete({ ...rest, json: true });
    const parsed = parseJsonLeniently(extractJsonCandidate(text) ?? text);
    if (parsed == null || typeof parsed !== 'object') throw new AiJobError('malformed');
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new AiJobError('invalid');
    return { value: checked.data, telemetry };
}
