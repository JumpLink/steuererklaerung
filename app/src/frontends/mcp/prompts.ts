/**
 * MCP prompts for the steuererklaerung server.
 *
 * Prompts are read-only guidance an external agent (e.g. Claude Code) can pull to
 * drive the AI Paperless-enrichment workflow. They unify the workflow around ONE
 * prompt source: the text lives in `src/core/lib/prompts.ts` (the same module the
 * app's own review-metadata action consumes), so the server never duplicates it.
 *
 * Registering a prompt via the SDK auto-advertises the `prompts` capability, so
 * these are exposed regardless of `mcp.allowWrite` (unlike the mutating tools).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../core/context.ts';
import {
    getReviewDocumentMetadataPromptText,
    ENRICH_PAPERLESS_DOCUMENTS_PROMPT,
    type PromptLanguage,
} from '../../core/lib/prompts.ts';

/** Wrap prompt text as a single user message (the GetPromptResult shape). */
function userPrompt(description: string, text: string) {
    return {
        description,
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text },
            },
        ],
    };
}

/**
 * Register the enrichment-workflow prompts. Text is sourced from
 * `src/core/lib/prompts.ts` (single source of truth). Prompts are read-only and
 * always registered (no allowWrite gate).
 */
export function registerMcpPrompts(server: McpServer, ctx: AppContext): void {
    const lang: PromptLanguage = ctx.config.preferred_language ?? 'de';

    server.registerPrompt(
        'review_document_metadata',
        {
            title: 'Review one document’s Paperless metadata',
            description:
                'Metadata-review rules (title, correspondent, document type, date, content tags) + how to drive the review per document via the paperless_* MCP tools, recording the rationale into the ai_note (KI-Hinweis) field.',
        },
        () =>
            userPrompt(
                'Per-document Paperless metadata review rules and MCP usage.',
                getReviewDocumentMetadataPromptText(lang),
            ),
    );

    server.registerPrompt(
        'enrich_paperless_documents',
        {
            title: 'Work through and enrich Paperless documents',
            description:
                'Higher-level batch workflow: select documents, analyze, classify (data_scope), find related, validate, update + link, and record the KI-Hinweis rationale — private vs business closing steps.',
        },
        () => userPrompt('Batch Paperless enrichment workflow (document-workflow).', ENRICH_PAPERLESS_DOCUMENTS_PROMPT),
    );
}
