/**
 * Sync Paperless → Qonto: upload documents as receipt attachments to Qonto transactions.
 * Candidates: qonto_transaction_id set, qonto_attachment_id not set.
 * For each: download from Paperless, upload to Qonto transaction, set qonto_attachment_id in Paperless.
 */

import {
    downloadDocument,
    getDocument,
    listDocuments,
    updateDocument,
    type Document,
    getStringField,
    hasSyncField,
    isDocInDateRange,
    mergeCustomFields,
} from '@steuererklaerung/paperless';
import { uploadAttachmentToTransaction } from '../../clients/qonto/index.ts';
import { getLogger } from '../../lib/logger.ts';
import { loadPaperlessConfig } from '../../config/index.ts';
import { configMissingError } from '../../lib/errors.ts';

const log = getLogger('sync-paperless-to-qonto');

export interface SyncPaperlessToQontoParams {
    dryRun?: boolean;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
}

export interface SyncPaperlessToQontoResult {
    uploaded: number;
    skippedAlreadySynced: number;
    skippedNoTransaction: number;
    errors: number;
    details: Array<{
        documentId: number;
        outcome: 'uploaded' | 'skipped_already_synced' | 'skipped_no_transaction' | 'error';
        message?: string;
    }>;
}

/**
 * Upload Paperless documents as attachments to linked Qonto transactions.
 * Candidates: documents with qonto_transaction_id but without qonto_attachment_id.
 */
export async function syncPaperlessToQonto(
    params: SyncPaperlessToQontoParams = {},
): Promise<SyncPaperlessToQontoResult> {
    const config = loadPaperlessConfig();
    const cf = config.custom_field_ids;
    if (!cf.qonto_transaction_id) {
        configMissingError('custom_field_ids.qonto_transaction_id');
    }
    if (!cf.qonto_attachment_id) {
        configMissingError('custom_field_ids.qonto_attachment_id');
    }

    const result: SyncPaperlessToQontoResult = {
        uploaded: 0,
        skippedAlreadySynced: 0,
        skippedNoTransaction: 0,
        errors: 0,
        details: [],
    };

    const dateFrom = params.dateFrom?.slice(0, 10);
    const dateTo = params.dateTo?.slice(0, 10);
    const limit = params.limit ?? Infinity;
    const dryRun = params.dryRun === true;

    // Collect candidate documents
    let page = 1;
    const pageSize = 100;
    const candidates: Document[] = [];

    while (true) {
        const res = await listDocuments({ page_size: pageSize, page });
        const docs = res.results ?? [];
        for (const doc of docs) {
            if (!hasSyncField(doc, cf.qonto_transaction_id)) continue;
            if (hasSyncField(doc, cf.qonto_attachment_id)) continue;
            if (!isDocInDateRange(doc, cf.qonto_settled_at, dateFrom, dateTo)) continue;
            candidates.push(doc);
            if (candidates.length >= limit) break;
        }
        if (candidates.length >= limit || docs.length < pageSize) break;
        page += 1;
    }

    const toProcess = candidates.slice(0, limit);
    const msg = `Found ${toProcess.length} candidate(s) for push to Qonto (dryRun=${dryRun}).`;
    log.info(msg);
    console.error(msg);

    for (const doc of toProcess) {
        const docId = doc.id;
        const qontoTxId = getStringField(doc, cf.qonto_transaction_id);

        if (!qontoTxId) {
            result.details.push({
                documentId: docId,
                outcome: 'skipped_no_transaction',
                message: 'No qonto_transaction_id',
            });
            result.skippedNoTransaction += 1;
            continue;
        }

        try {
            if (dryRun) {
                result.details.push({
                    documentId: docId,
                    outcome: 'uploaded',
                    message: `Would upload to Qonto transaction ${qontoTxId}`,
                });
                result.uploaded += 1;
                continue;
            }

            const fileBuffer = await downloadDocument(docId);
            const filename = doc.original_file_name ?? doc.title ?? `document-${docId}.pdf`;
            const mimeType = doc.mime_type ?? 'application/pdf';

            // Upload to Qonto
            const uploadResult = await uploadAttachmentToTransaction(qontoTxId, fileBuffer, filename, mimeType);
            const attachmentId =
                uploadResult && typeof uploadResult === 'object' && 'id' in uploadResult
                    ? (uploadResult as Record<string, unknown>).id
                    : null;

            // Update Paperless with qonto_attachment_id
            const refId = attachmentId ?? qontoTxId;
            const currentDoc = await getDocument(docId);
            const merged = mergeCustomFields(currentDoc.custom_fields ?? [], [
                { field: cf.qonto_attachment_id, value: refId },
            ]);
            await updateDocument(docId, { custom_fields: merged });

            result.details.push({
                documentId: docId,
                outcome: 'uploaded',
                message: `Uploaded to Qonto transaction ${qontoTxId}, attachment ref: ${refId}`,
            });
            result.uploaded += 1;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`Document ${docId} (Qonto tx ${qontoTxId}): ${message}`);
            result.details.push({ documentId: docId, outcome: 'error', message });
            result.errors += 1;
        }
    }

    return result;
}
