/**
 * Pluggable LLM provider interface.
 *
 * Decouples reasoning from the concrete model/engine so it can be swapped via
 * config (Claude subscription now → Scaleway → OSS/local later) without touching
 * call sites. See ./index.ts for the factory and the structured-output helper.
 */

import type { ZodType } from 'zod';

/** Token/cost telemetry for one completion (best-effort; providers may omit). */
export interface LLMTelemetry {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
}

export function emptyTelemetry(): LLMTelemetry {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

/** Accumulate b into a (in place) and return a. */
export function addTelemetry(a: LLMTelemetry, b: LLMTelemetry): LLMTelemetry {
    a.costUsd += b.costUsd;
    a.inputTokens += b.inputTokens;
    a.outputTokens += b.outputTokens;
    a.durationMs += b.durationMs;
    return a;
}

export interface LLMCompleteOptions {
    /** System prompt / instructions. */
    system: string;
    /** User prompt / the content to act on. */
    user: string;
    /** Hint the model to return a single JSON object. */
    json?: boolean;
    /** Soft cap on output tokens (provider-dependent). */
    maxTokens?: number;
    /** Per-call model override (falls back to the provider's default model). */
    model?: string;
}

export interface LLMResult {
    /** The model's raw text reply. */
    text: string;
    telemetry: LLMTelemetry;
}

export interface LLMJsonOptions<T> extends Omit<LLMCompleteOptions, 'json'> {
    /** Validates the answer; a mismatch is an `AiJobError` of kind `'invalid'`, never a cast. */
    schema: ZodType<T>;
}

export interface LLMJsonResult<T> {
    value: T;
    telemetry: LLMTelemetry;
    /** The model that answered, when the provider knows it (opencode reports the agent's current one). */
    model?: string;
}

/** A reasoning engine. Implementations: ClaudeAgentProvider, ScalewayProvider, OpencodeProvider. */
export interface LLMProvider {
    /** Stable identifier, e.g. "claude-agent" or "scaleway". */
    readonly name: string;
    /** The default model id this provider will use. */
    readonly model: string;
    /** Run one completion and return the raw text. */
    complete(opts: LLMCompleteOptions): Promise<LLMResult>;
    /**
     * Run one completion whose answer is a validated JSON value. Optional: `completeJson()` in
     * ./index.ts falls back to `complete` plus the same schema for providers without it.
     */
    completeJson?<T>(opts: LLMJsonOptions<T>): Promise<LLMJsonResult<T>>;
}
