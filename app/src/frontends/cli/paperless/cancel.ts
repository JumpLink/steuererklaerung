/**
 * Shared SIGINT → AbortSignal plumbing for long-running AI CLI commands.
 *
 * Pressing Ctrl-C aborts the current run cleanly: the in-flight AI call stops,
 * no further document is started, and the process exits 0 with the friendly
 * cancelled message already in the catalogue.
 */

import { AiJobError } from '../../../core/clients/llm/job-error.ts';

/**
 * Run an async function with an {@link AbortSignal} that fires on SIGINT.
 * The listener is removed on completion, success or failure.
 */
export function withAbortSignal<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.on('SIGINT', onSigint);
    return run(controller.signal).finally(() => process.off('SIGINT', onSigint));
}

/**
 * Print a user-facing message and exit.
 * A cancellation is not an error: it exits 0 and prints the catalogue message.
 * Everything else exits 1 with the message but no stack trace.
 */
export function exitFromCliError(err: unknown): never {
    if (err instanceof AiJobError && err.kind === 'cancelled') {
        console.log(err.message);
        process.exit(0);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
}
