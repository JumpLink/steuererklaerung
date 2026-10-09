/**
 * LLMProvider backed by Scaleway Generative APIs (OpenAI-compatible).
 * Thin wrapper over the existing Scaleway chat client — no behaviour change for
 * existing call sites, which keep using the client directly.
 */

import { getScalewayChatConfig, chatCompletion, DEFAULT_MODEL } from '../scaleway/index.ts';
import type { ScalewayChatConfig } from '../scaleway/index.ts';
import { emptyTelemetry } from './types.ts';
import type { LLMProvider, LLMCompleteOptions, LLMResult } from './types.ts';

export class ScalewayProvider implements LLMProvider {
    readonly name = 'scaleway';
    readonly model: string;
    private readonly config: ScalewayChatConfig;

    constructor(modelOverride?: string) {
        const resolved = getScalewayChatConfig();
        if ('error' in resolved) throw new Error(resolved.error);
        this.config = modelOverride ? { ...resolved.config, model: modelOverride } : resolved.config;
        this.model = this.config.model ?? DEFAULT_MODEL;
    }

    async complete(opts: LLMCompleteOptions): Promise<LLMResult> {
        const started = Date.now();
        const text = await chatCompletion(
            opts.model ? { ...this.config, model: opts.model } : this.config,
            [
                { role: 'system', content: opts.system },
                { role: 'user', content: opts.user },
            ],
            {
                max_tokens: opts.maxTokens,
                ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
            },
        );
        const telemetry = emptyTelemetry();
        telemetry.durationMs = Date.now() - started;
        return { text, telemetry };
    }
}
