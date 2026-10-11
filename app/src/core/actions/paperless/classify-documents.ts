/**
 * Classify Paperless documents using LLM: analyze OCR content and assign the
 * best-matching document type from the full list of available types.
 */

import {
    listDocuments,
    updateDocument,
    listDocumentTypes,
    type Document,
    type DocumentType,
} from '@steuererklaerung/paperless';
import { z } from 'zod';
import { completeJson, getLLMProvider } from '../../clients/llm/index.ts';
import { DEFAULTS } from '../../constants.ts';
import { getLogger } from '../../lib/logger.ts';
import { fetchAllPages } from '@steuererklaerung/paperless';
import { DOCUMENT_CLASSIFICATION_SYSTEM_PROMPT, buildDocumentClassificationUserPrompt } from '../../lib/prompts.ts';

const log = getLogger('paperless-classify-documents');

const MAX_CONTENT_LENGTH = DEFAULTS.LLM_MAX_CONTENT_LENGTH;
const THROTTLE_MS = DEFAULTS.API_THROTTLE_MS;

const ClassificationResultSchema = z.object({
    document_type_id: z.number().int().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
});

export type ClassificationResult = z.output<typeof ClassificationResultSchema>;

export interface ClassifyDocumentsOptions {
    /** Only process documents of this type (e.g. to re-classify all incoming invoices). */
    documentTypeId?: number;
    /** Only process documents without a document type. */
    unclassified?: boolean;
    /** When true, skip documents where the LLM confirms the current type. */
    onlyWrong?: boolean;
    dryRun?: boolean;
    limit?: number;
    /** Cancels the run: the AI call in flight fails as cancelled and no further document is started. */
    signal?: AbortSignal;
    /** Called after each processed document. */
    onDocumentProcessed?: (info: ClassifyDocumentProcessedInfo) => Promise<void>;
}

export interface ClassifyDocumentProcessedInfo {
    documentId: number;
    title: string | null;
    fileName: string | null;
    previousTypeId: number | null;
    previousTypeName: string | null;
    newTypeId: number | null;
    newTypeName: string | null;
    confidence: string;
    reason: string;
    changed: boolean;
    updated: boolean;
}

export interface ClassifyDocumentsResult {
    processed: number;
    changed: number;
    unchanged: number;
    skipped: number;
    errors: number;
}

/**
 * Classify documents: send OCR content to LLM with full list of document types,
 * update document_type if the LLM suggests a different one.
 */
export async function classifyDocuments(options: ClassifyDocumentsOptions = {}): Promise<ClassifyDocumentsResult> {
    const provider = getLLMProvider();

    // Load all document types
    const allTypes = await fetchAllPages<DocumentType>((page, pageSize) =>
        listDocumentTypes({ page_size: pageSize, page }),
    );
    const typeMap = new Map(allTypes.map((t) => [t.id, t]));

    // Collect candidate documents (full objects, not just IDs — avoids double-fetch)
    const docs = await collectDocuments(options);

    const result: ClassifyDocumentsResult = {
        processed: 0,
        changed: 0,
        unchanged: 0,
        skipped: 0,
        errors: 0,
    };

    const limit = options.limit ?? Infinity;
    let count = 0;

    for (const doc of docs) {
        if (count >= limit || options.signal?.aborted) break;

        const content = doc.content?.trim();
        if (!content) {
            log.info(`Document ${doc.id} has no OCR content, skipping.`);
            result.skipped += 1;
            continue;
        }

        count += 1;
        result.processed += 1;

        const contentForLlm = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;

        const currentType = doc.document_type != null ? (typeMap.get(doc.document_type) ?? null) : null;

        let classification: ClassificationResult;
        try {
            const userPrompt = buildDocumentClassificationUserPrompt(
                contentForLlm,
                allTypes.map((t) => ({ id: t.id, name: t.name })),
                currentType ? { id: currentType.id, name: currentType.name } : null,
            );
            classification = (
                await completeJson(provider, {
                    system: DOCUMENT_CLASSIFICATION_SYSTEM_PROMPT,
                    user: userPrompt,
                    maxTokens: 256,
                    schema: ClassificationResultSchema,
                    ...(options.signal ? { signal: options.signal } : {}),
                })
            ).value;
        } catch (e) {
            log.error(`LLM failed for document ${doc.id}: ${e instanceof Error ? e.message : e}`);
            result.errors += 1;
            continue;
        }

        const newTypeId = classification.document_type_id;
        const newType = newTypeId != null ? (typeMap.get(newTypeId) ?? null) : null;
        const changed = newTypeId !== doc.document_type;

        if (options.onlyWrong && !changed) {
            result.unchanged += 1;
            continue;
        }

        const info: ClassifyDocumentProcessedInfo = {
            documentId: doc.id,
            title: doc.title ?? null,
            fileName: doc.original_file_name ?? null,
            previousTypeId: doc.document_type ?? null,
            previousTypeName: currentType?.name ?? null,
            newTypeId,
            newTypeName: newType?.name ?? null,
            confidence: classification.confidence,
            reason: classification.reason,
            changed,
            updated: false,
        };

        if (changed && !options.dryRun) {
            try {
                await updateDocument(doc.id, { document_type: newTypeId });
                info.updated = true;
                result.changed += 1;
            } catch (e) {
                log.error(`Failed to update document ${doc.id}: ${e instanceof Error ? e.message : e}`);
                result.errors += 1;
                continue;
            }
        } else if (changed) {
            result.changed += 1;
        } else {
            result.unchanged += 1;
        }

        if (options.onDocumentProcessed) {
            await options.onDocumentProcessed(info);
        }

        if (THROTTLE_MS > 0 && !options.dryRun) {
            await new Promise((r) => setTimeout(r, THROTTLE_MS));
        }
    }

    return result;
}

/**
 * Collect documents to classify. Returns full Document objects to avoid
 * a second getDocument() call per document in the main loop.
 */
async function collectDocuments(options: ClassifyDocumentsOptions): Promise<Document[]> {
    if (options.documentTypeId != null) {
        return fetchAllPages((page, pageSize) =>
            listDocuments({ document_type_id: options.documentTypeId!, page_size: pageSize, page }),
        );
    }

    if (options.unclassified) {
        const docs = await fetchAllPages((page, pageSize) => listDocuments({ page_size: pageSize, page }));
        return docs.filter((d) => d.document_type == null);
    }

    return fetchAllPages((page, pageSize) => listDocuments({ page_size: pageSize, page }));
}
