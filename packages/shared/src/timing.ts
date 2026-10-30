/**
 * Debug timing — `STEUER_DEBUG_TIMING=1` prints one `[timing] <label> <ms> ms` line to stderr per
 * measured step, so "the page is slow" can be answered with where the time goes (data source,
 * SQLite read, view construction) instead of a guess. Off by default and then costs one env read.
 */

function now(): number {
    return globalThis.performance?.now() ?? Date.now();
}

/** Whether timing output is requested (read per call so tests and the env can flip it). */
export function timingOn(): boolean {
    const v = process.env.STEUER_DEBUG_TIMING;
    return v === '1' || v === 'true';
}

/** Print one timing line. No-op unless {@link timingOn}. */
export function logTiming(label: string, ms: number): void {
    if (timingOn()) console.error(`[timing] ${label} ${ms.toFixed(1)} ms`);
}

/** Start a stopwatch; the returned function logs (and returns) the elapsed milliseconds. */
export function stopwatch(label: string): () => number {
    const t0 = now();
    return () => {
        const ms = now() - t0;
        logTiming(label, ms);
        return ms;
    };
}

/** Run `fn` (sync or async) and log how long it took, also when it throws. */
export function timed<T>(label: string, fn: () => Promise<T>): Promise<T>;
export function timed<T>(label: string, fn: () => T): T;
export function timed<T>(label: string, fn: () => T | Promise<T>): T | Promise<T> {
    if (!timingOn()) return fn();
    const stop = stopwatch(label);
    try {
        const result = fn();
        if (result instanceof Promise) return result.finally(stop);
        stop();
        return result;
    } catch (err) {
        stop();
        throw err;
    }
}

/** A stopwatch with named laps: each `lap(name)` logs the time since the previous lap as `<label>.<name>`. */
export function lapwatch(label: string): { lap(name: string): void } {
    let last = now();
    return {
        lap(name: string): void {
            const t = now();
            logTiming(`${label}.${name}`, t - last);
            last = t;
        },
    };
}
