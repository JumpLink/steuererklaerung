/**
 * INWX API request layer.
 * Uses domrobot-client (npm) which handles JSON-RPC transport.
 *
 * Env vars:
 * - INWX_USERNAME (required)
 * - INWX_PASSWORD (required)
 * - INWX_SHARED_SECRET (optional, for 2FA TOTP)
 * - INWX_ENV=live|ote (default: live)
 */

import { ApiClient } from 'domrobot-client';
import { getLogger } from '../../lib/logger.ts';

const log = getLogger('inwx');

export type InwxEnv = 'live' | 'ote';

export interface InwxConfig {
    username: string;
    password: string;
    sharedSecret?: string;
    env: InwxEnv;
}

export interface ConfigResult {
    config?: InwxConfig;
    error?: string;
}

// Module-level singleton state (same pattern as the other hand-rolled clients)
let client: ApiClient | null = null;
let loggedIn = false;

/** Validate INWX env vars without network calls. */
export function getInwxConfig(): ConfigResult {
    const username = process.env.INWX_USERNAME?.trim();
    const password = process.env.INWX_PASSWORD?.trim();

    if (!username) return { error: 'INWX_USERNAME not set' };
    if (!password) return { error: 'INWX_PASSWORD not set' };

    const rawEnv = process.env.INWX_ENV?.toLowerCase().trim();
    const env: InwxEnv = rawEnv === 'ote' ? 'ote' : 'live';

    const sharedSecret = process.env.INWX_SHARED_SECRET?.trim() || undefined;

    return { config: { username, password, sharedSecret, env } };
}

/** Get or create the ApiClient singleton. Logs in on first call. */
async function getClient(): Promise<ApiClient> {
    if (client && loggedIn) return client;

    const result = getInwxConfig();
    if (result.error || !result.config) {
        throw new Error(result.error ?? 'INWX config unavailable');
    }

    const cfg = result.config;
    const apiUrl = cfg.env === 'ote' ? ApiClient.API_URL_OTE : ApiClient.API_URL_LIVE;
    client = new ApiClient(apiUrl, 'de', false);

    log.info(`Logging in to INWX (${cfg.env})...`);
    const loginResponse = await client.login(cfg.username, cfg.password, cfg.sharedSecret);
    if (loginResponse.code !== 1000) {
        throw new Error(`INWX login failed: code=${loginResponse.code} msg=${loginResponse.msg ?? 'unknown'}`);
    }
    loggedIn = true;
    log.info('INWX login successful.');

    return client;
}

/** Call an INWX API method. Handles login and response code checking. */
export async function callApi<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const api = await getClient();
    const response = await api.callApi(method, params);
    if (response.code !== 1000) {
        throw new Error(`INWX API ${method} failed: code=${response.code} msg=${response.msg ?? 'unknown'}`);
    }
    return response.resData as T;
}
