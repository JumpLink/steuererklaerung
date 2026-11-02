/**
 * The real transport behind {@link ReadClient}: one `@gjsify/web-worker` Worker, driven through Comlink.
 *
 * Standard APIs only (`Worker`, `URL`, Comlink), so the same code runs in the GJS build and in the Node
 * + node-gi build. The `new Worker(new URL('./reader.ts', import.meta.url))` literal is what the
 * gjsify bundler looks for: it builds the worker beside the bundle and rewrites the URL to it.
 */

import { Worker } from '@gjsify/web-worker';
import * as Comlink from 'comlink';
import type { ReadApi } from './protocol.ts';
import type { ReadChannel } from './client.ts';

export function workerChannel(): ReadChannel {
    const worker = new Worker(new URL('./reader.ts', import.meta.url), { type: 'module', name: 'steuer-read' });
    const api = Comlink.wrap<ReadApi>(worker as unknown as Comlink.Endpoint);
    return {
        api,
        close(): void {
            api[Comlink.releaseProxy]();
            worker.terminate();
        },
    };
}
