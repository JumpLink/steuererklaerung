/**
 * The window's side of the read worker: ask for a page's data, await the answer.
 *
 * Three decisions carry it:
 *
 * - **A timeout is the detection of a dead worker.** On GJS a worker that dies emits no `error` and no
 *   `exit` (measured by the stamped app, which has the same setup), so a lost worker only ever shows as
 *   an answer that never comes. On timeout the worker is dropped and every call that was waiting on it
 *   fails; the next call starts a fresh one.
 * - **The channel is injected.** {@link ReadChannel} is the whole transport, so queueing, timeout,
 *   restart and error propagation are testable in-process without a built worker file.
 * - **Errors are rebuilt.** A failure arrives as a {@link SerializedError} and leaves as the real error
 *   class, because the views tell "no manifest yet" from "Paperless not set up" with `instanceof`.
 *
 * Pure TS — the real transport is in channel.ts.
 */

import { _, fmt } from '../../../core/lib/i18n.ts';
import { rehydrateError, type ReadApi, type Reply } from './protocol.ts';

/** One worker, as the client sees it. */
export interface ReadChannel {
    readonly api: ReadApi;
    close(): void;
}

/** Makes one worker. Called again after a restart. */
export type ReadChannelFactory = () => ReadChannel;

/**
 * How long one read may take before the worker counts as lost. Generous: a wait costs nothing (the
 * window keeps painting), while a premature timeout throws away an aggregate that was about to land
 * and starts it again — and the first Paperless fetch of a year is legitimately slow.
 */
export const READ_TIMEOUT_MS = 120_000;

interface Waiting {
    reject(error: Error): void;
}

export class ReadClient {
    private channel: ReadChannel | undefined;
    private generation = 0;
    private readonly waiting = new Set<Waiting>();
    private restartCount = 0;
    private closed = false;

    constructor(
        private readonly spawn: ReadChannelFactory,
        private readonly timeoutMs: number = READ_TIMEOUT_MS,
    ) {}

    /** How often a worker had to be replaced. */
    get restarts(): number {
        return this.restartCount;
    }

    /** Run one read. Resolves with its value, rejects with its (rehydrated) error. */
    call<T>(run: (api: ReadApi) => Promise<Reply<T>>): Promise<T> {
        if (this.closed) return Promise.reject(new Error(_('The reader was closed.')));
        const channel = this.ensure();
        const generation = this.generation;
        return new Promise<T>((resolve, reject) => {
            const entry: Waiting = { reject: (e) => settle(() => reject(e)) };
            let done = false;
            const settle = (fn: () => void): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.waiting.delete(entry);
                fn();
            };
            const timer = setTimeout(() => {
                if (this.generation === generation) this.drop();
                settle(() =>
                    reject(
                        new Error(
                            fmt(_('The reader did not answer within {seconds} seconds and was restarted.'), {
                                seconds: Math.round(this.timeoutMs / 1000),
                            }),
                        ),
                    ),
                );
            }, this.timeoutMs);
            this.waiting.add(entry);
            let pending: Promise<Reply<T>>;
            try {
                pending = run(channel.api);
            } catch (err) {
                settle(() => reject(err instanceof Error ? err : new Error(String(err))));
                return;
            }
            pending.then(
                (reply) => settle(() => (reply.ok ? resolve(reply.value) : reject(rehydrateError(reply.error)))),
                (err: unknown) => {
                    // Transport failure (not a read failing): the worker is no good any more.
                    // Settle first: drop() rejects whatever still waits with a generic message.
                    settle(() => reject(err instanceof Error ? err : new Error(String(err))));
                    if (this.generation === generation) this.drop();
                },
            );
        });
    }

    /** Tell the worker its memos are stale. Fire and forget; does not start a worker that is not running. */
    invalidate(entityId?: string, year?: number): void {
        this.notify((api) => api.invalidate(entityId, year));
    }

    /** Tell the worker to rebuild an entity's DMS provider. */
    reloadDms(entityId: string): void {
        this.notify((api) => api.reloadDms(entityId));
    }

    /** End the worker for good (window closed). */
    close(): void {
        this.closed = true;
        this.drop();
    }

    private notify(send: (api: ReadApi) => Promise<void>): void {
        // A worker that is not running starts with fresh memos anyway.
        if (!this.channel) return;
        send(this.channel.api).catch(() => undefined);
    }

    private ensure(): ReadChannel {
        if (!this.channel) {
            this.generation++;
            this.channel = this.spawn();
        }
        return this.channel;
    }

    /** Give up on the current worker: fail everything waiting on it, close it. The next call spawns a new one. */
    private drop(): void {
        const channel = this.channel;
        this.channel = undefined;
        this.generation++;
        if (channel) this.restartCount++;
        const lost = [...this.waiting];
        this.waiting.clear();
        for (const w of lost) w.reject(new Error(_('The reader stopped while it was working.')));
        try {
            channel?.close();
        } catch {
            /* already gone */
        }
    }
}
