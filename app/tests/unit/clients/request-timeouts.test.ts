/**
 * What happens when a back-end does not answer.
 *
 * Without a timeout an unreachable instance does not FAIL — it hangs. The native app then sits on
 * its loading spinner forever with no error, no retry and no way back, because the promise the view
 * awaits never settles. A hostname that does not resolve fails fast; one that accepts the
 * connection and never answers does not, and that is the common shape of a self-hosted Paperless
 * behind a proxy, a half-open VPN, or an API incident.
 *
 * The two limits differ on purpose and the numbers are the point: Paperless is legitimately slow —
 * a document list over a large archive takes tens of seconds here — so a limit tighter than the real
 * work would turn a working setup into a broken one. Qonto is a hosted API answering in well under a
 * second, so thirty seconds there is already far past broken.
 *
 * These tests cover the TRANSLATION, not the elapsed time: a test that genuinely waits a minute for
 * a socket is a test nobody runs.
 */
import { describe, expect, it } from '@gjsify/unit';

import { describeRequestError } from '@steuererklaerung/paperless';

/** An abort as the runtime actually raises it. */
function abortError(name: 'TimeoutError' | 'AbortError'): Error {
    const err = new Error('The operation was aborted');
    Object.defineProperty(err, 'name', { value: name });
    return err;
}

export default async () => {
    await describe('describeRequestError', async () => {
        await it('turns a timeout into something the user can act on', async () => {
            const err = describeRequestError(
                abortError('TimeoutError'),
                'https://paperless.example.org/api/documents/',
            );
            // The raw "The operation was aborted" reads like an internal fault; the user needs to
            // know it was THEIR instance that went quiet, and which one.
            expect(err.message.includes('paperless.example.org')).toBe(true);
            expect(err.message.includes('60')).toBe(true);
            expect(err.message.toLowerCase().includes('aborted')).toBe(false);
        });

        await it('treats a plain AbortError the same way', async () => {
            // Which name a runtime uses differs; both mean "it did not answer".
            const err = describeRequestError(abortError('AbortError'), 'https://paperless.example.org/api/');
            expect(err.message.includes('nicht geantwortet')).toBe(true);
        });

        await it('names the host, not the whole URL with its query string', async () => {
            const err = describeRequestError(
                abortError('TimeoutError'),
                'https://paperless.example.org:8000/api/documents/?page=3&query=secret',
            );
            expect(err.message.includes('paperless.example.org:8000')).toBe(true);
            expect(err.message.includes('secret')).toBe(false);
        });

        await it('survives a URL it cannot parse', async () => {
            const err = describeRequestError(abortError('TimeoutError'), 'nicht-mal-eine-url');
            expect(err instanceof Error).toBe(true);
            expect(err.message.includes('nicht-mal-eine-url')).toBe(true);
        });

        await it('passes a NON-timeout error through unchanged', async () => {
            // A 401 or a DNS failure already says what went wrong; rewriting it as a timeout would
            // send the user looking for the wrong problem.
            const original = new Error('401 Unauthorized');
            expect(describeRequestError(original, 'https://x.example')).toBe(original);
        });

        await it('wraps a non-Error throw rather than passing it on raw', async () => {
            const err = describeRequestError('irgendwas', 'https://x.example');
            expect(err instanceof Error).toBe(true);
            expect(err.message).toBe('irgendwas');
        });
    });
};
