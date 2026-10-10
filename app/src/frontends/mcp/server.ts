/**
 * MCP Server for steuererklaerung automation.
 * Provides LLM-optimized tools for Paperless-NGX, Qonto, ELSTER and the ledger store.
 *
 * Supports two transports:
 * - stdio (default): Claude Code auto-starts the server process
 * - http: Standalone HTTP server for future webhook/multi-client use
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAppContext } from '../../core/context.ts';
import type { AppContext } from '../../core/context.ts';
import { registerPaperlessTools } from './tools/paperless.ts';
import { registerQontoTools } from './tools/qonto.ts';
import { registerCrossSystemTools } from './tools/cross-system.ts';
import { registerReconcileStoreTools } from './tools/reconcile-store.ts';
import { registerDocumentWorkflowTools } from './tools/document-workflow.ts';
import { registerTransactionsTools } from './tools/transactions.ts';
import { registerElsterTools } from './tools/elster.ts';
import { registerInvoicesTools } from './tools/invoices.ts';
import { registerContactsTools } from './tools/contacts.ts';
import { registerMcpPrompts } from './prompts.ts';
import { guardTaxOnlyTools } from './tax-guard.ts';
import { createHttpMcpServer } from './http-server.ts';
import { loadAppSettings, MCP_GROUPS, type McpGroup } from '../../core/config/index.ts';
import { refusingFinTSInteraction, setFinTSInteraction } from '../../core/clients/fints/interaction.ts';

const SERVER_NAME = 'steuererklaerung';
const SERVER_VERSION = '0.1.0';

/** Group → its tool-registration function. The single source for what each group exposes. */
const GROUP_REGISTRARS: Record<McpGroup, (server: McpServer, ctx: AppContext) => void> = {
    paperless: registerPaperlessTools,
    qonto: registerQontoTools,
    transactions: registerTransactionsTools,
    reconcile: registerReconcileStoreTools,
    documentWorkflow: registerDocumentWorkflowTools,
    crossSystem: registerCrossSystemTools,
    elster: registerElsterTools,
    invoices: registerInvoicesTools,
    contacts: registerContactsTools,
};

export interface McpToolInfo {
    name: string;
    title: string;
    description: string;
    /** false ⇒ a mutating tool (exposed only with mcp.allowWrite). */
    readOnly: boolean;
}
export interface McpGroupTools {
    group: McpGroup;
    tools: McpToolInfo[];
}

/** Tool config as seen at registration time (the 2nd arg of server.registerTool). */
interface ToolConfig {
    title?: string;
    description?: string;
    annotations?: { readOnlyHint?: boolean };
}

/**
 * Enumerate EVERY tool of EVERY group with its title/description/read-only flag — derived
 * from the real registration code via a recording stub (no second list to drift). Handlers
 * are never invoked, so `ctx`'s clients are not used; registration only reads `ctx.config`.
 * Ignores the enabled/allowWrite settings on purpose: the UI shows the full catalogue.
 */
export function describeMcpTools(ctx: AppContext): McpGroupTools[] {
    return MCP_GROUPS.map((group) => {
        const tools: McpToolInfo[] = [];
        const recorder = {
            registerTool: (name: string, config: ToolConfig) => {
                tools.push({
                    name,
                    title: config?.title ?? name,
                    description: config?.description ?? '',
                    readOnly: config?.annotations?.readOnlyHint !== false,
                });
                return undefined;
            },
        } as unknown as McpServer;
        try {
            GROUP_REGISTRARS[group](recorder, ctx);
        } catch {
            /* a group that can't introspect (e.g. missing config) just lists what it managed */
        }
        return { group, tools };
    });
}

/**
 * Create a configured McpServer, exposing only the tool groups enabled in the workspace
 * config (`mcp.groups`) and — unless `mcp.allowWrite` is set — omitting the mutating
 * tools. This governs what external clients (ChatGPT, Claude Code, …) can use.
 */
function createMcpServerWithTools(ctx: AppContext): McpServer {
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });

    const mcp = loadAppSettings().mcp;
    if (!mcp.enabled) return server; // expose nothing

    // Read-only enrichment-workflow prompts — always exposed (no allowWrite gate).
    // Registered before the write-tool gate below so the wrapper never touches them.
    registerMcpPrompts(server, ctx);

    // Gate the mutating tools centrally — identified by each tool's own `readOnlyHint`
    // annotation, so there is no hand-maintained name list to drift as tools are added.
    if (!mcp.allowWrite) {
        const orig = server.registerTool.bind(server);
        server.registerTool = ((
            name: string,
            config: { annotations?: { readOnlyHint?: boolean } },
            ...rest: unknown[]
        ) =>
            config?.annotations?.readOnlyHint === false
                ? undefined
                : (orig as (...a: unknown[]) => unknown)(name, config, ...rest)) as typeof server.registerTool;
    }
    guardTaxOnlyTools(server);

    for (const group of MCP_GROUPS) if (mcp.groups[group]) GROUP_REGISTRARS[group](server, ctx);

    return server;
}

export interface StartMcpServerOptions {
    transport?: 'stdio' | 'http';
    port?: number;
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
    const { transport: mode = 'stdio', port = 3020 } = options;
    // Undo the CLI entry's terminal TAN prompt: under stdio transport, stdin IS the MCP protocol
    // channel, so a bank prompt would read protocol bytes as a TAN and corrupt the session. Beyond
    // that, a TAN is the user's second factor — an agent must not be able to answer one. Resetting
    // to the refusing default makes a FinTS call fail with a clear message instead.
    setFinTSInteraction(refusingFinTSInteraction());
    const ctx = createAppContext();

    if (mode === 'http') {
        const transports = new Map<string, StreamableHTTPServerTransport>();

        const app = createHttpMcpServer({
            port,
            serverName: SERVER_NAME,
            version: SERVER_VERSION,
            createServer: () => {
                const server = createMcpServerWithTools(ctx);
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true,
                    onsessioninitialized: (sessionId: string) => {
                        console.error(`[mcp] Session ${sessionId} initialized (${transports.size + 1} active)`);
                        transports.set(sessionId, transport);
                    },
                });
                server.server.onclose = async () => {
                    const sid = transport.sessionId;
                    if (sid && transports.has(sid)) {
                        transports.delete(sid);
                        console.error(`[mcp] Session ${sid} closed (${transports.size} active)`);
                    }
                };
                return { server, transport };
            },
        });

        app.listen(port, '0.0.0.0', () => {
            console.error(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} listening on http://0.0.0.0:${port}/mcp`);
        });
    } else {
        // stdio transport — Claude Code auto-starts and manages this process
        const server = createMcpServerWithTools(ctx);
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // @gjsify/process auto-resumes the stdin read stream when the SDK attaches
        // its `.on('data')` listener, exactly like Node.
        //
        // Park until the CLIENT GOES AWAY — not forever. This used to be
        // `new Promise<never>(() => {})`, which nothing can ever settle, so a
        // server whose client died just kept running. The evidence is the parent
        // pointer: several of these were found REPARENTED TO `systemd --user`
        // (PPID 1's user instance), which only happens once the process that
        // spawned them is gone — a live client keeps the pipe's write end open, so
        // an EOF-less park means the process can only ever be reaped by hand.
        //
        // Do NOT count concurrently-running servers as leaks: several Claude Code
        // sessions can be open at once and each legitimately owns one. The
        // liveness test is whether a process still has a LIVE client ancestor, not
        // whether it belongs to the session doing the counting — getting that
        // backwards kills healthy servers out from under parallel sessions.
        //
        // stdin EOF is the signal: for a stdio child, the parent closing the pipe
        // IS "you are done". The MCP SDK will not report it — its
        // StdioServerTransport attaches only `data` and `error` to stdin and calls
        // `close()` (hence `onclose`) solely on an explicit shutdown, so EOF
        // handling is deliberately left to the server author.
        await new Promise<void>((resolve) => {
            // CHAIN, never clobber: `server.connect()` already installed the
            // Protocol's own `onclose` for its bookkeeping, and overwriting it
            // would silently disable the SDK's cleanup.
            const sdkOnClose = transport.onclose;
            transport.onclose = () => {
                sdkOnClose?.();
                resolve();
            };
            process.stdin.once('end', resolve);
            process.stdin.once('close', resolve);
        });
        console.error('[mcp] client disconnected (stdin closed) — exiting');
        // An explicit exit, because returning is not enough: the GJS runtime loop
        // this CLI arms keeps the process parked at 0 % CPU with nothing left to
        // serve, and only `process.exit()` tears the GLib loop down. `return` in
        // front is the house rule — a bare `process.exit()` under GJS schedules the
        // exit and keeps running, which double-exits.
        return process.exit(0);
    }
}
