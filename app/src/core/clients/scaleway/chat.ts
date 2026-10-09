/**
 * Scaleway Generative APIs – OpenAI-compatible Chat Completions.
 * POST {baseUrl}/chat/completions for text/JSON extraction (e.g. invoice fields from OCR).
 * Uses env: SCALEWAY_API_KEY, SCALEWAY_PROJECT_ID or SCALEWAY_BASE_URL.
 */

export interface ScalewayChatConfig {
    baseUrl: string;
    apiKey: string;
    model?: string;
}

export const DEFAULT_MODEL = 'mistral-small-3.2-24b-instruct-2506';

function normalizeBaseUrl(url: string): string {
    const u = url.replace(/\/+$/, '');
    return u.endsWith('/v1') ? u : `${u}/v1`;
}

/**
 * Build Scaleway Chat config from environment.
 * Base URL: if SCALEWAY_PROJECT_ID is set, use https://api.scaleway.ai/{project_id}/v1;
 * otherwise use SCALEWAY_BASE_URL (default https://api.scaleway.ai/v1).
 */
export function getScalewayChatConfig(): { config: ScalewayChatConfig } | { error: string } {
    const apiKey = process.env.SCALEWAY_API_KEY?.trim();
    if (!apiKey) {
        return {
            error: 'Scaleway ist nicht eingerichtet: SCALEWAY_API_KEY fehlt (in .env eintragen). Ohne KI die Angaben von Hand eintragen.',
        };
    }
    const projectId = process.env.SCALEWAY_PROJECT_ID?.trim();
    const baseUrlRaw = process.env.SCALEWAY_BASE_URL?.trim();
    let baseUrl: string;
    if (projectId) {
        baseUrl = `https://api.scaleway.ai/${projectId}/v1`;
    } else if (baseUrlRaw) {
        baseUrl = baseUrlRaw;
    } else {
        baseUrl = 'https://api.scaleway.ai/v1';
    }
    baseUrl = normalizeBaseUrl(baseUrl);
    const model = process.env.SCALEWAY_CHAT_MODEL?.trim() || DEFAULT_MODEL;
    return {
        config: { baseUrl, apiKey, model },
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatCompletionOptions {
    max_tokens?: number;
    /** Request JSON object in response (OpenAI response_format). */
    response_format?: { type: 'json_object' };
}

/**
 * Call Scaleway Chat Completions (OpenAI-compatible). Returns the assistant message content.
 * Retries up to 3 times on 5xx or network errors.
 */
export async function chatCompletion(
    config: ScalewayChatConfig,
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
): Promise<string> {
    const base = config.baseUrl;
    const url = `${base}/chat/completions`;
    const rawMaxTokens = options.max_tokens ?? 2048;
    const max_tokens = Math.max(1, Math.min(8192, Math.floor(rawMaxTokens)));
    const body: Record<string, unknown> = {
        model: config.model ?? DEFAULT_MODEL,
        messages,
        max_tokens,
    };
    if (options.response_format) {
        body.response_format = options.response_format;
    }

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(body),
            });
            const text = await res.text();

            if (!res.ok) {
                let errMsg: string;
                try {
                    const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
                    errMsg = j.error?.message ?? j.message ?? text;
                } catch {
                    errMsg = text || res.statusText;
                }
                const error = new Error(`Scaleway Chat API (${res.status}): ${errMsg}`);
                if (res.status >= 500 && attempt < maxAttempts) {
                    lastError = error;
                    await new Promise((r) => setTimeout(r, 1500 * attempt));
                    continue;
                }
                throw error;
            }

            const data = JSON.parse(text) as {
                choices?: Array<{ message?: { content?: string } }>;
            };
            const content = data.choices?.[0]?.message?.content;
            return typeof content === 'string' ? content : '';
        } catch (e) {
            if (e instanceof Error && attempt < maxAttempts) {
                lastError = e;
                await new Promise((r) => setTimeout(r, 1500 * attempt));
                continue;
            }
            throw e;
        }
    }

    throw lastError ?? new Error('Scaleway Chat API failed');
}
