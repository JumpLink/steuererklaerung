/**
 * Manifest section schema: `app` (built-in web assistant + externally-exposed MCP tool groups).
 *
 * This module OWNS the former workspace `assistant` + `mcp` settings (now folded under the manifest's
 * `app` key), plus the MCP tool-group list and the parse/default helpers. The standalone `workspace.ts`
 * loader is gone.
 */

import { z } from 'zod';

/** The MCP tool groups — match the registerXTools(...) functions in mcp/server.ts. */
export const MCP_GROUPS = [
    'dms',
    'paperless',
    'qonto',
    'transactions',
    'reconcile',
    'documentWorkflow',
    'crossSystem',
    'elster',
    'invoices',
    'contacts',
] as const;
export type McpGroup = (typeof MCP_GROUPS)[number];

// Write-vs-read gating is derived from each tool's own `readOnlyHint` annotation
// (see mcp/server.ts) — no hand-maintained write-tool name list to drift out of sync.

const ALL_GROUPS_ON: Record<McpGroup, boolean> = Object.fromEntries(MCP_GROUPS.map((g) => [g, true])) as Record<
    McpGroup,
    boolean
>;

/** Built-in web assistant (the Adwaita desktop app has none; both can expose MCP). */
const AssistantSchema = z.object({ enabled: z.boolean().default(true) }).default({ enabled: true });

/** Which MCP tool groups are exposed (to external clients + the future internal agent). */
const McpGroupsSchema = z
    .object({
        dms: z.boolean().default(true),
        paperless: z.boolean().default(true),
        qonto: z.boolean().default(true),
        transactions: z.boolean().default(true),
        reconcile: z.boolean().default(true),
        documentWorkflow: z.boolean().default(true),
        crossSystem: z.boolean().default(true),
        elster: z.boolean().default(true),
        invoices: z.boolean().default(true),
        contacts: z.boolean().default(true),
    })
    .default(ALL_GROUPS_ON);

const McpSchema = z
    .object({
        /** Master switch for exposing MCP tools at all. */
        enabled: z.boolean().default(true),
        /** Per-group exposure (read tools follow the group; write tools also need allowWrite). */
        groups: McpGroupsSchema,
        /** Allow the mutating tools (update/link/push/sync/lock/…) to be exposed. */
        allowWrite: z.boolean().default(false),
    })
    .default({ enabled: true, groups: ALL_GROUPS_ON, allowWrite: false });

/** Background sync: minutes between automatic runs per source (0 = that source off). */
const SyncSchema = z
    .object({
        enabled: z.boolean().default(true),
        invoicesMinutes: z.number().int().min(0).default(15),
        transactionsMinutes: z.number().int().min(0).default(60),
        paperlessMinutes: z.number().int().min(0).default(30),
    })
    .default({ enabled: true, invoicesMinutes: 15, transactionsMinutes: 60, paperlessMinutes: 30 });

export const AppSettingsSchema = z.object({
    assistant: AssistantSchema,
    mcp: McpSchema,
    /** Lernmodus: show short plain-German explanations of the tax terms in every view (the "?" buttons). */
    lernmodus: z.boolean().default(false),
    sync: SyncSchema,
});

export type AssistantSettings = z.infer<typeof AssistantSchema>;
export type McpSettings = z.infer<typeof McpSchema>;
export type SyncSettings = z.infer<typeof SyncSchema>;
export interface AppSettings {
    assistant: AssistantSettings;
    mcp: McpSettings;
    lernmodus: boolean;
    sync: SyncSettings;
}

/** The manifest `app` section reuses the app-settings shape verbatim. */
export const AppSectionSchema = AppSettingsSchema;
export type AppSection = z.infer<typeof AppSectionSchema>;

/** Validate + normalise (fill defaults) an app-settings payload, e.g. from the settings UI. */
export function parseAppSettings(raw: unknown): AppSettings {
    return AppSettingsSchema.parse(raw);
}

/** Defaults when the manifest omits `app` (assistant on, MCP on, all groups, read-only, Lernmodus off). */
export function defaultAppSettings(): AppSettings {
    return {
        assistant: AssistantSchema.parse(undefined),
        mcp: McpSchema.parse(undefined),
        lernmodus: false,
        sync: SyncSchema.parse(undefined),
    };
}
