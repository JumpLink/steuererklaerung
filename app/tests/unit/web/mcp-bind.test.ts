import { describe, expect, it } from '@gjsify/unit';
import { DEFAULT_MCP_HOST } from '../../../src/frontends/mcp/http-server.ts';
import { mcpCommand } from '../../../src/frontends/cli/mcp.ts';

export default async () => {
    await describe('MCP HTTP bind address', async () => {
        await it('defaults to loopback, never all interfaces', async () => {
            expect(DEFAULT_MCP_HOST).toBe('127.0.0.1');
        });

        await it('exposes --host on the CLI with the loopback default', async () => {
            const options: Record<string, { default?: unknown }> = {};
            const fake = {
                option(name: string, spec: { default?: unknown }) {
                    options[name] = spec;
                    return fake;
                },
            };
            (mcpCommand.builder as (y: unknown) => unknown)(fake);
            expect(options.host?.default).toBe('127.0.0.1');
        });
    });
};
