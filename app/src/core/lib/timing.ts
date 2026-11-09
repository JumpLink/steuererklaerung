/**
 * Conditional debug timing helper.
 *
 * Re-exports the shared timing primitives so the app can import them from a core location, and
 * adds small sync/async wrappers that match the most common call sites. All output is gated on
 * `STEUER_DEBUG_TIMING=1` and written to stderr.
 */

export { logTiming as timeLog, stopwatch, timed, timingOn } from '@steuererklaerung/shared';

import { stopwatch, timed } from '@steuererklaerung/shared';

/** Measure the synchronous execution time of `fn` and return its result. */
export function timeSync<T>(label: string, fn: () => T): T {
    return timed(label, fn);
}

/** Measure an async function and return its result. */
export function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return timed(label, fn);
}
