/**
 * The three one-shot AI document jobs propagate an abort signal all the way to the provider:
 * cancelling stops the in-flight AI call and rethrows as AiJobError('cancelled').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { setLLMProviderOverride, type LLMProvider } from '../../../../../src/core/clients/llm/index.ts';
import { AiJobError } from '../../../../../src/core/clients/llm/job-error.ts';
import { extractInvoiceFields } from '../../../../../src/core/actions/paperless/extract-invoice.ts';
import { classifyDocuments } from '../../../../../src/core/actions/paperless/classify-documents.ts';
import { reviewMetadata } from '../../../../../src/core/actions/paperless/review-metadata.ts';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        text: async () => JSON.stringify(body),
    };
}

/** A provider that waits until the signal aborts, then throws AiJobError('cancelled'). */
function abortWatchingProvider(): LLMProvider {
    return {
        name: 'abort-watcher',
        model: 'none',
        complete: async () => ({ text: '', telemetry: { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 } }),
        completeJson: async ({ signal }) => {
            await new Promise<void>((resolve, reject) => {
                const check = () => {
                    if (signal?.aborted) {
                        reject(new AiJobError('cancelled'));
                    } else {
                        setTimeout(check, 5);
                    }
                };
                check();
            });
            throw new Error('unreachable');
        },
    };
}

const PAPERLESS_CONFIG = {
    baseUrl: 'https://pl.test',
    headers: { Authorization: 'Token token', Accept: 'application/json; version=9' },
    document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
    custom_field_ids: {},
    tag_ids: {},
    select_field_options: {},
    own_correspondent_ids: [],
    preferred_language: 'de',
};

export default async () => {
    await describe('AI job cancellation propagates through core actions', async () => {
        beforeEach(() => {
            process.env.PAPERLESS_BASE_URL = PAPERLESS_CONFIG.baseUrl;
            process.env.PAPERLESS_API_TOKEN = 'token';
            setLLMProviderOverride(abortWatchingProvider());
        });

        afterEach(() => {
            vi.unstubAllGlobals();
            setLLMProviderOverride(null);
            delete process.env.PAPERLESS_BASE_URL;
            delete process.env.PAPERLESS_API_TOKEN;
        });

        await it('extractInvoiceFields rethrows cancelled when the signal aborts mid-run', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string) => {
                    if (url.includes('/api/documents/42/')) {
                        return response(200, {
                            id: 42,
                            document_type: 1,
                            title: 'Invoice',
                            content: 'Rechnung 4711',
                            original_file_name: 'inv.pdf',
                            tags: [],
                            custom_fields: [],
                        });
                    }
                    if (url.includes('/api/documents/')) {
                        return response(200, {
                            count: 1,
                            results: [
                                {
                                    id: 42,
                                    document_type: 1,
                                    title: 'Invoice',
                                    content: 'Rechnung 4711',
                                    original_file_name: 'inv.pdf',
                                    tags: [],
                                    custom_fields: [],
                                },
                            ],
                            next: null,
                        });
                    }
                    return response(200, {});
                }),
            );

            const controller = new AbortController();
            const run = extractInvoiceFields(PAPERLESS_CONFIG as never, 1, { signal: controller.signal });
            setTimeout(() => controller.abort(), 30);

            let error: unknown;
            try {
                await run;
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(AiJobError);
            expect((error as AiJobError).kind).toBe('cancelled');
        });

        await it('classifyDocuments rethrows cancelled when the signal aborts mid-run', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string) => {
                    if (url.includes('/api/document_types/')) {
                        return response(200, { count: 1, results: [{ id: 1, name: 'Invoice' }], next: null });
                    }
                    if (url.includes('/api/documents/')) {
                        return response(200, {
                            count: 1,
                            results: [{ id: 42, document_type: 1, title: 'Doc', content: 'Text', tags: [] }],
                            next: null,
                        });
                    }
                    return response(200, {});
                }),
            );

            const controller = new AbortController();
            const run = classifyDocuments({ signal: controller.signal });
            setTimeout(() => controller.abort(), 30);

            let error: unknown;
            try {
                await run;
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(AiJobError);
            expect((error as AiJobError).kind).toBe('cancelled');
        });

        await it('reviewMetadata rethrows cancelled when the signal aborts mid-run', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string) => {
                    if (url.includes('/api/correspondents/')) {
                        return response(200, { count: 0, results: [], next: null });
                    }
                    if (url.includes('/api/document_types/')) {
                        return response(200, { count: 0, results: [], next: null });
                    }
                    if (url.includes('/api/documents/')) {
                        return response(200, {
                            count: 1,
                            results: [{ id: 42, title: 'Doc', content: 'Text', tags: [], custom_fields: [] }],
                            next: null,
                        });
                    }
                    if (url.includes('/api/documents/42/')) {
                        return response(200, {
                            id: 42,
                            title: 'Doc',
                            content: 'Text',
                            tags: [],
                            custom_fields: [],
                        });
                    }
                    return response(200, {});
                }),
            );

            const controller = new AbortController();
            const run = reviewMetadata(PAPERLESS_CONFIG as never, { signal: controller.signal });
            setTimeout(() => controller.abort(), 30);

            let error: unknown;
            try {
                await run;
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(AiJobError);
            expect((error as AiJobError).kind).toBe('cancelled');
        });
    });
};
