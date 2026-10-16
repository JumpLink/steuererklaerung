import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { setAssistantOfferedOverride } from '../../../src/core/config/assistant-offered.ts';
import { getLLMProvider, ClaudeAgentProvider } from '../../../src/core/clients/llm/index.ts';

export default async () => {
    await describe('getLLMProvider', async () => {
        // Which provider gets built is only a question in a build that offers the assistant; that
        // a build without one builds none is assistant-offered.test.ts.
        beforeEach(() => setAssistantOfferedOverride(true));
        afterEach(() => setAssistantOfferedOverride(null));

        await it('defaults to the Claude Agent provider', async () => {
            const p = getLLMProvider({ provider: 'claude' });
            expect(p).toBeInstanceOf(ClaudeAgentProvider);
            expect(p.name).toBe('claude-agent');
        });

        await it('honours a model override', async () => {
            const p = getLLMProvider({ provider: 'claude', model: 'claude-opus-4-8' });
            expect(p.model).toBe('claude-opus-4-8');
        });

        await it('throws on an unknown provider', async () => {
            expect(() => getLLMProvider({ provider: 'gpt' })).toThrow(/Unknown LLM_PROVIDER/);
        });
    });
};
