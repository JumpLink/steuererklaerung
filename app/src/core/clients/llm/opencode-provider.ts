/**
 * LLMProvider backed by lotse's headless job API (`runJob`) — ADR 0002, step 4.
 *
 * Each call is one job: a fresh agent process, one session, one turn, closed on every path. It
 * runs against the same agent, data directory and login as the lotse assistant pane
 * (`actions/assistant/lotse-embed.ts`), under the same model policy: a free hosted model is refused
 * before the prompt leaves this machine. Permissions stay lotse's default, deny-all — a job reads
 * the text it is given and needs no tool.
 *
 * lotse is loaded lazily, like the Agent SDK in `claude-agent-provider.ts`: building this provider
 * (engine status, the factory) must not cost the agent's import, and nothing spawns until a job runs.
 *
 * **Failures are `AiJobError`s built from lotse's `JobError.kind` alone.** `JobError.output` (the
 * model's answer) and `JobError.cause` (the parser's complaint) describe a private document and
 * are dropped here, so no log line downstream can print them.
 */

import { z, type ZodType } from 'zod';

import type { AgentCommand, AgentHandle, OpenAgentOptions } from '@lotse/core';

import { AiJobError, isAiJobErrorKind } from './job-error.ts';
import { emptyTelemetry } from './types.ts';
import type { LLMCompleteOptions, LLMJsonOptions, LLMJsonResult, LLMProvider, LLMResult } from './types.ts';

/** Shown as the model when none is configured: the agent then uses its own current model. */
export const OPENCODE_AGENT_MODEL = 'agent default';

export interface OpencodeProviderOptions {
    /** Model id as the agent names it (opencode: `provider/model`). Default: `LLM_MODEL`, else the agent's own. */
    model?: string;
    /** Test seams — the real ones resolve the agent and the data root like the assistant pane. */
    command?: AgentCommand;
    cwd?: string;
    open?: (options: OpenAgentOptions) => Promise<AgentHandle>;
    timeoutMs?: number;
}

/** `complete()` is a job too; its answer is wrapped so `runJob` has JSON to read. */
const TextAnswer = z.object({ text: z.string() });

export class OpencodeProvider implements LLMProvider {
    readonly name = 'opencode';
    readonly model: string;
    private readonly configuredModel: string | undefined;

    constructor(private readonly options: OpencodeProviderOptions = {}) {
        this.configuredModel = options.model || process.env.LLM_MODEL?.trim() || undefined;
        this.model = this.configuredModel ?? OPENCODE_AGENT_MODEL;
    }

    async complete(opts: LLMCompleteOptions): Promise<LLMResult> {
        const { value, telemetry } = await this.completeJson({ ...opts, schema: TextAnswer });
        return { text: value.text, telemetry };
    }

    async completeJson<T>(opts: LLMJsonOptions<T>): Promise<LLMJsonResult<T>> {
        const started = Date.now();
        const lotse = await import('@lotse/core');
        const embed = await import('../../actions/assistant/lotse-embed.ts');
        let command = this.options.command;
        if (!command) {
            const paths = lotse.lotsePathsUnder(embed.lotseDataRoot());
            const { agent } = lotse.resolveDefaultWithNote(lotse.gatherResolveContext(paths, false), null);
            if (!agent) throw new AiJobError('no-agent');
            command = agent.command;
        }
        const model = opts.model || this.configuredModel;
        const schema: ZodType<T> = opts.schema;
        try {
            const result = await lotse.runJob({
                command,
                cwd: this.options.cwd ?? embed.ensureLotseDataRoot(embed.lotseDataRoot()),
                prompt: `${opts.system}\n\n${opts.user}`,
                parse: (value) => schema.parse(value),
                schema: z.toJSONSchema(schema, { io: 'input' }),
                modelPolicy: embed.LOTSE_MODEL_POLICY,
                ...(model ? { model } : {}),
                ...(this.options.open ? { open: this.options.open } : {}),
                ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
            });
            const telemetry = emptyTelemetry();
            telemetry.durationMs = Date.now() - started;
            return { value: result.value, telemetry, model: result.model };
        } catch (error) {
            if (error instanceof lotse.JobError) {
                throw new AiJobError(isAiJobErrorKind(error.kind) ? error.kind : 'agent');
            }
            // Only a programmer error (runJob's TypeError) gets here; it carries no job data.
            throw error;
        }
    }
}
