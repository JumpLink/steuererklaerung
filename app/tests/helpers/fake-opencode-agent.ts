/**
 * A fake `opencode acp` agent for the provider tests: nothing is spawned, no socket is opened and
 * no document is read. It answers one canned string, so a test can check what `OpencodeProvider`
 * makes of an answer — and, with `models`/`current`, what lotse's model policy makes of a model
 * before any prompt is sent.
 */
import type { AgentHandle, OpenAgentOptions } from '@lotse/core';

import { OpencodeProvider } from '../../src/core/clients/llm/index.ts';

export interface FakeAgentOptions {
    answer: string;
    models?: string[];
    current?: string;
    stopReason?: string;
    failNewSession?: Error;
    /** The turn never ends: only a timeout or an abort stops the job. */
    hang?: boolean;
    /** The agent reports no model control at all, so lotse cannot tell where a prompt would go. */
    noModelOption?: boolean;
}

export function fakeAgent(fake: FakeAgentOptions): (options: OpenAgentOptions) => Promise<AgentHandle> {
    const models = fake.models ?? ['anthropic/claude-sonnet-5-5'];
    let current = fake.current ?? models[0];
    const modelOption = () => ({
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: current,
        options: models.map((value) => ({ value, name: value })),
    });
    const configOptions = () => (fake.noModelOption ? [] : [modelOption()]);
    return async () => {
        let listener: ((notification: unknown) => void) | null = null;
        const client = {
            newSession: async () => {
                if (fake.failNewSession) throw fake.failNewSession;
                return { sessionId: 's1', configOptions: configOptions() };
            },
            setConfigOption: async ({ value }: { value: string }) => {
                current = value;
                return { configOptions: configOptions() };
            },
            onSessionUpdate: (callback: (notification: unknown) => void) => {
                listener = callback;
                return () => {
                    listener = null;
                };
            },
            prompt: async () => {
                if (fake.hang) return new Promise<never>(() => {});
                listener?.({
                    sessionId: 's1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: fake.answer } },
                });
                return { stopReason: fake.stopReason ?? 'end_turn' };
            },
            cancel: () => {},
        };
        return { client, logLines: [], agentInfo: 'fake 0.0.0', close: () => {} } as unknown as AgentHandle;
    };
}

/** The provider as the app builds it, but talking to {@link fakeAgent} instead of a real agent. */
export function fakeAgentProvider(fake: FakeAgentOptions, model?: string, timeoutMs = 5_000): OpencodeProvider {
    return new OpencodeProvider({
        model,
        command: { command: 'fake-agent', args: [] } as never,
        cwd: '/tmp',
        open: fakeAgent(fake),
        timeoutMs,
    });
}
