/**
 * Review document metadata (title, correspondent, document type, created date) via LLM
 * and optionally run type-specific handlers (e.g. invoice extraction).
 *
 * Refactored: the monolithic reviewMetadata() is split into phases:
 * - collectDocumentIds(): gather candidate document IDs
 * - reviewSingleDocument(): process one document (LLM call, parse, resolve, update)
 * - reviewMetadata(): orchestrate the above
 */

import {
    type Document,
    type Correspondent,
    type DocumentType,
    listDocuments,
    getDocument,
    updateDocument,
    listCorrespondents,
    listDocumentTypes,
    createCorrespondent,
    createDocumentType,
    getCustomFieldValue,
    isEmptyValue,
} from '@steuererklaerung/paperless';
import { getLLMProvider, type LLMProvider } from '../../clients/llm/index.ts';
import { extractJsonCandidate, parseJsonLeniently, isDateInRange, toDateOnly } from '@steuererklaerung/shared';
import { DEFAULTS } from '../../constants.ts';
import type { Logger } from '../../lib/logger.ts';
import { getLogger } from '../../lib/logger.ts';
import { fetchAllPages } from '@steuererklaerung/paperless';
import {
    getReviewMetadataSystemPrompt,
    getReviewMetadataOwnBlock,
    getReviewMetadataCurrentTypeHint,
    getReviewMetadataContentTagsBlock,
    REVIEW_METADATA_USER_LABEL_CORRESPONDENTS,
    REVIEW_METADATA_USER_LABEL_DOCUMENT_TYPES,
    REVIEW_METADATA_USER_LABEL_DOCUMENT_CONTENT,
} from '../../lib/prompts.ts';
import type { SyncConfig } from '../../config/index.ts';
import { getDocumentTypeHandlers } from './type-handlers.ts';
import { MAX_CONTENT_LENGTH } from './extract-invoice.ts';

const PAGE_SIZE = DEFAULTS.PAGE_SIZE;
const THROTTLE_MS = DEFAULTS.API_THROTTLE_MS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewMetadataOptions {
    force?: boolean;
    dryRun?: boolean;
    auto?: boolean;
    from?: string;
    to?: string;
    documentTypeIds?: number[];
    limit?: number;
    query?: string;
    onDocumentProcessed?: (info: ReviewMetadataProcessedInfo) => Promise<void>;
}

export interface ReviewMetadataProcessedInfo {
    documentId: number;
    updated: boolean;
    changes: string[];
}

export interface ReviewMetadataResult {
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MetadataReviewResponse {
    title?: string | null;
    correspondent_id?: number | null;
    correspondent_create_name?: string | null;
    document_type_id?: number | null;
    document_type_create_name?: string | null;
    created?: string | null;
    add_tag_ids?: number[] | null;
}

interface ReviewResources {
    correspondentsList: Array<{ id: number; name: string }>;
    documentTypesList: Array<{ id: number; name: string }>;
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

function normalizeContent(content: string | null | undefined): string {
    if (content == null) return '';
    return content.replace(/\s+/g, ' ').trim();
}

function parseDocumentDate(value: string | null | undefined): string | null {
    if (value == null || typeof value !== 'string') return null;
    const d = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function resolveCorrespondentId(
    correspondentId: number | null,
    documentTypeId: number | null,
    currentCorrespondent: number | null,
    outgoingInvoiceTypeId: number | undefined,
    ownCorrespondentIds: number[],
): number | null {
    if (outgoingInvoiceTypeId == null || documentTypeId !== outgoingInvoiceTypeId) {
        return correspondentId;
    }
    if (correspondentId != null && ownCorrespondentIds.includes(correspondentId)) {
        return currentCorrespondent;
    }
    return correspondentId;
}

function resolveName(id: number | null, list: Array<{ id: number; name: string }>): string {
    if (id == null) return '—';
    const item = list.find((x) => x.id === id);
    return item ? `${item.name} (${id})` : `#${id}`;
}

/** Resolve just the display name (no id suffix) for a correspondent/type id. */
function findName(id: number, list: Array<{ id: number; name: string }>): string {
    return list.find((x) => x.id === id)?.name ?? `#${id}`;
}

/** Keep the KI-Hinweis (ai_note) rationale to a single short line (< 200 chars). */
const MAX_AI_NOTE_LENGTH = 199;

export interface AiNoteRationaleInput {
    /** Date the review ran, YYYY-MM-DD. */
    date: string;
    /** Model id that produced the recommendation (provenance). */
    model: string;
    /** Resolved correspondent display name, if a correspondent is set on the reviewed doc. */
    correspondentName?: string | null;
    /** Resolved document-type display name, if a type is set. */
    documentTypeName?: string | null;
    /** Whether a type-specific handler (e.g. invoice extraction) enriched the doc. */
    typeEnrichmentApplied?: boolean;
    /** Human-readable names of content tags this review added. */
    addedTagNames?: string[];
}

/**
 * Build the concise German rationale written to the `ai_note` (KI-Hinweis) custom
 * field — WHAT the review resolved plus provenance (model), on one line < 200 chars.
 * Deterministic post-step: it does not change what the LLM is asked.
 */
export function buildAiNoteRationale(input: AiNoteRationaleInput): string {
    const parts: string[] = [];
    if (input.correspondentName) parts.push(`Korrespondent «${input.correspondentName}»`);
    if (input.documentTypeName) parts.push(`Typ «${input.documentTypeName}»`);
    if (input.typeEnrichmentApplied) parts.push('Rechnungsdaten erkannt');
    if (input.addedTagNames && input.addedTagNames.length > 0) parts.push(`Tags: ${input.addedTagNames.join(', ')}`);
    const body = parts.length > 0 ? parts.join(', ') : 'Metadaten geprüft';
    const note = `KI-Review ${input.date}: ${body}. Modell «${input.model}».`;
    return note.length > MAX_AI_NOTE_LENGTH ? `${note.slice(0, MAX_AI_NOTE_LENGTH - 1)}…` : note;
}

/**
 * Merge the ai_note rationale into an update payload's `custom_fields`, OVERWRITING
 * any prior ai_note entry (a fresh rationale each review) while preserving every
 * other custom field. Paperless replaces the whole custom_fields array on PATCH, so
 * callers must seed the payload with the document's existing custom fields first.
 * No-op when the ai_note field is not configured (id ≤ 0).
 */
export function applyAiNoteToPayload(
    payload: { custom_fields?: Array<{ field: number; value: unknown }> },
    aiNoteFieldId: number,
    rationale: string,
): void {
    if (aiNoteFieldId <= 0) return;
    const existing = payload.custom_fields ?? [];
    payload.custom_fields = [
        ...existing.filter((c) => c.field !== aiNoteFieldId),
        { field: aiNoteFieldId, value: rationale },
    ];
}

/**
 * Persist a computed update payload, honoring `dryRun`. The updater is injectable
 * so the dry-run gate is unit-testable without hitting Paperless. Returns whether
 * a write actually happened.
 */
export async function commitDocumentUpdate(
    id: number,
    payload: Parameters<typeof updateDocument>[1],
    options: { dryRun?: boolean },
    log: Logger,
    update: (id: number, payload: Parameters<typeof updateDocument>[1]) => Promise<unknown> = updateDocument,
): Promise<boolean> {
    if (options.dryRun) {
        log.info(`[dry-run] Document ${id}: would update metadata and type-specific fields`);
        return false;
    }
    await update(id, payload);
    return true;
}

function buildPrompts(
    lang: 'de' | 'en',
    correspondents: Array<{ id: number; name: string }>,
    documentTypes: Array<{ id: number; name: string }>,
    ownCorrespondentIds: number[],
    contentTagIds: { school?: number; finance?: number; server_infrastructure?: number },
    current: {
        title: string | null;
        correspondent: number | null;
        document_type: number | null;
        created: string | null;
    },
    content: string,
): { system: string; user: string } {
    const system = getReviewMetadataSystemPrompt(lang);
    const correspondentsBlock = correspondents.map((c) => `  ${c.id}: ${c.name}`).join('\n');
    const typesBlock = documentTypes.map((t) => `  ${t.id}: ${t.name}`).join('\n');
    const ownBlock = getReviewMetadataOwnBlock(lang, ownCorrespondentIds);
    const contentTagsBlock = getReviewMetadataContentTagsBlock(lang, contentTagIds);
    const currentTypeName =
        current.document_type != null
            ? (documentTypes.find((t) => t.id === current.document_type)?.name ?? null)
            : null;
    const currentTypeHint = getReviewMetadataCurrentTypeHint(lang, currentTypeName, current.document_type ?? null);

    const user = [
        REVIEW_METADATA_USER_LABEL_CORRESPONDENTS,
        correspondentsBlock,
        REVIEW_METADATA_USER_LABEL_DOCUMENT_TYPES,
        typesBlock,
        ownBlock,
        contentTagsBlock,
        `Current metadata: title="${current.title ?? ''}" correspondent_id=${current.correspondent ?? 'null'} document_type_id=${current.document_type ?? 'null'} created=${current.created ?? 'null'}`,
        currentTypeHint,
        REVIEW_METADATA_USER_LABEL_DOCUMENT_CONTENT,
        content || '(empty)',
    ]
        .filter(Boolean)
        .join('\n\n');

    return { system, user };
}

function buildChangeSummary(
    doc: Document,
    applied: {
        title?: string;
        correspondentId: number | null;
        documentTypeId: number | null;
        created: string | null;
        addedContentTagNames?: string[];
    },
    resources: ReviewResources,
    typeHandlerApplied: boolean,
): string[] {
    const lines: string[] = [];
    const oldTitle = doc.title ?? doc.original_file_name ?? '—';
    if (applied.title != null && applied.title !== (doc.title ?? '')) {
        lines.push(`Title: "${oldTitle}" → "${applied.title}"`);
    }
    if (applied.correspondentId !== (doc.correspondent ?? null)) {
        lines.push(
            `Correspondent: ${resolveName(doc.correspondent ?? null, resources.correspondentsList)} → ${resolveName(applied.correspondentId, resources.correspondentsList)}`,
        );
    }
    if (applied.documentTypeId !== (doc.document_type ?? null)) {
        lines.push(
            `Document type: ${resolveName(doc.document_type ?? null, resources.documentTypesList)} → ${resolveName(applied.documentTypeId, resources.documentTypesList)}`,
        );
    }
    const oldCreated = doc.created ? doc.created.slice(0, 10) : null;
    if (applied.created != null && applied.created !== oldCreated) {
        lines.push(`Created: ${oldCreated ?? '—'} → ${applied.created}`);
    }
    if (applied.addedContentTagNames != null && applied.addedContentTagNames.length > 0) {
        lines.push(`Tags added: ${applied.addedContentTagNames.join(', ')}`);
    }
    if (typeHandlerApplied) {
        lines.push('Type-specific enrichment applied (e.g. invoice fields)');
    }
    return lines;
}

function buildContentTagNameMap(config: SyncConfig): Record<number, string> {
    const map: Record<number, string> = {};
    if (config.tag_ids.school > 0) map[config.tag_ids.school] = 'school';
    if (config.tag_ids.finance > 0) map[config.tag_ids.finance] = 'finance';
    if (config.tag_ids.server_infrastructure > 0) map[config.tag_ids.server_infrastructure] = 'server_infrastructure';
    if (config.tag_ids.irrelevant > 0) map[config.tag_ids.irrelevant] = 'irrelevant';
    return map;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchAllCorrespondents(): Promise<Correspondent[]> {
    return fetchAllPages((page, pageSize) => listCorrespondents({ page_size: pageSize, page }), PAGE_SIZE);
}

async function fetchAllDocumentTypes(): Promise<DocumentType[]> {
    return fetchAllPages((page, pageSize) => listDocumentTypes({ page_size: pageSize, page }), PAGE_SIZE);
}

/** Collect document IDs matching filters. */
async function collectDocumentIds(config: SyncConfig, options: ReviewMetadataOptions): Promise<number[]> {
    const ids: number[] = [];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const kiTagId = config.tag_ids.ai_reviewed ?? 0;
    const documentTypeIds = options.documentTypeIds ?? [];
    const query = options.query;

    const fetchPage = async (documentTypeId: number | undefined, page: number) => {
        const params: { page_size: number; page: number; query?: string; document_type_id?: number } = {
            page_size: PAGE_SIZE,
            page,
        };
        if (query) params.query = query;
        if (documentTypeId != null) params.document_type_id = documentTypeId;
        return listDocuments(params);
    };

    const typeIdsToFetch = documentTypeIds.length > 0 ? documentTypeIds : [undefined];
    for (const docTypeId of typeIdsToFetch) {
        let page = 1;
        let hasMore = true;
        while (hasMore && ids.length < limit) {
            const res = await fetchPage(docTypeId, page);
            for (const doc of res.results ?? []) {
                if (ids.length >= limit) break;
                if (!isDateInRange(doc.created, options.from, options.to)) continue;
                const hasKiTag = kiTagId > 0 && (doc.tags ?? []).includes(kiTagId);
                if (!options.force && hasKiTag) {
                    const isInvoiceType =
                        doc.document_type != null &&
                        (doc.document_type === config.document_type_ids.incoming_invoice ||
                            doc.document_type === config.document_type_ids.outgoing_invoice);
                    if (isInvoiceType && config.custom_field_ids.invoice_number > 0) {
                        const invoiceNumber = getCustomFieldValue(doc, config.custom_field_ids.invoice_number);
                        if (!isEmptyValue(invoiceNumber)) continue;
                    } else if (!isInvoiceType) {
                        continue;
                    }
                }
                ids.push(doc.id);
            }
            hasMore = (res.next ?? null) != null && (res.next ?? '') !== '';
            page += 1;
        }
        if (ids.length >= limit) break;
    }

    return ids.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Per-document processing (extracted from the monolithic loop)
// ---------------------------------------------------------------------------

interface ReviewSingleDocumentParams {
    doc: Document;
    config: SyncConfig;
    provider: LLMProvider;
    resources: ReviewResources;
    typeHandlers: Map<number, (doc: Document, config: SyncConfig) => Promise<unknown>>;
    log: Logger;
}

interface ReviewSingleDocumentResult {
    /** 'updated' | 'error' | 'skipped' */
    outcome: 'updated' | 'error';
    changes: string[];
    /** Mutable: may add entries to correspondentsList or documentTypesList. */
    newCorrespondent?: { id: number; name: string };
    newDocumentType?: { id: number; name: string };
}

/**
 * Process a single document: call LLM, parse response, resolve correspondent/type,
 * run type handlers, build payload, update document.
 */
async function reviewSingleDocument(
    params: ReviewSingleDocumentParams,
    options: ReviewMetadataOptions,
): Promise<ReviewSingleDocumentResult> {
    const { doc, config, provider, resources, typeHandlers, log } = params;
    const id = doc.id;
    const language = config.preferred_language ?? 'de';
    const kiTagId = config.tag_ids.ai_reviewed ?? 0;
    const ownCorrespondentIds = config.own_correspondent_ids ?? [];

    // Prepare content and current metadata
    const content = normalizeContent(doc.content);
    const contentForLlm = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;
    const current = {
        title: doc.title ?? null,
        correspondent: doc.correspondent ?? null,
        document_type: doc.document_type ?? null,
        created: doc.created ? (parseDocumentDate(doc.created) ?? doc.created.slice(0, 10)) : null,
    };

    // Call LLM
    const { system, user } = buildPrompts(
        language,
        resources.correspondentsList,
        resources.documentTypesList,
        ownCorrespondentIds,
        config.tag_ids,
        current,
        contentForLlm,
    );

    let raw: string;
    try {
        raw = (await provider.complete({ system, user, json: true, maxTokens: 1024 })).text;
    } catch (e) {
        log.error(`LLM failed for document ${id}: ${e instanceof Error ? e.message : e}`);
        return { outcome: 'error', changes: [] };
    }

    const parsed = parseJsonLeniently(extractJsonCandidate(raw) ?? raw);
    if (parsed == null || typeof parsed !== 'object') {
        log.error(`Invalid JSON from LLM for document ${id}, skipping.`);
        return { outcome: 'error', changes: [] };
    }
    const resp = parsed as MetadataReviewResponse;

    // Resolve correspondent
    let correspondentId: number | null = current.correspondent;
    let newCorrespondent: { id: number; name: string } | undefined;
    if (resp.correspondent_id != null && resp.correspondent_id > 0) {
        correspondentId = resp.correspondent_id;
    } else if (resp.correspondent_create_name != null && String(resp.correspondent_create_name).trim()) {
        try {
            const created = await createCorrespondent({ name: String(resp.correspondent_create_name).trim() });
            correspondentId = created.id;
            newCorrespondent = { id: created.id, name: created.name };
        } catch (e) {
            log.error(`Failed to create correspondent for document ${id}: ${e instanceof Error ? e.message : e}`);
            return { outcome: 'error', changes: [] };
        }
    }

    // Resolve document type
    let documentTypeId: number | null = current.document_type;
    let newDocumentType: { id: number; name: string } | undefined;
    if (resp.document_type_id != null && resp.document_type_id > 0) {
        documentTypeId = resp.document_type_id;
    } else if (resp.document_type_create_name != null && String(resp.document_type_create_name).trim()) {
        try {
            const created = await createDocumentType({ name: String(resp.document_type_create_name).trim() });
            documentTypeId = created.id;
            newDocumentType = { id: created.id, name: created.name };
        } catch (e) {
            log.error(`Failed to create document type for document ${id}: ${e instanceof Error ? e.message : e}`);
            return { outcome: 'error', changes: [] };
        }
    }

    correspondentId = resolveCorrespondentId(
        correspondentId,
        documentTypeId,
        current.correspondent,
        config.document_type_ids?.outgoing_invoice,
        ownCorrespondentIds,
    );

    const createdDate = resp.created != null && String(resp.created).trim() ? toDateOnly(resp.created) : null;

    // Build metadata payload
    const metadataPayload: Record<string, unknown> = {};
    if (resp.title != null && String(resp.title).trim()) metadataPayload.title = String(resp.title).trim();
    if (correspondentId !== current.correspondent) metadataPayload.correspondent = correspondentId;
    if (documentTypeId !== current.document_type) metadataPayload.document_type = documentTypeId;
    if (createdDate != null) metadataPayload.created = createdDate;

    // Merge tags
    const allowedContentTagIds = [
        config.tag_ids.school,
        config.tag_ids.finance,
        config.tag_ids.server_infrastructure,
        config.tag_ids.irrelevant,
    ].filter((tid): tid is number => tid != null && tid > 0);
    const suggestedTagIds = Array.isArray(resp.add_tag_ids)
        ? resp.add_tag_ids.filter((tid) => typeof tid === 'number' && allowedContentTagIds.includes(tid))
        : [];
    const tagIds = doc.tags ?? [];
    const mergedTags = kiTagId > 0 && !tagIds.includes(kiTagId) ? [...tagIds, kiTagId] : [...tagIds];
    for (const tagId of suggestedTagIds) {
        if (!mergedTags.includes(tagId)) mergedTags.push(tagId);
    }
    metadataPayload.tags = mergedTags;

    // Run type-specific handler
    let typeHandlerPayload: Record<string, unknown> | null = null;
    const finalDocumentTypeId = documentTypeId ?? doc.document_type;
    if (finalDocumentTypeId != null) {
        const handler = typeHandlers.get(finalDocumentTypeId);
        if (handler) {
            try {
                const docForHandler = {
                    ...doc,
                    correspondent: correspondentId,
                    document_type: documentTypeId,
                } as Document;
                typeHandlerPayload = (await handler(docForHandler, config)) as Record<string, unknown> | null;
            } catch (e) {
                log.error(`Type handler failed for document ${id}: ${e instanceof Error ? e.message : e}`);
                return { outcome: 'error', changes: [] };
            }
        }
    }

    // Merge type handler results into final payload
    const finalPayload: Record<string, unknown> = { ...metadataPayload };
    if (typeHandlerPayload) {
        if (typeHandlerPayload.custom_fields) {
            const existing = (doc.custom_fields ?? []) as Array<{ field: number; value: unknown }>;
            const incoming = typeHandlerPayload.custom_fields as Array<{ field: number; value: unknown }>;
            const fieldIds = new Set(incoming.map((c) => c.field));
            finalPayload.custom_fields = [...existing.filter((c) => !fieldIds.has(c.field)), ...incoming];
        }
        if (typeHandlerPayload.tags) {
            const existing = (finalPayload.tags as number[]) ?? [];
            finalPayload.tags = [...new Set([...existing, ...(typeHandlerPayload.tags as number[])])];
        }
    }

    // Build change summary
    const contentTagNameMap = buildContentTagNameMap(config);
    const existingDocTagIds = doc.tags ?? [];
    const addedContentTagIds = suggestedTagIds.filter((tid) => !existingDocTagIds.includes(tid));
    const addedContentTagNames = addedContentTagIds.map((tid) => contentTagNameMap[tid] ?? String(tid));

    const changes = buildChangeSummary(
        doc,
        {
            title: metadataPayload.title as string | undefined,
            correspondentId,
            documentTypeId,
            created: createdDate,
            addedContentTagNames: addedContentTagNames.length > 0 ? addedContentTagNames : undefined,
        },
        resources,
        typeHandlerPayload != null,
    );

    // Record the AI rationale into KI-Hinweis (ai_note) — a deterministic post-step
    // (no extra LLM call). Overwrites any prior note so each review is fresh.
    const aiNoteFieldId = config.custom_field_ids?.ai_note ?? 0;
    if (aiNoteFieldId > 0) {
        // Paperless PATCH replaces the whole custom_fields array; when no type handler
        // set it, seed from the doc's existing fields so nothing else is dropped.
        const fp = finalPayload as { custom_fields?: Array<{ field: number; value: unknown }> };
        if (fp.custom_fields == null) {
            fp.custom_fields = [...((doc.custom_fields ?? []) as Array<{ field: number; value: unknown }>)];
        }
        const rationale = buildAiNoteRationale({
            date: new Date().toISOString().slice(0, 10),
            model: provider.model,
            correspondentName: correspondentId != null ? findName(correspondentId, resources.correspondentsList) : null,
            documentTypeName: documentTypeId != null ? findName(documentTypeId, resources.documentTypesList) : null,
            typeEnrichmentApplied: typeHandlerPayload != null,
            addedTagNames: addedContentTagNames.length > 0 ? addedContentTagNames : undefined,
        });
        applyAiNoteToPayload(fp, aiNoteFieldId, rationale);
    }

    // Apply update (dry-run gated)
    try {
        await commitDocumentUpdate(id, finalPayload as Parameters<typeof updateDocument>[1], options, log);
    } catch (e) {
        log.error(`Failed to update document ${id}: ${e instanceof Error ? e.message : e}`);
        return { outcome: 'error', changes };
    }

    return { outcome: 'updated', changes, newCorrespondent, newDocumentType };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function reviewMetadata(
    config: SyncConfig,
    options: ReviewMetadataOptions = {},
): Promise<ReviewMetadataResult> {
    const provider = getLLMProvider();
    const log = getLogger('paperless-review-metadata');

    // Load resources
    let correspondentsList = (await fetchAllCorrespondents()).map((c) => ({ id: c.id, name: c.name }));
    let documentTypesList = (await fetchAllDocumentTypes()).map((t) => ({ id: t.id, name: t.name }));
    const resources: ReviewResources = { correspondentsList, documentTypesList };

    const typeHandlers = getDocumentTypeHandlers(config);
    const documentIds = await collectDocumentIds(config, options);

    const result: ReviewMetadataResult = { processed: 0, updated: 0, skipped: 0, errors: 0 };

    for (const id of documentIds) {
        let doc: Document;
        try {
            doc = await getDocument(id);
        } catch (e) {
            log.error(`Failed to get document ${id}: ${e instanceof Error ? e.message : e}`);
            result.errors += 1;
            continue;
        }

        const docResult = await reviewSingleDocument({ doc, config, provider, resources, typeHandlers, log }, options);

        // Update resources if new entities were created
        if (docResult.newCorrespondent) {
            correspondentsList = [...correspondentsList, docResult.newCorrespondent];
            resources.correspondentsList = correspondentsList;
        }
        if (docResult.newDocumentType) {
            documentTypesList = [...documentTypesList, docResult.newDocumentType];
            resources.documentTypesList = documentTypesList;
        }

        if (docResult.outcome === 'error') {
            result.errors += 1;
        } else {
            result.processed += 1;
            result.updated += 1;
        }

        if (options.onDocumentProcessed) {
            await options.onDocumentProcessed({
                documentId: id,
                updated: docResult.outcome === 'updated' && !options.dryRun,
                changes: docResult.changes,
            });
        }

        if (THROTTLE_MS > 0 && !options.dryRun) {
            await new Promise((r) => setTimeout(r, THROTTLE_MS));
        }
    }

    return result;
}
