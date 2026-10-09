import { describe, it, expect } from '@gjsify/unit';
import { isAuthError, isRetriableError } from '../../../src/core/clients/llm/claude-agent-provider.ts';

export default async () => {
    await describe('LLM auth vs transport errors', async () => {
        await it('does not retry a credentials failure dressed as a dead process', async () => {
            // The Agent SDK reports a missing login as a dead child process. Both patterns match
            // "process exited with code 1", so the commonest failure of all was retried three times
            // with backoff and then blamed on the network. Retrying a wrong password never works.
            const err = new Error('Claude Code process exited with code 1: Invalid API key');
            expect(isAuthError(err)).toBe(true);
            expect(isRetriableError(err)).toBe(false);
        });

        await it('recognises the spellings an auth failure actually arrives in', async () => {
            for (const message of [
                'HTTP 401 Unauthorized',
                'authentication_error: invalid x-api-key',
                'Your credit balance is too low to access the Anthropic API',
                'ANTHROPIC_API_KEY is not set',
                'Not logged in — please run `claude login`',
                'OAuth token has expired',
            ]) {
                expect(isAuthError(new Error(message))).toBe(true);
                expect(isRetriableError(new Error(message))).toBe(false);
            }
        });

        await it('still retries what is genuinely transient', async () => {
            for (const message of [
                'HTTP 429 rate limit exceeded',
                'API is overloaded (529)',
                'fetch failed',
                'socket hang up',
                'ETIMEDOUT',
                'Claude Code process exited with code 143',
            ]) {
                expect(isAuthError(new Error(message))).toBe(false);
                expect(isRetriableError(new Error(message))).toBe(true);
            }
        });

        await it('treats an unknown failure as final, not as something to hammer', async () => {
            const err = new Error('Something entirely unexpected');
            expect(isAuthError(err)).toBe(false);
            expect(isRetriableError(err)).toBe(false);
        });
    });
};
