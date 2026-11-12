import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import type { AgentCommand, LoginProvider, LoginSession } from '@lotse/core';

import { engineConnection } from '../../../src/core/actions/assistant/engine-status.ts';

// Synthetic only: no login server is opened and no credential exists here.
const command: AgentCommand = { program: 'opencode', args: ['acp'] } as unknown as AgentCommand;

const provider = (id: string, connected: boolean): LoginProvider => ({
    id,
    name: id,
    connected,
    featured: false,
    europe: false,
    methods: [{ kind: 'key', label: 'API key', fields: [] }] as unknown as LoginProvider['methods'],
});

function session(providers: LoginProvider[]): { open: () => Promise<LoginSession>; closed: () => boolean } {
    let closed = false;
    const fake = {
        providers: async () => providers,
        close: async () => {
            closed = true;
        },
    } as unknown as LoginSession;
    return { open: async () => fake, closed: () => closed };
}

export default async () => {
    await describe('engineConnection', async () => {
        let before: string | undefined;
        beforeEach(() => {
            before = process.env.LLM_PROVIDER;
            process.env.LLM_PROVIDER = 'opencode';
        });
        afterEach(() => {
            if (before === undefined) delete process.env.LLM_PROVIDER;
            else process.env.LLM_PROVIDER = before;
        });

        await it('is connected when a provider is logged in, and closes the login server', async () => {
            const fake = session([provider('a', false), provider('b', true)]);
            expect(await engineConnection({ command, probe: { open: fake.open, reason: () => null } })).toBe(
                'connected',
            );
            expect(fake.closed()).toBe(true);
        });

        await it('is none when the agent lists providers and nobody is logged in', async () => {
            const fake = session([provider('a', false)]);
            expect(await engineConnection({ command, probe: { open: fake.open, reason: () => null } })).toBe('none');
        });

        await it('is unknown when the catalog is empty or the server cannot start', async () => {
            const empty = session([]);
            expect(await engineConnection({ command, probe: { open: empty.open, reason: () => null } })).toBe(
                'unknown',
            );
            const broken = async (): Promise<LoginSession> => {
                throw new Error('no server');
            };
            expect(await engineConnection({ command, probe: { open: broken, reason: () => null } })).toBe('unknown');
        });

        await it('is unknown for an engine with no cheap question, without opening anything', async () => {
            for (const name of ['claude', 'scaleway', '']) {
                process.env.LLM_PROVIDER = name;
                let opened = false;
                const open = async (): Promise<LoginSession> => {
                    opened = true;
                    throw new Error('must not open');
                };
                expect(await engineConnection({ command, probe: { open, reason: () => null } })).toBe('unknown');
                expect(opened).toBe(false);
            }
        });
    });
};
