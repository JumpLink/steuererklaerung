/**
 * Import a Qonto attachment into Paperless: download file, upload, set custom fields
 * (Qonto Transaction/Attachment ID) and optional qonto-import tag. On duplicate,
 * updates the existing document with the same metadata.
 */

import { getAttachment, downloadAttachmentContent } from '../../clients/qonto/index.ts';
import {
    bulkEditDocuments,
    getDocument,
    postDocument,
    updateDocument,
    waitForTaskResult,
} from '@steuererklaerung/paperless';
import { getLogger } from '../../lib/logger.ts';
import { toDateOnly } from '@steuererklaerung/shared';
import type { SyncConfig } from '../../config/index.ts';
import { loadPaperlessConfig } from '../../config/index.ts';
import { configMissingError } from '../../lib/errors.ts';

const log = getLogger('sync-import');

export type TransactionSide = 'credit' | 'debit';

export interface ImportAttachmentToPaperlessParams {
    transactionId: string;
    attachmentId: string;
    side: TransactionSide;
    /** Transaction amount in cents (for Qonto Transaktionsbetrag). Optional; stored as signed float (debit negative). */
    amount_cents?: number;
    /** Settlement date ISO string (for Qonto Buchungsdatum). Optional; stored as YYYY-MM-DD. */
    settled_at?: string | null;
    /** Transaction currency (e.g. EUR) for Qonto Währung. Optional. */
    amount_currency?: string;
    /** Transaction label / counterparty name from Qonto (e.g. "DIGITALOCEAN_COM"). */
    label?: string;
    /** SEPA reference / Verwendungszweck from Qonto. May contain invoice number. */
    reference?: string | null;
    /** VAT amount from Qonto transaction (in transaction currency). */
    vat_amount?: number | null;
    /** If omitted, loadPaperlessConfig() is used (requires valid document_type_ids and custom_field_ids). */
    config?: SyncConfig;
}

export interface ImportAttachmentToPaperlessResult {
    documentId: number;
    created: boolean;
}

/**
 * Apply Qonto custom fields and optional qonto-import tag to a Paperless document.
 * Uses bulkEdit add_custom_fields so existing fields (Rechnung, BB, etc.) are not overwritten.
 */
async function applyQontoMetadata(
    documentId: number,
    config: SyncConfig,
    params: ImportAttachmentToPaperlessParams,
): Promise<void> {
    const cf = config.custom_field_ids;

    const addFields: Record<number, unknown> = {
        [cf.qonto_transaction_id]: params.transactionId,
        [cf.qonto_attachment_id]: params.attachmentId,
    };
    if (cf.qonto_transaction_amount && params.amount_cents != null) {
        const signed = params.side === 'debit' ? -Math.abs(params.amount_cents) : Math.abs(params.amount_cents);
        addFields[cf.qonto_transaction_amount] = signed / 100;
    }
    const dateValue = toDateOnly(params.settled_at ?? null);
    if (cf.qonto_settled_at && dateValue) {
        addFields[cf.qonto_settled_at] = dateValue;
    }
    if (cf.qonto_currency) {
        addFields[cf.qonto_currency] = params.amount_currency || 'EUR';
    }
    if (cf.qonto_label && params.label) {
        addFields[cf.qonto_label] = params.label;
    }
    if (cf.qonto_reference && params.reference) {
        addFields[cf.qonto_reference] = params.reference;
    }
    if (cf.qonto_vat_amount && params.vat_amount != null) {
        const currency = params.amount_currency || 'EUR';
        addFields[cf.qonto_vat_amount] = `${currency}${Math.abs(params.vat_amount).toFixed(2)}`;
    }
    log.info(`applyQontoMetadata #${documentId}: add_custom_fields=${JSON.stringify(addFields)}`);
    await bulkEditDocuments([documentId], 'modify_custom_fields', {
        add_custom_fields: addFields,
        remove_custom_fields: [],
    });

    const qontoImportTagId = config.tag_ids.qonto_import;
    if (qontoImportTagId > 0) {
        const doc = await getDocument(documentId);
        const mergedTags = [...new Set([...(doc.tags ?? []), qontoImportTagId])];
        await updateDocument(documentId, { tags: mergedTags });
    }
}

/**
 * Update an existing Paperless document with current Qonto transaction/attachment metadata
 * (custom fields and tag). Use when the document was already imported but amount/date changed.
 */
export async function updateExistingDocumentQontoMetadata(
    documentId: number,
    params: ImportAttachmentToPaperlessParams,
): Promise<void> {
    const config = params.config ?? loadPaperlessConfig();
    const { qonto_transaction_id: fieldTxId, qonto_attachment_id: fieldAttId } = config.custom_field_ids;
    if (!fieldTxId || !fieldAttId) {
        configMissingError('custom_field_ids.qonto_transaction_id / qonto_attachment_id');
    }
    log.info(
        `Updating document #${documentId} with Qonto metadata: transaction=${params.transactionId} attachment=${params.attachmentId}`,
    );
    await applyQontoMetadata(documentId, config, params);
    log.info(`Document #${documentId} metadata updated.`);
}

/**
 * Import one Qonto attachment into Paperless: download, upload, wait for task, then set
 * custom fields and tag. Throws if required config IDs are 0 or on download/upload/task failure.
 */
export async function importAttachmentToPaperless(
    params: ImportAttachmentToPaperlessParams,
): Promise<ImportAttachmentToPaperlessResult> {
    const config = params.config ?? loadPaperlessConfig();
    const { qonto_transaction_id: fieldTxId, qonto_attachment_id: fieldAttId } = config.custom_field_ids;
    if (!fieldTxId || !fieldAttId) {
        configMissingError('custom_field_ids.qonto_transaction_id / qonto_attachment_id');
    }

    const { incoming_invoice, outgoing_invoice } = config.document_type_ids;
    if (!incoming_invoice || !outgoing_invoice) {
        configMissingError('document_type_ids.incoming_invoice / outgoing_invoice');
    }

    const documentTypeId = params.side === 'debit' ? incoming_invoice : outgoing_invoice;
    const postTags = config.tag_ids.qonto_import > 0 ? [config.tag_ids.qonto_import] : undefined;

    log.info(`Import started: transaction=${params.transactionId} attachment=${params.attachmentId}`);

    const attachment = await getAttachment(params.attachmentId);
    const buffer = await downloadAttachmentContent(attachment);
    const filename = attachment.file_name ?? 'document.pdf';
    log.info(`Downloaded attachment, file=${filename}`);

    const taskId = await postDocument(buffer, filename, {
        document_type: documentTypeId,
        ...(postTags && { tags: postTags }),
    });
    log.info(`Uploaded to Paperless, task_id=${taskId}`);

    const { documentId, created } = await waitForTaskResult(taskId);
    log.info(`Task done: documentId=${documentId} created=${created}`);

    await applyQontoMetadata(documentId, config, params);
    log.info(`Metadata applied to document #${documentId}`);

    return { documentId, created };
}
