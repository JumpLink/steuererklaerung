import type { CommandModule } from 'yargs';
import { DEFAULT_MCP_HOST } from '../mcp/http-server.ts';

export const mcpCommand: CommandModule = {
    command: 'mcp',
    describe: 'Start MCP (Model Context Protocol) server for LLM integration',
    builder: (y) =>
        y
            .option('transport', {
                type: 'string',
                choices: ['stdio', 'http'],
                default: 'stdio',
                describe: 'Transport: stdio (auto-start by Claude Code) or http (standalone server)',
            })
            .option('port', {
                type: 'number',
                default: 3020,
                describe: 'HTTP port (only used with --transport http)',
            })
            .option('host', {
                type: 'string',
                default: DEFAULT_MCP_HOST,
                describe: 'Bind host (only used with --transport http; default localhost, no authentication)',
            }),
    handler: async (argv) => {
        const { startMcpServer } = await import('../mcp/server.ts');
        const transport = (argv as Record<string, unknown>).transport as 'stdio' | 'http';
        const port = (argv as Record<string, unknown>).port as number;
        const host = (argv as Record<string, unknown>).host as string;
        await startMcpServer({ transport, port, host });
    },
};
