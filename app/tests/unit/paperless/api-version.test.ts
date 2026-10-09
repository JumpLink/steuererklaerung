/**
 * The Paperless API version is PINNED, and the pin is checked here.
 *
 * Paperless resolves a request that names no version to the server's current `DEFAULT_VERSION`,
 * which changes with the server, not with us. Paperless 2.x defaults to 9, Paperless 3.x to 10 —
 * and under 10 `/api/tasks/` is paginated and renames the fields this client reads, so an
 * unpinned client would survive `docker compose pull` only until the next upload, which would
 * then poll a never-matching shape for 60 s and time out.
 *
 * These tests exist so the pin cannot be removed or bumped by accident: changing
 * PAPERLESS_API_VERSION means porting tasks.ts, and this file says so out loud.
 */

import { describe, it, expect, vi, afterEach } from '@gjsify/unit';
import { PAPERLESS_API_VERSION, resolvePaperlessConfig, probeApiVersion, check } from '@steuererklaerung/paperless';

const CFG = { baseUrl: 'https://pl.test', headers: { Accept: `application/json; version=${PAPERLESS_API_VERSION}` } };

/** A minimal Response stand-in: only what request.ts actually touches. */
function response(status: number, body: string, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        text: async () => body,
    };
}

export default async () => {
    await describe('paperless api version pin', async () => {
        afterEach(() => vi.unstubAllGlobals());

        await it('pins version 9 — bumping it requires porting tasks.ts', async () => {
            // Not a style assertion: under version 10 the tasks endpoint is paginated and
            // related_document/result are renamed. See PAPERLESS_API_VERSION.
            expect(PAPERLESS_API_VERSION).toBe('9');
        });

        await it('sends the version in the Accept header, not as a bare application/json', async () => {
            process.env.PAPERLESS_BASE_URL = 'https://pl.test';
            process.env.PAPERLESS_API_TOKEN = 'token';
            const { config } = resolvePaperlessConfig();
            expect(config?.headers.Accept).toBe(`application/json; version=${PAPERLESS_API_VERSION}`);
        });

        await it('carries the pin into every request, not just the config object', async () => {
            let sent = '';
            vi.stubGlobal(
                'fetch',
                vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
                    sent = init.headers.Accept;
                    return response(200, JSON.stringify({ count: 0 }), { 'x-api-version': '9', 'x-version': '2.20.8' });
                }),
            );
            process.env.PAPERLESS_BASE_URL = 'https://pl.test';
            process.env.PAPERLESS_API_TOKEN = 'token';
            await probeApiVersion();
            expect(sent).toBe(`application/json; version=${PAPERLESS_API_VERSION}`);
        });

        await it('reads the server release and the highest version it serves', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () =>
                    response(200, JSON.stringify({ count: 1764 }), { 'x-api-version': '10', 'x-version': '3.1.3' }),
                ),
            );
            const info = await probeApiVersion(CFG);
            expect(info.accepted).toBe(true);
            expect(info.served).toBe('10');
            expect(info.release).toBe('3.1.3');
            expect(info.documentCount).toBe(1764);
        });

        await it('reports a refused version as a fact, not as a crash', async () => {
            // A refused version answers 406 BEFORE the version middleware runs, so the response
            // carries no X-Api-Version to report — the probe must still say what happened.
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => response(406, JSON.stringify({ detail: 'Invalid version in "Accept" header.' }))),
            );
            const info = await probeApiVersion(CFG);
            expect(info.accepted).toBe(false);
            expect(info.pinned).toBe(PAPERLESS_API_VERSION);
        });

        await describe('check() makes the drift visible', async () => {
            await it('names both versions when the server has moved past our pin', async () => {
                process.env.PAPERLESS_BASE_URL = 'https://pl.test';
                process.env.PAPERLESS_API_TOKEN = 'token';
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async () =>
                        response(200, JSON.stringify({ count: 7 }), { 'x-api-version': '10', 'x-version': '3.1.3' }),
                    ),
                );
                const r = await check();
                expect(r.ok).toBe(true);
                expect(r.message?.includes('3.1.3')).toBe(true);
                expect(r.message?.includes('v10')).toBe(true);
                expect(r.message?.includes('v9')).toBe(true);
            });

            await it('stays quiet about drift when server and pin agree', async () => {
                process.env.PAPERLESS_BASE_URL = 'https://pl.test';
                process.env.PAPERLESS_API_TOKEN = 'token';
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async () =>
                        response(200, JSON.stringify({ count: 7 }), { 'x-api-version': '9', 'x-version': '2.20.8' }),
                    ),
                );
                const r = await check();
                expect(r.ok).toBe(true);
                expect(r.message?.includes('Server bietet')).toBe(false);
            });

            await it('fails the check when the instance no longer accepts the pinned version', async () => {
                process.env.PAPERLESS_BASE_URL = 'https://pl.test';
                process.env.PAPERLESS_API_TOKEN = 'token';
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async () => response(406, '{"detail":"Invalid version in \\"Accept\\" header."}')),
                );
                const r = await check();
                expect(r.ok).toBe(false);
                expect(r.message?.includes('406')).toBe(true);
            });
        });
    });
};
