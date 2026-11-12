/**
 * What the MCP server does around every write tool when an assistant session drives it (ADR 0005):
 * snapshot before the session's first change, and one change-log line after each call returns.
 *
 * Writes are identified by their own `readOnlyHint: false`, like the `allowWrite` gate in
 * `server.ts` — no name list. Read tools are never touched and never logged.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendChangeLog, type ChangeOutcome } from '../../core/actions/assistant/change-log.ts';
import type { SessionBackupGate } from '../../core/actions/assistant/session-backup.ts';
import { mcpErrorFrom } from './types.ts';

export interface WriteGuardOptions {
    session: string;
    gate: SessionBackupGate;
    /** Defaults to the app's own log; tests point it at a temp file. */
    logPath?: string;
}

export function guardAssistantWrites(server: McpServer, opts: WriteGuardOptions): void {
    const orig = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
    server.registerTool = ((
        name: string,
        config: { annotations?: { readOnlyHint?: boolean }; inputSchema?: unknown },
        cb: (...a: unknown[]) => unknown,
    ) => {
        if (config?.annotations?.readOnlyHint !== false || typeof cb !== 'function') return orig(name, config, cb);
        return orig(name, config, async (...a: unknown[]) => {
            const args = config.inputSchema ? a[0] : undefined;
            const record = (outcome: ChangeOutcome) => {
                try {
                    appendChangeLog(
                        {
                            time: new Date().toISOString(),
                            session: opts.session,
                            tool: name,
                            outcome,
                            fields: args && typeof args === 'object' ? Object.keys(args) : [],
                        },
                        opts.logPath,
                    );
                } catch (err) {
                    // The write has happened (or been refused); a full disk must not turn that into a lie.
                    console.error(`[mcp] change log not written: ${err instanceof Error ? err.message : err}`);
                }
            };
            try {
                opts.gate.ensure(opts.session);
            } catch (err) {
                record('declined');
                return mcpErrorFrom(err);
            }
            try {
                const result = await cb(...a);
                record((result as { isError?: boolean } | undefined)?.isError ? 'error' : 'ok');
                return result;
            } catch (err) {
                record('error');
                throw err;
            }
        });
    }) as typeof server.registerTool;
}
