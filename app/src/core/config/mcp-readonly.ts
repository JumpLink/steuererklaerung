/**
 * `STEUER_MCP_READONLY` — how a caller that starts this app's MCP server itself forces read-only,
 * whatever the manifest says.
 *
 * `mcp.allowWrite` is the person's decision about EXTERNAL clients: they registered Claude Code or
 * opencode themselves and chose what it may do. The assistant pane is not that. It starts a server
 * of its own, in-process-adjacent, for an agent the app spawned — and an agent the app spawned must
 * not inherit a write permission the person granted to a client they configured by hand. The
 * environment is the only seam: the server runs as a subprocess, so there is no object to pass.
 *
 * **It can only take away.** `restrictMcpToReadOnly` never sets `allowWrite` to true, so a mistaken
 * value cannot widen anything, and an unset variable leaves the settings exactly as they were.
 */

import type { McpSettings } from './schema/app-settings.ts';

export const MCP_READONLY_ENV = 'STEUER_MCP_READONLY';

/** Unset, empty, `0` and `false` are off — one rule for "is this on", as everywhere else here. */
export function readOnlyRequested(env: Record<string, string | undefined> = process.env): boolean {
    const raw = env[MCP_READONLY_ENV]?.trim().toLowerCase();
    return !!raw && raw !== '0' && raw !== 'false';
}

/** The settings with the write tools taken away when the environment asks for it. */
export function restrictMcpToReadOnly(
    mcp: McpSettings,
    env: Record<string, string | undefined> = process.env,
): McpSettings {
    return readOnlyRequested(env) ? { ...mcp, allowWrite: false } : mcp;
}
