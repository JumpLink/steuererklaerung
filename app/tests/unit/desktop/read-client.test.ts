/**
 * The window's read client: serial results, error rebuilding, timeout + restart of a dead worker.
 * The channel is a fake, so none of this needs a built worker (and it runs on GJS and Node alike).
 */

import { describe, expect, it } from '@gjsify/unit';

import { ReadClient, type ReadChannel } from '../../../src/frontends/desktop/read/client.ts';
import { serializeError, type ReadApi } from '../../../src/frontends/desktop/read/protocol.ts';
import { ManifestMissingError, PaperlessSetupError } from '../../../src/core/lib/errors.ts';

interface Fake {
    channel: ReadChannel;
    closed: boolean;
    invalidated: Array<[string | undefined, number | undefined]>;
}

/** A worker whose `home` runs `onHome`; every other op is inert. */
function fakeFactory(onHome: (n: number) => Promise<unknown>) {
    const made: Fake[] = [];
    const spawn = (): ReadChannel => {
        const fake: Fake = { closed: false, invalidated: [], channel: undefined as unknown as ReadChannel };
        const api = {
            home: () => onHome(made.length) as never,
            invalidate: async (e?: string, y?: number) => {
                fake.invalidated.push([e, y]);
            },
            reloadDms: async () => undefined,
            ping: async () => 'pong' as const,
        } as unknown as ReadApi;
        fake.channel = {
            api,
            close() {
                fake.closed = true;
            },
        };
        made.push(fake);
        return fake.channel;
    };
    return { spawn, made };
}

const never = () => new Promise<never>(() => undefined);
const home = (api: ReadApi) => api.home({} as never, 2025);

export default async () => {
    await describe('ReadClient', async () => {
        await it('resolves the value of an ok reply', async () => {
            const { spawn } = fakeFactory(async () => ({ ok: true, value: 42 }));
            const client = new ReadClient(spawn, 1000);
            expect(await client.call(home as never)).toBe(42);
            client.close();
        });

        await it('rebuilds the error class a view tests with instanceof', async () => {
            const { spawn } = fakeFactory(async () => ({
                ok: false,
                error: serializeError(new PaperlessSetupError('setup', ['tag'])),
            }));
            const client = new ReadClient(spawn, 1000);
            let caught: unknown;
            try {
                await client.call(home as never);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof PaperlessSetupError).toBe(true);
            expect((caught as PaperlessSetupError).fields[0]).toBe('tag');
            expect(serializeError(new ManifestMissingError('x')).name).toBe('ManifestMissingError');
            client.close();
        });

        await it('reuses one worker across calls', async () => {
            const { spawn, made } = fakeFactory(async () => ({ ok: true, value: 1 }));
            const client = new ReadClient(spawn, 1000);
            await client.call(home as never);
            await client.call(home as never);
            expect(made.length).toBe(1);
            expect(client.restarts).toBe(0);
            client.close();
        });

        await it('times out a silent worker, closes it and starts a fresh one next call', async () => {
            let calls = 0;
            const { spawn, made } = fakeFactory(() =>
                ++calls === 1 ? never() : Promise.resolve({ ok: true, value: 7 }),
            );
            const client = new ReadClient(spawn, 30);
            let failed = false;
            try {
                await client.call(home as never);
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
            expect(made[0].closed).toBe(true);
            expect(client.restarts).toBe(1);
            expect(await client.call(home as never)).toBe(7);
            expect(made.length).toBe(2);
            client.close();
        });

        await it('drops the worker when the transport itself fails', async () => {
            const { spawn, made } = fakeFactory(() => Promise.reject(new Error('port closed')));
            const client = new ReadClient(spawn, 1000);
            let message = '';
            try {
                await client.call(home as never);
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toBe('port closed');
            expect(made[0].closed).toBe(true);
            client.close();
        });

        await it('forwards invalidate only to a running worker', async () => {
            const { spawn, made } = fakeFactory(async () => ({ ok: true, value: 1 }));
            const client = new ReadClient(spawn, 1000);
            client.invalidate('a', 2025);
            expect(made.length).toBe(0);
            await client.call(home as never);
            client.invalidate('a', 2025);
            expect(made[0].invalidated.length).toBe(1);
            client.close();
        });

        await it('refuses calls after close', async () => {
            const { spawn } = fakeFactory(async () => ({ ok: true, value: 1 }));
            const client = new ReadClient(spawn, 1000);
            client.close();
            let failed = false;
            try {
                await client.call(home as never);
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
        });
    });
};
