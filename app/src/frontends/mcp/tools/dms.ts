/**
 * Backend-agnostic DMS MCP tools: the accounting inbox workflow (list → propose → apply → payment
 * status → match against the bank) without the caller knowing whether Paperless or the built-in DMS
 * sits behind the entity. The `paperless_*` tools stay for Paperless-specific work.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import { defaultEntityFor } from '../../../core/config/entities.ts';
import { PAYMENT_STATUS_OPTIONS } from '../../../core/lib/select-field-constants.ts';
import { resolveEntityDms, suggestTransactionLinksForDocument } from '../../../core/actions/link-candidates.ts';
import {
    applyMetadata,
    getDocumentWithText,
    listInbox,
    proposeMetadata,
    setPaymentStatus,
    type MetadataProposal,
} from '../../../core/actions/dms/inbox.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

const entityField = z.string().optional().describe('Workspace entity id (default: the first business entity)');
const documentId = z.string().min(1).describe('Document id as returned by dms_list_inbox');
const model = z.string().min(1).describe('Name of the model making the call; stamped into the KI-Hinweis');

const proposalFields = {
    title: z.string().optional(),
    correspondent: z.string().optional(),
    document_type: z.string().optional(),
    direction: z.enum(['incoming', 'outgoing']).optional(),
    created: z.string().optional().describe('Document date, YYYY-MM-DD'),
    invoice_number: z.string().optional(),
    net: z.number().optional(),
    gross: z.number().optional(),
    vat: z.number().optional(),
};

type ProposalParams = {
    [K in keyof typeof proposalFields]: z.infer<(typeof proposalFields)[K]>;
};

function toProposal(p: ProposalParams): MetadataProposal {
    return {
        title: p.title,
        correspondent: p.correspondent,
        documentType: p.document_type,
        direction: p.direction,
        created: p.created,
        invoiceNumber: p.invoice_number,
        net: p.net,
        gross: p.gross,
        vat: p.vat,
    };
}

export function registerDmsTools(server: McpServer, ctx: AppContext): void {
    const entityOf = (id?: string) => id ?? defaultEntityFor(ctx.manifest).id;
    const providerOf = (id?: string) => resolveEntityDms(entityOf(id)).provider;

    server.registerTool(
        'dms_list_inbox',
        {
            title: 'List DMS Inbox',
            description:
                'Documents still waiting for review. Paperless: documents carrying the configured inbox tag. Built-in DMS: documents never reviewed (no metadata stamp yet).',
            inputSchema: { entity_id: entityField },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ entity_id }) => {
            try {
                return mcpSuccess(await listInbox(providerOf(entity_id)));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    server.registerTool(
        'dms_get_document',
        {
            title: 'Get DMS Document',
            description: 'One document with its metadata, payment fields, linked transactions and (truncated) text.',
            inputSchema: { entity_id: entityField, document_id: documentId },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ entity_id, document_id }) => {
            try {
                return mcpSuccess(await getDocumentWithText(providerOf(entity_id), document_id));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    server.registerTool(
        'dms_propose_metadata',
        {
            title: 'Propose DMS Metadata (dry run)',
            description:
                'Validate a metadata proposal and show what dms_apply_metadata would change plus the KI-Hinweis it would write. Writes nothing. You decide the values; this tool diffs them.',
            inputSchema: { entity_id: entityField, document_id: documentId, model, ...proposalFields },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ entity_id, document_id, model, ...fields }) => {
            try {
                return mcpSuccess(
                    await proposeMetadata(providerOf(entity_id), document_id, toProposal(fields), { model }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    server.registerTool(
        'dms_apply_metadata',
        {
            title: 'Apply DMS Metadata',
            description:
                'Write a metadata proposal and the KI-Hinweis, then take the document out of the inbox. Call only after the person approved the proposal from dms_propose_metadata.',
            inputSchema: {
                entity_id: entityField,
                document_id: documentId,
                model,
                mark_reviewed: z.boolean().default(true).describe('Take the document out of the inbox'),
                ...proposalFields,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ entity_id, document_id, model, mark_reviewed, ...fields }) => {
            try {
                return mcpSuccess(
                    await applyMetadata(providerOf(entity_id), document_id, toProposal(fields), {
                        model,
                        markReviewed: mark_reviewed,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    server.registerTool(
        'dms_set_payment_status',
        {
            title: 'Set DMS Payment Status',
            description: `Set a document's payment status (${PAYMENT_STATUS_OPTIONS.join(' | ')}), optionally with due date and amount to pay.`,
            inputSchema: {
                entity_id: entityField,
                document_id: documentId,
                status: z.enum(PAYMENT_STATUS_OPTIONS),
                due_date: z.string().optional().describe('YYYY-MM-DD'),
                amount_to_pay: z.number().optional(),
                ai_note: z.string().optional().describe('Replacement KI-Hinweis, one line under 200 characters'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ entity_id, document_id, status, due_date, amount_to_pay, ai_note }) => {
            try {
                return mcpSuccess(
                    await setPaymentStatus(providerOf(entity_id), document_id, {
                        status,
                        dueDate: due_date,
                        amountToPay: amount_to_pay,
                        aiNote: ai_note,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    server.registerTool(
        'dms_match_payment',
        {
            title: 'Match Document to Bank Transactions',
            description:
                "Ranked bank transactions that could be the payment for a document, with the document's current payment status. Read-only: use it to decide dms_set_payment_status.",
            inputSchema: { entity_id: entityField, document_id: documentId },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ entity_id, document_id }) => {
            try {
                const entityId = entityOf(entity_id);
                const { provider } = resolveEntityDms(entityId);
                const doc = await provider.get(document_id);
                if (!doc) throw new Error(`Dokument ${document_id} nicht gefunden.`);
                const candidates = await suggestTransactionLinksForDocument(entityId, document_id);
                return mcpSuccess({
                    documentId: document_id,
                    paymentStatus: doc.paymentStatus ?? null,
                    linkedTxIds: doc.linkedTxIds,
                    candidates,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
