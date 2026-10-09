/**
 * HTTP server utilities for the MCP server.
 * Provides session management, endpoints, and graceful shutdown.
 * Based on the Streamable HTTP transport pattern.
 */

import express, { type Request, type Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function getSessionId(headers: Request['headers']): string | undefined {
    const header = headers['mcp-session-id'] || headers['Mcp-Session-Id'];
    return typeof header === 'string' ? header : undefined;
}

function sendErrorResponse(res: Response, status: number, code: number, message: string, id: unknown = null): void {
    if (res.headersSent) return;
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id });
}

export interface HttpMcpServerOptions {
    port: number;
    serverName: string;
    version: string;
    createServer: () => { server: McpServer; transport: StreamableHTTPServerTransport };
}

export function createHttpMcpServer(options: HttpMcpServerOptions): express.Application {
    const { serverName, version, createServer } = options;
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.disable('x-powered-by');

    // Health check
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', server: serverName, version, activeSessions: transports.size });
    });

    // SSE stream endpoint
    app.get('/mcp', async (req: Request, res: Response) => {
        const sessionId = getSessionId(req.headers);
        if (!sessionId) {
            sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID');
            return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
            sendErrorResponse(res, 404, -32000, 'Session not found');
            return;
        }
        try {
            await transport.handleRequest(req, res, null);
        } catch {
            sendErrorResponse(res, 500, -32603, 'Internal server error');
        }
    });

    // Session termination
    app.delete('/mcp', async (req: Request, res: Response) => {
        const sessionId = getSessionId(req.headers);
        if (!sessionId) {
            sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID');
            return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
            sendErrorResponse(res, 404, -32000, 'Session not found');
            return;
        }
        try {
            await transport.handleRequest(req, res, req.body);
            transports.delete(sessionId);
            console.error(`[mcp] Session ${sessionId} deleted (${transports.size} active)`);
        } catch {
            sendErrorResponse(res, 500, -32603, 'Error terminating session');
        }
    });

    // Main MCP endpoint
    app.post('/mcp', async (req: Request, res: Response) => {
        try {
            const sessionId = getSessionId(req.headers);
            const requestId =
                typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;

            if (sessionId) {
                const transport = transports.get(sessionId);
                if (transport) {
                    await transport.handleRequest(req, res, req.body);
                    return;
                }
                sendErrorResponse(res, 404, -32000, 'Session not found', requestId);
                return;
            }

            // Only initialize requests can create new sessions
            const isInitialize =
                typeof req.body === 'object' &&
                req.body !== null &&
                'method' in req.body &&
                req.body.method === 'initialize';
            if (!isInitialize) {
                sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID', requestId);
                return;
            }

            const { server, transport } = createServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error('[mcp] Error handling request:', error instanceof Error ? error.message : error);
            const requestId =
                typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;
            sendErrorResponse(res, 500, -32603, 'Internal server error', requestId);
        }
    });

    // Graceful shutdown
    const shutdown = async () => {
        console.error('[mcp] Shutting down...');
        for (const [, transport] of transports) {
            try {
                await transport.close();
            } catch {}
        }
        transports.clear();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return app;
}
