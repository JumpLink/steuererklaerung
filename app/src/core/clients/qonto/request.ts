/**
 * Shared request layer for Qonto API (v2).
 * Environment is selected via QONTO_ENV=production|staging. Credentials can be set per env with prefixes:
 * - Production: QONTO_PRODUCTION_SIGN_IN, QONTO_PRODUCTION_SECRET_KEY (fallback: QONTO_SIGN_IN, QONTO_SECRET_KEY)
 * - Staging: QONTO_STAGING_SIGN_IN, QONTO_STAGING_SECRET_KEY, QONTO_STAGING_TOKEN (fallback: QONTO_SIGN_IN, QONTO_SECRET_KEY)
 * Optional QONTO_BASE_URL overrides the env-specific base URL.
 */

import { httpErrorSnippet } from '@steuererklaerung/shared';
import type { QontoListMeta, QontoListResponse } from './types.ts';

const DEFAULT_BASE_URL_PRODUCTION = 'https://thirdparty.qonto.com';
const DEFAULT_BASE_URL_STAGING = 'https://thirdparty-sandbox.staging.qonto.co';

export type QontoEnv = 'production' | 'staging';

export interface QontoConfig {
    baseUrl: string;
    headers: Record<string, string>;
    env: QontoEnv;
}

export interface ConfigResult {
    config?: QontoConfig;
    error?: string;
}

/**
 * Resolve current Qonto environment from QONTO_ENV (default: production).
 */
export function getQontoEnv(): QontoEnv {
    const raw = process.env.QONTO_ENV?.toLowerCase().trim();
    return raw === 'staging' ? 'staging' : 'production';
}

/**
 * Default bank account ID for the current env. Prefers QONTO_<ENV>_DEFAULT_BANK_ACCOUNT_ID, then QONTO_DEFAULT_BANK_ACCOUNT_ID.
 */
export function getDefaultBankAccountId(): string | undefined {
    const env = getQontoEnv();
    const envKey =
        env === 'staging' ? 'QONTO_STAGING_DEFAULT_BANK_ACCOUNT_ID' : 'QONTO_PRODUCTION_DEFAULT_BANK_ACCOUNT_ID';
    return process.env[envKey]?.trim() || process.env.QONTO_DEFAULT_BANK_ACCOUNT_ID?.trim() || undefined;
}

/**
 * Get base URL and headers for the current QONTO_ENV. Returns error if credentials for that env are missing.
 */
export function config(): ConfigResult {
    const env = getQontoEnv();

    const signIn =
        env === 'production'
            ? process.env.QONTO_PRODUCTION_SIGN_IN?.trim() || process.env.QONTO_SIGN_IN?.trim()
            : process.env.QONTO_STAGING_SIGN_IN?.trim() || process.env.QONTO_SIGN_IN?.trim();
    const secretKey =
        env === 'production'
            ? process.env.QONTO_PRODUCTION_SECRET_KEY?.trim() || process.env.QONTO_SECRET_KEY?.trim()
            : process.env.QONTO_STAGING_SECRET_KEY?.trim() || process.env.QONTO_SECRET_KEY?.trim();

    if (!signIn || !secretKey) {
        const prefix = env === 'production' ? 'QONTO_PRODUCTION_' : 'QONTO_STAGING_';
        return {
            error: !signIn
                ? `${prefix}SIGN_IN (or QONTO_SIGN_IN) not set`
                : `${prefix}SECRET_KEY (or QONTO_SECRET_KEY) not set`,
        };
    }

    if (env === 'staging') {
        const stagingToken = process.env.QONTO_STAGING_TOKEN?.trim();
        if (!stagingToken) {
            return { error: 'QONTO_STAGING_TOKEN not set (required for staging)' };
        }
    }

    const defaultBaseUrl = env === 'staging' ? DEFAULT_BASE_URL_STAGING : DEFAULT_BASE_URL_PRODUCTION;
    const baseUrl = (process.env.QONTO_BASE_URL?.trim() ?? defaultBaseUrl).replace(/\/$/, '');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `${signIn}:${secretKey}`,
    };
    const stagingToken = process.env.QONTO_STAGING_TOKEN?.trim();
    if (stagingToken) {
        headers['X-Qonto-Staging-Token'] = stagingToken;
    }
    return { config: { baseUrl, headers, env } };
}

function getConfig(): QontoConfig {
    const result = config();
    if (result.error || !result.config) {
        throw new Error(result.error ?? 'Qonto config unavailable');
    }
    return result.config;
}

/**
 * Build full URL for a path relative to baseUrl/v2/
 */
function url(path: string, baseUrl: string): string {
    const normalized = path.replace(/^\//, '');
    return `${baseUrl}/v2/${normalized}`;
}

/**
 * Build query string from record. Arrays are sent as key[]=v1&key[]=v2.
 */
function buildQuery(query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) {
                params.append(`${k}[]`, String(item));
            }
        } else {
            params.set(k, String(v));
        }
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

/**
 * How long a Qonto request may take before it is abandoned, in milliseconds.
 *
 * Without one, an unreachable API does not fail — it HANGS, and the view waiting on it sits on its
 * spinner forever with no error and no way back. A hostname that does not resolve fails fast; one
 * that accepts the connection and never answers does not, which is what a captive portal, a
 * half-open VPN or an API incident actually look like.
 *
 * Thirty seconds: Qonto is a hosted API answering in well under a second, so anything near this is
 * already broken — unlike a self-hosted Paperless, which is legitimately slow and gets sixty.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** An AbortSignal that fires after {@link REQUEST_TIMEOUT_MS}; undefined where the API is absent. */
function timeoutSignal(): AbortSignal | undefined {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;
}

/**
 * `fetch` with the timeout attached and the abort translated into something a user can act on —
 * the one place every Qonto request goes through, so a new endpoint cannot forget it.
 */
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const signal = timeoutSignal();
    try {
        return await fetch(input, signal ? { ...init, signal } : init);
    } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
            const seconds = Math.round(REQUEST_TIMEOUT_MS / 1000);
            throw new Error(
                `Qonto hat nach ${seconds} s nicht geantwortet. Besteht eine Internetverbindung, und stimmen die Zugangsdaten?`,
            );
        }
        throw error instanceof Error ? error : new Error(String(error));
    }
}

/**
 * GET request to an absolute URL without adding any auth headers. Use for pre-signed URLs (e.g. Qonto
 * attachment download URLs), which already contain auth in the query string; adding headers causes
 * "Only one auth mechanism allowed" (e.g. from S3).
 */
export async function getBinaryPreSignedUrl(fullUrl: string): Promise<ArrayBuffer> {
    const res = await fetchWithTimeout(fullUrl, { method: 'GET' });
    const buf = await res.arrayBuffer();
    if (!res.ok) {
        const body = new TextDecoder().decode(buf);
        throw new Error(httpErrorSnippet(res, body));
    }
    return buf;
}

/**
 * GET request. Path is relative to baseUrl/v2/. Throws on HTTP error.
 */
export async function get<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const fullUrl = url(path, baseUrl) + buildQuery(query);
    const res = await fetchWithTimeout(fullUrl, { method: 'GET', headers });
    const body = await res.text();
    if (!res.ok) {
        const msg = httpErrorSnippet(res, body);
        if (res.status === 401 && baseUrl.includes('sandbox')) {
            throw new Error(`${msg} Use API key from Sandbox web app (Developer Portal → Toolkit → Sandbox web app).`);
        }
        throw new Error(msg);
    }
    if (!body || body.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(body) as T;
}

/**
 * POST request with JSON body. Path relative to baseUrl/v2/. Throws on HTTP error.
 */
export async function post<T>(
    path: string,
    body: Record<string, unknown> = {},
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const fullUrl = url(path, baseUrl);
    const res = await fetchWithTimeout(fullUrl, {
        method: 'POST',
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, text));
    }
    if (!text || text.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(text) as T;
}

/**
 * PATCH request with JSON body. Path relative to baseUrl/v2/. Throws on HTTP error.
 */
export async function patch<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const fullUrl = url(path, baseUrl);
    const res = await fetchWithTimeout(fullUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, text));
    }
    if (!text || text.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(text) as T;
}

/**
 * POST request with multipart/form-data body (e.g. file upload). Path relative to baseUrl/v2/.
 * Do not set Content-Type so fetch sets the boundary. Throws on HTTP error.
 */
export async function postMultipart<T>(
    path: string,
    formData: FormData,
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const fullUrl = url(path, baseUrl);
    const { 'Content-Type': _ct, ...restHeaders } = headers;
    const res = await fetchWithTimeout(fullUrl, {
        method: 'POST',
        headers: { ...restHeaders, ...extraHeaders },
        body: formData,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, text));
    }
    if (!text || text.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(text) as T;
}

/**
 * DELETE request. Path relative to baseUrl/v2/. Throws on HTTP error.
 */
export async function deleteRequest<T>(path: string): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const fullUrl = url(path, baseUrl);
    const res = await fetchWithTimeout(fullUrl, { method: 'DELETE', headers });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, body));
    }
    if (!body || body.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(body) as T;
}

export interface ListAllOptions {
    perPage?: number;
    maxPages?: number;
}

/**
 * Fetch all pages of a list endpoint. Qonto returns { [endpoint]: T[], meta: { current_page, total_pages } }.
 * @param endpoint - e.g. 'transactions', 'bank_accounts'
 * @param query - query params; current_page and per_page are set automatically
 * @param options - perPage (default 100), maxPages (default 0 = all)
 * @returns flattened array of items
 */
export async function listAll<T>(
    endpoint: string,
    query: Record<string, unknown> = {},
    options: ListAllOptions = {},
): Promise<T[]> {
    const { perPage = 100, maxPages = 0 } = options;
    const out: T[] = [];
    let page = 1;
    let totalPages = 1;
    do {
        const q = { ...query, current_page: page, per_page: perPage };
        const res = await get<QontoListResponse<T>>(endpoint, q as Record<string, unknown>);
        const items = res[endpoint];
        if (Array.isArray(items)) {
            out.push(...items);
        }
        const meta = res.meta as QontoListMeta | undefined;
        totalPages = meta?.total_pages ?? 1;
        page++;
        if (maxPages > 0 && page > maxPages) break;
    } while (page <= totalPages);
    return out;
}
