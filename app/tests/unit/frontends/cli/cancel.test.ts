/**
 * CLI cancellation plumbing: SIGINT becomes an AbortSignal, and a cancelled AI job exits cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { AiJobError } from '../../../../src/core/clients/llm/job-error.ts';
import { exitFromCliError, withAbortSignal } from '../../../../src/frontends/cli/paperless/cancel.ts';

export default async () => {
    await describe('CLI cancel helper', async () => {
        let sigintListeners: Array<() => void> = [];
        let exitCalls: Array<{ code: number }> = [];
        let originalExit: typeof process.exit;
        let originalConsoleLog: typeof console.log;
        let originalConsoleError: typeof console.error;
        let logMessages: string[] = [];
        let errorMessages: string[] = [];

        beforeEach(() => {
            sigintListeners = [];
            exitCalls = [];
            logMessages = [];
            errorMessages = [];
            originalExit = process.exit;
            originalConsoleLog = console.log;
            originalConsoleError = console.error;

            console.log = vi.fn((message: unknown) => {
                logMessages.push(String(message));
            }) as unknown as typeof console.log;
            console.error = vi.fn((message: unknown) => {
                errorMessages.push(String(message));
            }) as unknown as typeof console.error;

            vi.stubGlobal('process', {
                ...process,
                on: (event: string, listener: () => void) => {
                    if (event === 'SIGINT') sigintListeners.push(listener);
                },
                off: (event: string, listener: () => void) => {
                    if (event === 'SIGINT') sigintListeners = sigintListeners.filter((l) => l !== listener);
                },
                exit: (code: number) => {
                    exitCalls.push({ code });
                    throw new Error(`process.exit(${code})`);
                },
            });
        });

        afterEach(() => {
            console.log = originalConsoleLog;
            console.error = originalConsoleError;
            vi.stubGlobal('process', {
                ...process,
                exit: originalExit,
            });
        });

        await it('withAbortSignal aborts the signal on SIGINT', async () => {
            let signal: AbortSignal | undefined;
            let aborted = false;
            const run = withAbortSignal(async (s) => {
                signal = s;
                await new Promise<void>((resolve) => {
                    const check = () => {
                        if (s.aborted) {
                            aborted = true;
                            resolve();
                        } else {
                            setTimeout(check, 5);
                        }
                    };
                    check();
                });
            });

            // Give the promise a chance to register the listener.
            await new Promise((r) => setTimeout(r, 10));
            expect(sigintListeners.length).toBe(1);

            sigintListeners[0]!();
            await run;

            expect(signal).toBeDefined();
            expect(aborted).toBe(true);
            expect(signal?.aborted).toBe(true);
            expect(sigintListeners.length).toBe(0);
        });

        await it('exitFromCliError exits 0 with the cancelled message', () => {
            try {
                exitFromCliError(new AiJobError('cancelled'));
            } catch (e) {
                expect((e as Error).message).toBe('process.exit(0)');
            }
            expect(exitCalls.length).toBe(1);
            expect(exitCalls[0]!.code).toBe(0);
            expect(logMessages.join('')).toContain('cancelled');
        });

        await it('exitFromCliError exits 1 for a plain error', () => {
            try {
                exitFromCliError(new Error('network failed'));
            } catch (e) {
                expect((e as Error).message).toBe('process.exit(1)');
            }
            expect(exitCalls.length).toBe(1);
            expect(exitCalls[0]!.code).toBe(1);
            expect(errorMessages.join('')).toContain('network failed');
        });
    });
};
