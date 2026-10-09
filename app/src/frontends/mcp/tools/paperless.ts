/**
 * Paperless-NGX MCP tools.
 * Read and update documents, list metadata resources, processing status overview.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import {
    listDocuments,
    getDocument,
    updateDocument,
    listCorrespondents,
    createCorrespondent,
    listDocumentTypes,
    listTags,
    type Document,
    type UpdateDocumentPayload,
    hasSyncField,
    mergeCustomFields,
} from '@steuererklaerung/paperless';
import { fetchAllPages } from '@steuererklaerung/paperless';
import { parseDocumentCustomFields, resolveCustomFieldUpdates, mcpError, mcpErrorFrom, mcpSuccess } from '../types.ts';
import { paperlessUploadDocument } from '../../../core/actions/paperless/upload.ts';

/** Build a compact document summary for list results. */
function summarizeDocument(doc: Document, config: AppContext['config']) {
    const parsed = parseDocumentCustomFields(doc, config);
    return {
        id: doc.id,
        title: doc.title,
        correspondent: doc.correspondent,
        document_type: doc.document_type,
        tags: doc.tags,
        created: doc.created,
        added: doc.added,
        original_file_name: doc.original_file_name,
        page_count: doc.page_count ?? null,
        custom_fields: parsed,
    };
}

export function registerPaperlessTools(server: McpServer, ctx: AppContext): void {
    const config = ctx.config;

    // ── paperless_search_documents ──────────────────────────────────────

    server.registerTool(
        'paperless_search_documents',
        {
            title: 'Search Paperless Documents',
            description:
                'Search Paperless documents. Use document_type to filter by invoice category, or "any" for all types (including misclassified). Returns parsed custom fields.',
            inputSchema: {
                query: z.string().optional().describe('Full-text search query'),
                document_type: z
                    .enum(['incoming_invoice', 'outgoing_invoice', 'any'])
                    .default('any')
                    .describe(
                        'Filter by document type category. "any" = no type filter (finds misclassified docs too)',
                    ),
                document_type_id: z
                    .number()
                    .optional()
                    .describe('Exact document type ID override (takes precedence over document_type)'),
                correspondent_id: z.number().optional().describe('Filter by correspondent ID'),
                tag_ids: z
                    .array(z.number())
                    .optional()
                    .describe(
                        'Filter to documents carrying ALL of these tag IDs (get the ids from paperless_list_tags)',
                    ),
                ordering: z.string().optional().describe('Sort order, e.g. "-created", "id", "-added"'),
                page: z.number().default(1).describe('Page number'),
                page_size: z.number().default(25).describe('Results per page (max 100)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                let documentTypeId = params.document_type_id;
                if (!documentTypeId && params.document_type !== 'any') {
                    documentTypeId = config.document_type_ids[params.document_type];
                    if (!documentTypeId || documentTypeId <= 0) documentTypeId = undefined;
                }

                const data = await listDocuments({
                    query: params.query,
                    document_type_id: documentTypeId,
                    correspondent_id: params.correspondent_id,
                    tag_ids: params.tag_ids,
                    ordering: params.ordering ?? '-added',
                    page: params.page,
                    page_size: Math.min(params.page_size, 100),
                });

                const documents = data.results.map((doc) => summarizeDocument(doc, config));

                return mcpSuccess({
                    total_count: data.count,
                    page: params.page,
                    page_size: params.page_size,
                    documents,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_get_document ──────────────────────────────────────────

    server.registerTool(
        'paperless_get_document',
        {
            title: 'Get Paperless Document',
            description:
                'Get full document context: metadata, OCR content (truncated), and parsed custom fields in one call.',
            inputSchema: {
                document_id: z.number().describe('Paperless document ID'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ document_id }) => {
            try {
                const doc = await getDocument(document_id);
                const parsed = parseDocumentCustomFields(doc, config);

                const MAX_CONTENT = 50_000;
                const content = doc.content
                    ? doc.content.length > MAX_CONTENT
                        ? doc.content.slice(0, MAX_CONTENT) + '\n... [truncated]'
                        : doc.content
                    : null;

                return mcpSuccess({
                    id: doc.id,
                    title: doc.title,
                    correspondent: doc.correspondent,
                    document_type: doc.document_type,
                    tags: doc.tags,
                    created: doc.created,
                    added: doc.added,
                    modified: doc.modified,
                    original_file_name: doc.original_file_name,
                    page_count: doc.page_count ?? null,
                    mime_type: doc.mime_type ?? null,
                    content,
                    custom_fields: parsed,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_update_document ───────────────────────────────────────

    server.registerTool(
        'paperless_update_document',
        {
            title: 'Update Paperless Document',
            description:
                'Update document metadata and custom fields. Accepts friendly field names (e.g. "invoice_number") instead of IDs. Uses read-modify-write to preserve existing fields.',
            inputSchema: {
                document_id: z.number().describe('Paperless document ID'),
                title: z.string().optional().describe('New document title'),
                correspondent_id: z.number().nullable().optional().describe('Correspondent ID (null to unset)'),
                document_type_id: z.number().nullable().optional().describe('Document type ID (null to unset)'),
                tags: z.array(z.number()).optional().describe('Replace all tags with these IDs'),
                created: z.string().optional().describe('Document date (YYYY-MM-DD)'),
                custom_fields: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe(
                        'Custom field updates using friendly names (e.g. {"invoice_number": "INV-001", "total_gross": "EUR100.00"})',
                    ),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (params) => {
            try {
                const doc = await getDocument(params.document_id);
                const payload: UpdateDocumentPayload = {};

                if (params.title !== undefined) payload.title = params.title;
                if (params.correspondent_id !== undefined) payload.correspondent = params.correspondent_id;
                if (params.document_type_id !== undefined) payload.document_type = params.document_type_id;
                if (params.tags !== undefined) payload.tags = params.tags;
                if (params.created !== undefined) payload.created = params.created;

                if (params.custom_fields) {
                    const newEntries = resolveCustomFieldUpdates(params.custom_fields, config);
                    payload.custom_fields = mergeCustomFields(doc.custom_fields ?? [], newEntries);
                }

                const updated = await updateDocument(params.document_id, payload);
                return mcpSuccess(summarizeDocument(updated, config));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_upload_document ───────────────────────────────────────

    server.registerTool(
        'paperless_upload_document',
        {
            title: 'Upload Paperless Document',
            description:
                'Upload a local file (PDF, image, scan) into Paperless with metadata and custom fields. ' +
                'Waits for consumption, then sets custom fields (friendly names, e.g. {"data_scope":"privat"}). ' +
                'Returns the created document ID (or the existing one if Paperless detects a duplicate).',
            inputSchema: {
                file_path: z
                    .string()
                    .describe('Path to the local file to upload (server-local, e.g. an absolute path)'),
                title: z.string().optional().describe('Document title'),
                correspondent_id: z
                    .number()
                    .optional()
                    .describe('Correspondent ID (see paperless_list_correspondents)'),
                correspondent_name: z
                    .string()
                    .optional()
                    .describe('Correspondent by name — reused if it exists (case-insensitive), else created'),
                document_type_id: z
                    .number()
                    .optional()
                    .describe('Document type ID (see paperless_list_document_types)'),
                tags: z.array(z.number()).optional().describe('Tag IDs to attach (see paperless_list_tags)'),
                tag_names: z
                    .array(z.string())
                    .optional()
                    .describe('Tag names to attach — each reused if it exists, else created'),
                created: z.string().optional().describe('Document date (YYYY-MM-DD)'),
                custom_fields: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Custom fields by friendly name (e.g. {"data_scope":"privat","ai_note":"…"})'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async (params) => {
            try {
                const result = await paperlessUploadDocument(
                    {
                        filePath: params.file_path,
                        title: params.title,
                        created: params.created,
                        correspondentId: params.correspondent_id,
                        correspondentName: params.correspondent_name,
                        documentTypeId: params.document_type_id,
                        tagIds: params.tags,
                        tagNames: params.tag_names,
                        customFields: params.custom_fields,
                    },
                    config,
                );
                const doc = await getDocument(result.documentId);
                return mcpSuccess({
                    document_id: result.documentId,
                    created: result.created,
                    duplicate: !result.created,
                    filename: result.filename,
                    custom_fields_applied: result.customFieldsApplied,
                    document: summarizeDocument(doc, config),
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_list_correspondents ───────────────────────────────────

    server.registerTool(
        'paperless_list_correspondents',
        {
            title: 'List Paperless Correspondents',
            description: 'List all Paperless correspondents (senders/customers). Needed for document classification.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                const all = await fetchAllPages((page, pageSize) => listCorrespondents({ page, page_size: pageSize }));
                return mcpSuccess(all.map((c) => ({ id: c.id, name: c.name })));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_create_correspondent ──────────────────────────────────

    server.registerTool(
        'paperless_create_correspondent',
        {
            title: 'Create Paperless Correspondent',
            description:
                'Create a new correspondent (sender/customer), or return the existing one if a correspondent with that name already exists (case-insensitive). Use when a document needs a correspondent that is not in paperless_list_correspondents yet, then assign it via paperless_update_document.',
            inputSchema: {
                name: z.string().describe('Correspondent name — the sender or customer as printed on the document'),
                match: z.string().optional().describe('Optional auto-match text for future documents'),
                matching_algorithm: z
                    .number()
                    .optional()
                    .describe('Paperless matching algorithm (0=none, 1=any, 2=all, 3=literal, 4=regex, 6=auto)'),
                is_insensitive: z
                    .boolean()
                    .optional()
                    .describe('Case-insensitive matching (default true in Paperless)'),
            },
            annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (params) => {
            try {
                const name = params.name?.trim();
                if (!name) return mcpError('name is required');
                const existing = (
                    await fetchAllPages((page, pageSize) => listCorrespondents({ page, page_size: pageSize }))
                ).find((c) => c.name?.trim().toLowerCase() === name.toLowerCase());
                if (existing) {
                    return mcpSuccess({ id: existing.id, name: existing.name, created: false });
                }
                const created = await createCorrespondent({
                    name,
                    match: params.match,
                    matching_algorithm: params.matching_algorithm,
                    is_insensitive: params.is_insensitive,
                });
                return mcpSuccess({ id: created.id, name: created.name, created: true });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_list_document_types ───────────────────────────────────

    server.registerTool(
        'paperless_list_document_types',
        {
            title: 'List Paperless Document Types',
            description: 'List all Paperless document types. Needed for document classification.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                const all = await fetchAllPages((page, pageSize) => listDocumentTypes({ page, page_size: pageSize }));
                return mcpSuccess(all.map((t) => ({ id: t.id, name: t.name })));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_list_tags ─────────────────────────────────────────────

    server.registerTool(
        'paperless_list_tags',
        {
            title: 'List Paperless Tags',
            description: 'List all Paperless tags. Needed for tagging decisions.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                const all = await fetchAllPages((page, pageSize) => listTags({ page, page_size: pageSize }));
                return mcpSuccess(all.map((t) => ({ id: t.id, name: t.name })));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── paperless_get_processing_status ─────────────────────────────────

    server.registerTool(
        'paperless_get_processing_status',
        {
            title: 'Paperless Processing Status',
            description:
                'Overview of document processing state: how many are fully processed, extracted but unmatched, and unextracted.',
            inputSchema: {
                document_type: z
                    .enum(['incoming_invoice', 'outgoing_invoice', 'all'])
                    .default('all')
                    .describe('Which document type(s) to check'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ document_type }) => {
            try {
                const typeIds: number[] = [];
                if (document_type === 'all' || document_type === 'incoming_invoice') {
                    if (config.document_type_ids.incoming_invoice > 0)
                        typeIds.push(config.document_type_ids.incoming_invoice);
                }
                if (document_type === 'all' || document_type === 'outgoing_invoice') {
                    if (config.document_type_ids.outgoing_invoice > 0)
                        typeIds.push(config.document_type_ids.outgoing_invoice);
                }

                let total = 0;
                let withInvoiceNumber = 0;
                let withQontoMatch = 0;

                for (const typeId of typeIds) {
                    const docs = await fetchAllPages((page, pageSize) =>
                        listDocuments({ document_type_id: typeId, page, page_size: pageSize, ordering: 'id' }),
                    );
                    total += docs.length;
                    for (const doc of docs) {
                        if (hasSyncField(doc, config.custom_field_ids.invoice_number)) withInvoiceNumber++;
                        if (hasSyncField(doc, config.custom_field_ids.qonto_transaction_id)) withQontoMatch++;
                    }
                }

                return mcpSuccess({
                    total,
                    with_invoice_number: withInvoiceNumber,
                    without_invoice_number: total - withInvoiceNumber,
                    with_qonto_match: withQontoMatch,
                    without_qonto_match: total - withQontoMatch,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
