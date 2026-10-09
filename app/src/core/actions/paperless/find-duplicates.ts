/**
 * Find duplicate documents by Rechnungsnummer, Bruttobetrag, and Rechnungsdatum; merge custom fields.
 * Primary document = the one with the most non-empty custom fields; merged values prefer primary, then fill from others.
 * After merge: tag duplicates as "duplicate" and move to Paperless trash (soft-delete).
 * Used by paperless find-duplicates-incoming and find-duplicates-outgoing.
 */

import {
    listDocuments,
    getDocument,
    updateDocument,
    deleteDocument,
    type Document,
    getCustomFieldValue,
    isEmptyValue,
    normalizeAmountValue,
} from '@steuererklaerung/paperless';
import { getLogger } from '../../lib/logger.ts';
import { fetchAllPages } from '@steuererklaerung/paperless';
import { normalizeDateValue } from '@steuererklaerung/shared';
import type { SyncConfig } from '../../config/index.ts';
import { PaperlessSetupError, SETUP_HINT } from '../../lib/errors.ts';

const log = getLogger('paperless-find-duplicates');

/** Number of custom fields that have a non-empty value. */
function countFilledCustomFields(doc: Document): number {
    if (!doc.custom_fields?.length) return 0;
    return doc.custom_fields.filter((c) => !isEmptyValue(c.value)).length;
}

/**
 * Merge custom fields from multiple documents. For each field id, use value from primary if non-empty,
 * otherwise from the first other document (by fill count desc) that has a non-empty value.
 */
function mergeCustomFields(docs: Document[], _primary: Document): Array<{ field: number; value: unknown }> {
    const byField = new Map<number, unknown>();
    const sorted = [...docs].sort((a, b) => countFilledCustomFields(b) - countFilledCustomFields(a));

    for (const doc of sorted) {
        for (const { field, value } of doc.custom_fields ?? []) {
            if (isEmptyValue(value)) continue;
            if (!byField.has(field)) {
                byField.set(field, value);
            }
        }
    }

    return Array.from(byField.entries(), ([field, value]) => ({ field, value }));
}

export interface FindDuplicatesGroupInfo {
    groupKey: string;
    primaryId: number;
    primaryTitle: string | null;
    duplicateIds: number[];
    duplicateTitles: (string | null)[];
}

export type FindDuplicatesGroupChoice = 'merge' | 'skip' | 'quit';

export interface FindDuplicatesOptions {
    dryRun?: boolean;
    /** When set, called for each duplicate group; return 'merge' to process, 'skip' to skip, 'quit' to stop. */
    onGroupProcessed?: (info: FindDuplicatesGroupInfo) => Promise<FindDuplicatesGroupChoice>;
}

export interface FindDuplicatesResult {
    groupsFound: number;
    documentsMerged: number;
    /** Number of duplicates tagged and moved to trash. */
    duplicatesTrashed: number;
    errors: number;
}

async function loadAllDocumentsWithDetails(documentTypeId: number): Promise<Document[]> {
    const summaries = await fetchAllPages((page, pageSize) =>
        listDocuments({ document_type_id: documentTypeId, page_size: pageSize, page }),
    );
    const docs: Document[] = [];
    for (const summary of summaries) {
        const full = await getDocument(summary.id);
        docs.push(full);
    }
    return docs;
}

/**
 * Tag a document as "duplicate" and move it to trash (soft-delete).
 * The tag makes it easy to identify why the document was trashed.
 */
async function tagAndTrashDuplicate(doc: Document, duplicateTagId: number): Promise<void> {
    // Add "duplicate" tag if not already present
    const existingTags = doc.tags ?? [];
    if (duplicateTagId > 0 && !existingTags.includes(duplicateTagId)) {
        await updateDocument(doc.id, { tags: [...existingTags, duplicateTagId] });
    }
    // Move to trash (Paperless uses SoftDeleteModel — DELETE = soft-delete)
    await deleteDocument(doc.id);
}

/**
 * Find duplicates by invoice_number within the given document type, merge custom fields into primary
 * (document with most fields), then tag duplicates and move them to trash.
 */
export async function findAndMergeDuplicates(
    config: SyncConfig,
    documentTypeId: number,
    options: FindDuplicatesOptions = {},
): Promise<FindDuplicatesResult> {
    const result: FindDuplicatesResult = {
        groupsFound: 0,
        documentsMerged: 0,
        duplicatesTrashed: 0,
        errors: 0,
    };

    const cf = config.custom_field_ids;
    const invoiceNumberFieldId = cf.invoice_number;
    const totalGrossFieldId = cf.total_gross;
    const invoiceDateFieldId = cf.invoice_date;
    const duplicateTagId = config.tag_ids.duplicate ?? 0;

    if (!invoiceNumberFieldId) {
        throw new PaperlessSetupError(`invoice_number custom field ID not set in sync-config. ${SETUP_HINT}`, [
            'custom_field_ids.invoice_number',
        ]);
    }
    if (!totalGrossFieldId || !invoiceDateFieldId) {
        throw new Error(
            `total_gross and invoice_date custom field IDs must be set in sync-config for duplicate detection.`,
        );
    }

    const allDocs = await loadAllDocumentsWithDetails(documentTypeId);
    const byGroupKey = new Map<string, Document[]>();

    for (const doc of allDocs) {
        // Verify document_type matches — the API filter is not always strict
        if (doc.document_type !== documentTypeId) continue;

        // Skip documents already tagged as duplicate (e.g. from a previous run)
        if (duplicateTagId > 0 && (doc.tags ?? []).includes(duplicateTagId)) continue;

        const invoiceNumber = getCustomFieldValue(doc, invoiceNumberFieldId);
        const invoiceNumberStr =
            invoiceNumber != null && typeof invoiceNumber === 'string'
                ? invoiceNumber.trim()
                : String(invoiceNumber ?? '').trim();
        if (!invoiceNumberStr) continue;

        const dateNorm = normalizeDateValue(getCustomFieldValue(doc, invoiceDateFieldId));
        const amountNorm = normalizeAmountValue(getCustomFieldValue(doc, totalGrossFieldId));
        if (dateNorm == null || amountNorm == null) continue;

        // Include correspondent in key: different senders = not a duplicate
        // (e.g. Klarna referencing a Notebook-Pro invoice number, or Sammelrechnung from Steuerberater)
        const corrId = doc.correspondent ?? 'none';
        const key = `${corrId}|${invoiceNumberStr}|${dateNorm}|${amountNorm}`;
        if (!byGroupKey.has(key)) {
            byGroupKey.set(key, []);
        }
        byGroupKey.get(key)!.push(doc);
    }

    for (const [groupKey, group] of byGroupKey) {
        if (group.length < 2) continue;

        result.groupsFound += 1;
        const sorted = [...group].sort((a, b) => countFilledCustomFields(b) - countFilledCustomFields(a));
        const primary = sorted[0];
        const duplicates = sorted.slice(1);
        const merged = mergeCustomFields(sorted, primary);

        const groupInfo: FindDuplicatesGroupInfo = {
            groupKey,
            primaryId: primary.id,
            primaryTitle: primary.original_file_name ?? primary.title ?? null,
            duplicateIds: duplicates.map((d) => d.id),
            duplicateTitles: duplicates.map((d) => d.original_file_name ?? d.title ?? null),
        };

        if (options.onGroupProcessed) {
            const choice = await options.onGroupProcessed(groupInfo);
            if (choice === 'quit') break;
            if (choice === 'skip') continue;
        }

        if (options.dryRun) {
            log.info(
                `[dry-run] Duplicate group "${groupKey}": primary #${primary.id} (${primary.original_file_name ?? primary.title ?? '—'}), ${duplicates.length} duplicate(s): ${duplicates.map((d) => `#${d.id}`).join(', ')}`,
            );
            result.documentsMerged += 1;
            continue;
        }

        // Step 1: Merge custom fields into primary
        try {
            await updateDocument(primary.id, { custom_fields: merged });
            result.documentsMerged += 1;
            log.info(`Merged ${group.length} documents (${groupKey}) into #${primary.id}`);
        } catch (e) {
            log.error(
                `Failed to update primary document #${primary.id} for "${groupKey}": ${e instanceof Error ? e.message : e}`,
            );
            result.errors += 1;
            continue;
        }

        // Step 2: Tag duplicates as "duplicate" and move to trash
        for (const doc of duplicates) {
            try {
                await tagAndTrashDuplicate(doc, duplicateTagId);
                result.duplicatesTrashed += 1;
                log.info(`Tagged and trashed duplicate #${doc.id} (${doc.original_file_name ?? doc.title ?? '—'})`);
            } catch (e) {
                log.error(`Failed to trash duplicate #${doc.id}: ${e instanceof Error ? e.message : e}`);
                result.errors += 1;
            }
        }
    }

    return result;
}
