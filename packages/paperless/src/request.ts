/**
 * Shared request layer for Paperless-NGX API.
 * Requires PAPERLESS_BASE_URL and PAPERLESS_API_TOKEN.
 */

import { httpErrorSnippet } from '@steuererklaerung/shared';

export interface PaperlessConfig {
    baseUrl: string;
    headers: Record<string, string>;
}

export interface ConfigResult {
    config?: PaperlessConfig;
    error?: string;
}

/** Explicit per-entity Paperless credentials (each field falls back to its env var). */
export interface PaperlessCreds {
    url?: string;
    token?: string;
}

/**
 * The Paperless API version this client speaks, sent as `Accept: application/json; version=N`.
 *
 * PINNED ON PURPOSE. Paperless resolves an unversioned request to the server's *current*
 * `DEFAULT_VERSION`, so "send no version" does not mean "keep today's behaviour" — it means
 * "whatever the next upgrade decides", and the server changes that number without asking.
 * Measured 2026-09-18 against a live 2.20.8: unversioned and `version=9` are byte-identical,
 * `version=1` returns select custom-field values as integer **indices** instead of the stable
 * option **hashes** (the historical breakage this client was written around), and `version=10`
 * is refused with HTTP 406.
 *
 * Paperless 3.x ships `DEFAULT_VERSION = "10"`, where `/api/tasks/` becomes a *paginated*
 * envelope and renames `related_document` → `related_document_ids`, `result` → `result_data`.
 * Unpinned, the upgrade would turn every document upload into a 60 s poll that ends in a
 * timeout. Pinned, the upgrade is invisible here — 3.x still serves 9.
 *
 * Moving to 10 is a deliberate migration (tasks pagination + field names), not a side effect
 * of `docker compose pull`. Bump this constant only together with that work.
 */
export const PAPERLESS_API_VERSION = '9';

/**
 * Resolve a Paperless config (base URL + auth header) from explicit credentials, falling
 * back to the env vars per field. Per-entity Paperless instances pass creds from
 * steuererklaerung.json; with no argument it is the global env config.
 */
export function resolvePaperlessConfig(creds?: PaperlessCreds): ConfigResult {
    const base = (creds?.url ?? process.env.PAPERLESS_BASE_URL)?.replace(/\/$/, '') ?? '';
    const token = creds?.token ?? process.env.PAPERLESS_API_TOKEN;
    if (!base || !token) {
        return { error: !base ? 'PAPERLESS_BASE_URL not set' : 'PAPERLESS_API_TOKEN not set' };
    }
    const headers: Record<string, string> = {
        Accept: `application/json; version=${PAPERLESS_API_VERSION}`,
        Authorization: `Token ${token}`,
    };
    return { config: { baseUrl: base, headers } };
}

export function config(): ConfigResult {
    return resolvePaperlessConfig();
}

function getConfig(): PaperlessConfig {
    const result = config();
    if (result.error || !result.config) {
        throw new Error(result.error ?? 'Paperless config unavailable');
    }
    return result.config;
}

/**
 * Build full URL for a path (e.g. /api/documents/). Path is appended to baseUrl.
 */
function fullUrl(path: string, baseUrl: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${baseUrl}${p}`;
}

/**
 * Build query string from record. Values are stringified; arrays can be sent as repeated params if needed by API.
 */
function buildQuery(query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) {
                params.append(k, typeof item === 'object' ? JSON.stringify(item) : String(item));
            }
        } else if (typeof v === 'object') {
            params.set(k, JSON.stringify(v));
        } else {
            params.set(k, String(v));
        }
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

/**
 * How long a Paperless request may take before it is abandoned, in milliseconds.
 *
 * Without one, an unreachable instance does not fail — it HANGS. The native app then sits on its
 * loading spinner forever with no error, no retry and no way back, because the promise the view is
 * waiting on never settles; a typo in the URL, a VPN that is down or a server that stopped mid-boot
 * all look identical to "still loading". A hostname that does not resolve fails fast, but one that
 * accepts the connection and never answers does not, and that is the common shape of a
 * self-hosted instance behind a proxy.
 *
 * Sixty seconds because Paperless genuinely is slow: a document list over a large archive routinely
 * takes tens of seconds (measured ~10 s here), and a timeout tighter than the real work would turn
 * a working setup into a broken one.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * An AbortSignal that fires after {@link REQUEST_TIMEOUT_MS}.
 *
 * Wrapped because `AbortSignal.timeout` is not present on every runtime this package runs on (it is
 * used from GJS as well as Node); where it is missing the request keeps today's behaviour rather
 * than failing to build.
 */
function timeoutSignal(): AbortSignal | undefined {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;
}

/**
 * Turn an abort into a message that says what to do about it.
 *
 * The raw `AbortError` / "The operation was aborted" reads like an internal fault; the user needs to
 * know it was THEIR Paperless that did not answer.
 */
export function describeRequestError(error: unknown, url: string): Error {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
        const seconds = Math.round(REQUEST_TIMEOUT_MS / 1000);
        const host = (() => {
            try {
                return new URL(url).host;
            } catch {
                return url;
            }
        })();
        return new Error(
            `Paperless (${host}) hat nach ${seconds} s nicht geantwortet. Läuft die Instanz, und stimmt die URL in den Einstellungen?`,
        );
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * `fetch` with the timeout attached and the abort translated — the one place every request goes
 * through, so a new endpoint cannot forget it.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const signal = timeoutSignal();
    try {
        return await fetch(url, signal ? { ...init, signal } : init);
    } catch (error) {
        throw describeRequestError(error, url);
    }
}

/**
 * GET request. Path is relative to baseUrl (e.g. /api/documents/). Throws on HTTP error.
 */
export async function get<T>(path: string, query: Record<string, unknown> = {}, cfg?: PaperlessConfig): Promise<T> {
    const { baseUrl, headers } = cfg ?? getConfig();
    const url = fullUrl(path, baseUrl) + buildQuery(query);
    const res = await fetchWithTimeout(url, { method: 'GET', headers });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, body));
    }
    if (!body || body.trim() === '') {
        return undefined as T;
    }
    return JSON.parse(body) as T;
}

/**
 * What the server says about API versions, read from the headers of a normal request.
 *
 * `served` is the highest version the instance offers (`X-Api-Version`); `release` is the
 * Paperless version itself (`X-Version`). Both are only sent on an authenticated 2xx — a refused
 * version answers 406 before the middleware runs, which is why {@link probeApiVersion} reports
 * that case separately instead of leaving the fields empty and letting a caller guess.
 */
export interface PaperlessApiVersionInfo {
    /** The version this client asked for — {@link PAPERLESS_API_VERSION}. */
    pinned: string;
    /** True when the server accepted `pinned`; false means HTTP 406. */
    accepted: boolean;
    /** Highest API version the server offers, e.g. "10" on Paperless 3.x. */
    served?: string;
    /** Paperless release string, e.g. "2.20.8". */
    release?: string;
    /** Number of documents, as a side effect of the probe — cheaper than a second request. */
    documentCount?: number;
}

/**
 * Ask the server which API versions it serves, so a drift between our pin and the instance is
 * visible BEFORE it breaks something.
 *
 * Without this the pin is a silent bet: an upgrade that drops version 9 would surface as an
 * unexplained 406 in whichever feature happened to run first — most likely a document upload,
 * mid-Beleg-Eingang. Here it is one line in `steuer check-apis`.
 */
export async function probeApiVersion(cfg?: PaperlessConfig): Promise<PaperlessApiVersionInfo> {
    const { baseUrl, headers } = cfg ?? getConfig();
    const url = `${fullUrl('/api/documents/', baseUrl)}?page_size=1`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers });
    if (res.status === 406) {
        return { pinned: PAPERLESS_API_VERSION, accepted: false };
    }
    const body = await res.text();
    if (!res.ok) {
        throw new Error(httpErrorSnippet(res, body));
    }
    let documentCount: number | undefined;
    try {
        documentCount = (JSON.parse(body) as { count?: number }).count;
    } catch {
        // A 200 that is not the documents envelope still answers the version question.
    }
    return {
        pinned: PAPERLESS_API_VERSION,
        accepted: true,
        served: res.headers.get('x-api-version') ?? undefined,
        release: res.headers.get('x-version') ?? undefined,
        documentCount,
    };
}

/**
 * GET request returning response body as Buffer (e.g. document download). Throws on HTTP error.
 */
export async function getBinary(
    path: string,
    query: Record<string, unknown> = {},
    cfg?: PaperlessConfig,
): Promise<Buffer> {
    const { baseUrl, headers } = cfg ?? getConfig();
    const url = fullUrl(path, baseUrl) + buildQuery(query);
    const res = await fetchWithTimeout(url, { method: 'GET', headers });
    const arrayBuffer = await res.arrayBuffer();
    if (!res.ok) {
        const body = new TextDecoder().decode(arrayBuffer);
        throw new Error(httpErrorSnippet(res, body));
    }
    return Buffer.from(arrayBuffer);
}

/**
 * POST request with JSON body. Path relative to baseUrl. Throws on HTTP error.
 */
export async function post<T>(
    path: string,
    body: Record<string, unknown> = {},
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const url = fullUrl(path, baseUrl);
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', ...extraHeaders },
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
 * PATCH request with JSON body. Path relative to baseUrl. Throws on HTTP error.
 * `cfg` targets a specific (per-entity) Paperless instance; default = global env.
 */
export async function patch<T>(path: string, body: Record<string, unknown> = {}, cfg?: PaperlessConfig): Promise<T> {
    const { baseUrl, headers } = cfg ?? getConfig();
    const url = fullUrl(path, baseUrl);
    const res = await fetchWithTimeout(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
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
 * DELETE request. Path relative to baseUrl. Throws on HTTP error.
 */
export async function del(path: string): Promise<void> {
    const { baseUrl, headers } = getConfig();
    const url = fullUrl(path, baseUrl);
    const res = await fetchWithTimeout(url, { method: 'DELETE', headers });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(httpErrorSnippet(res, body));
    }
}

/**
 * POST request with multipart/form-data body (e.g. file upload). Path relative to baseUrl.
 * Do not set Content-Type so fetch sets the boundary. Throws on HTTP error.
 */
export async function postMultipart<T>(
    path: string,
    formData: FormData,
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const url = fullUrl(path, baseUrl);
    const { 'Content-Type': _ct, ...restHeaders } = headers;
    const res = await fetchWithTimeout(url, {
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
 * POST multipart/form-data with the body assembled MANUALLY: one binary file part
 * plus text fields, serialized into a single Uint8Array with an explicit boundary.
 *
 * GJS' fetch does not serialize a FormData Blob file part over libsoup — the file
 * arrives empty and Paperless rejects "No file was submitted". Building the body by
 * hand sidesteps that and works identically on GJS and Node.
 */
export async function postMultipartManual<T>(
    path: string,
    fields: Array<[string, string]>,
    fileFieldName: string,
    filename: string,
    fileBytes: Uint8Array,
    fileContentType = 'application/octet-stream',
): Promise<T> {
    const { baseUrl, headers } = getConfig();
    const url = fullUrl(path, baseUrl);
    const { 'Content-Type': _ct, ...restHeaders } = headers;
    const boundary = `----steuerFormBoundary${Date.now().toString(16)}`;
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [name, value] of fields) {
        chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(
        enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\nContent-Type: ${fileContentType}\r\n\r\n`,
        ),
    );
    chunks.push(fileBytes);
    chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
    let total = 0;
    for (const c of chunks) total += c.length;
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        body.set(c, offset);
        offset += c.length;
    }
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...restHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
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
