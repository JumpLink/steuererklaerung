import { describe, it, expect } from '@gjsify/unit';
import { z } from 'zod';
import type { AgentHandle, OpenAgentOptions } from '@lotse/core';
import {
    AiJobError,
    completeJson,
    getLLMProvider,
    OpencodeProvider,
    type LLMProvider,
} from '../../../src/core/clients/llm/index.ts';
import { ExtractedInvoiceFieldsSchema } from '../../../src/core/actions/paperless/extract-invoice.ts';
import { emptyTelemetry } from '../../../src/core/clients/llm/types.ts';

// Synthetic only: a fake agent stands in for `opencode acp`, nothing is spawned and no document is read.
const SECRET = 'Musterfirma GmbH, Rechnung 4711';

interface FakeAgentOptions {
    answer: string;
    models?: string[];
    current?: string;
    stopReason?: string;
    failNewSession?: Error;
    /** The turn never ends: only a timeout or an abort stops the job. */
    hang?: boolean;
}

function fakeAgent(fake: FakeAgentOptions): (options: OpenAgentOptions) => Promise<AgentHandle> {
    const models = fake.models ?? ['anthropic/claude-sonnet-5-5'];
    let current = fake.current ?? models[0];
    const configOptions = () => [
        {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: current,
            options: models.map((value) => ({ value, name: value })),
        },
    ];
    return async () => {
        let listener: ((notification: unknown) => void) | null = null;
        const client = {
            newSession: async () => {
                if (fake.failNewSession) throw fake.failNewSession;
                return { sessionId: 's1', configOptions: configOptions() };
            },
            setConfigOption: async ({ value }: { value: string }) => {
                current = value;
                return { configOptions: configOptions() };
            },
            onSessionUpdate: (callback: (notification: unknown) => void) => {
                listener = callback;
                return () => {
                    listener = null;
                };
            },
            prompt: async () => {
                if (fake.hang) return new Promise<never>(() => {});
                listener?.({
                    sessionId: 's1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: fake.answer } },
                });
                return { stopReason: fake.stopReason ?? 'end_turn' };
            },
            cancel: () => {},
        };
        return { client, logLines: [], agentInfo: 'fake 0.0.0', close: () => {} } as unknown as AgentHandle;
    };
}

function provider(fake: FakeAgentOptions, model?: string, timeoutMs = 5_000): OpencodeProvider {
    return new OpencodeProvider({
        model,
        command: { command: 'fake-agent', args: [] } as never,
        cwd: '/tmp',
        open: fakeAgent(fake),
        timeoutMs,
    });
}

const Answer = z.object({ document_type_id: z.number().int().nullable(), reason: z.string() });

async function failure(run: () => Promise<unknown>): Promise<AiJobError> {
    try {
        await run();
    } catch (error) {
        if (error instanceof AiJobError) return error;
        throw error;
    }
    throw new Error('expected an AiJobError');
}

export default async () => {
    await describe('OpencodeProvider (runJob)', async () => {
        await it('returns the parsed value and the model the agent used', async () => {
            const result = await provider({ answer: '{"document_type_id": 3, "reason": "fits"}' }).completeJson({
                system: 's',
                user: 'u',
                schema: Answer,
            });
            expect(result.value.document_type_id).toBe(3);
            expect(result.model).toBe('anthropic/claude-sonnet-5-5');
        });

        await it('reads the last ```json block of a prose answer', async () => {
            const answer = 'Here you go:\n```json\n{"document_type_id": null, "reason": "none"}\n```';
            const result = await provider({ answer }).completeJson({ system: 's', user: 'u', schema: Answer });
            expect(result.value.document_type_id).toBe(null);
        });

        await it('complete() answers text through the same job', async () => {
            const result = await provider({ answer: '{"text": "hallo"}' }).complete({ system: 's', user: 'u' });
            expect(result.text).toBe('hallo');
        });

        await it('fails as malformed without keeping the answer', async () => {
            const error = await failure(() =>
                provider({ answer: `no json, just ${SECRET}` }).completeJson({
                    system: 's',
                    user: 'u',
                    schema: Answer,
                }),
            );
            expect(error.kind).toBe('malformed');
            expect(error.message.includes(SECRET)).toBe(false);
            expect(JSON.stringify(error).includes(SECRET)).toBe(false);
        });

        await it('fails as invalid without keeping the answer or the complaint', async () => {
            const answer = `{"document_type_id": "drei", "reason": "${SECRET}"}`;
            const error = await failure(() =>
                provider({ answer }).completeJson({ system: 's', user: 'u', schema: Answer }),
            );
            expect(error.kind).toBe('invalid');
            expect(error.message.includes(SECRET)).toBe(false);
            expect(error.cause).toBeUndefined();
        });

        await it('denies a free hosted model before anything is sent', async () => {
            const error = await failure(() =>
                provider(
                    { answer: '{"document_type_id": 1, "reason": "x"}', models: ['opencode/fledge-alpha-free'] },
                    'opencode/fledge-alpha-free',
                ).completeJson({ system: 's', user: 'u', schema: Answer }),
            );
            expect(error.kind).toBe('denied');
        });

        await it('denies a free hosted model the agent has selected by default', async () => {
            const error = await failure(() =>
                provider({
                    answer: '{"document_type_id": 1, "reason": "x"}',
                    models: ['opencode/fledge-alpha-free', 'anthropic/claude-sonnet-5-5'],
                }).completeJson({ system: 's', user: 'u', schema: Answer }),
            );
            expect(error.kind).toBe('denied');
        });

        await it('maps a turn that did not end normally to refused', async () => {
            const error = await failure(() =>
                provider({ answer: '{}', stopReason: 'refusal' }).completeJson({
                    system: 's',
                    user: 'u',
                    schema: Answer,
                }),
            );
            expect(error.kind).toBe('refused');
        });

        await it('maps a crashed agent to agent', async () => {
            const error = await failure(() =>
                provider({ answer: '{}', failNewSession: new Error('pipe closed') }).completeJson({
                    system: 's',
                    user: 'u',
                    schema: Answer,
                }),
            );
            expect(error.kind).toBe('agent');
            expect(error.message.includes('pipe closed')).toBe(false);
        });

        await it('maps an already-aborted signal to cancelled without starting anything', async () => {
            let opened = false;
            const inner = fakeAgent({ answer: '{}' });
            const p = new OpencodeProvider({
                command: { command: 'fake-agent', args: [] } as never,
                cwd: '/tmp',
                open: (options) => {
                    opened = true;
                    return inner(options);
                },
                timeoutMs: 5_000,
            });
            const controller = new AbortController();
            controller.abort();
            const error = await failure(() =>
                p.completeJson({ system: 's', user: 'u', schema: Answer, signal: controller.signal }),
            );
            expect(error.kind).toBe('cancelled');
            expect(opened).toBe(false);
        });

        await it('maps an agent that never answers to timeout', async () => {
            const error = await failure(() =>
                provider({ answer: '{}', hang: true }, undefined, 50).completeJson({
                    system: 's',
                    user: 'u',
                    schema: Answer,
                }),
            );
            expect(error.kind).toBe('timeout');
        });

        await it('maps an abort during the turn to cancelled', async () => {
            const controller = new AbortController();
            const run = provider({ answer: '{}', hang: true }).completeJson({
                system: 's',
                user: 'u',
                schema: Answer,
                signal: controller.signal,
            });
            setTimeout(() => controller.abort(), 20);
            const error = await failure(() => run);
            expect(error.kind).toBe('cancelled');
        });
    });

    await describe('invoice extraction schema', async () => {
        await it('drops a wrong-typed amount instead of failing the answer', async () => {
            const parsed = ExtractedInvoiceFieldsSchema.parse({
                invoice_number: 'R-1',
                total_net: '12,50',
                tax_amount: '19%',
                total_gross: 119,
            });
            expect(parsed.invoice_number).toBe('R-1');
            expect(parsed.total_net).toBe(undefined);
            expect(parsed.tax_amount).toBe(undefined);
            expect(parsed.total_gross).toBe(119);
        });
    });

    await describe('completeJson fallback for text providers', async () => {
        const textProvider = (text: string): LLMProvider => ({
            name: 'fake',
            model: 'fake-model',
            complete: async () => ({ text, telemetry: emptyTelemetry() }),
        });

        await it('reads fenced JSON and holds it to the schema', async () => {
            const result = await completeJson(textProvider('```json\n{"document_type_id": 2, "reason": "r"}\n```'), {
                system: 's',
                user: 'u',
                schema: Answer,
            });
            expect(result.value.document_type_id).toBe(2);
        });

        await it('fails as malformed and invalid like the opencode path', async () => {
            const malformed = await failure(() =>
                // No comma: jsonrepair reads "a, b" as an array, which is `invalid`, not `malformed`.
                completeJson(textProvider('Keine Rechnung erkannt'), { system: 's', user: 'u', schema: Answer }),
            );
            expect(malformed.kind).toBe('malformed');
            const invalid = await failure(() =>
                completeJson(textProvider(`{"reason": "${SECRET}"}`), { system: 's', user: 'u', schema: Answer }),
            );
            expect(invalid.kind).toBe('invalid');
            expect(invalid.message.includes(SECRET)).toBe(false);
        });
    });

    await describe('getLLMProvider("opencode")', async () => {
        await it('builds the opencode provider without starting an agent', async () => {
            const p = getLLMProvider({ provider: 'opencode', model: 'anthropic/claude-sonnet-5-5' });
            expect(p).toBeInstanceOf(OpencodeProvider);
            expect(p.name).toBe('opencode');
            expect(p.model).toBe('anthropic/claude-sonnet-5-5');
        });
    });
};
