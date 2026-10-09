/**
 * Import invoices from a provider into Paperless-NGX.
 * Flow: Download PDF → upload to Paperless → set structured metadata → e-invoice data set (no AI),
 * else optional LLM extraction.
 */

import {
    postDocument,
    getDocument,
    updateDocument,
    bulkEditDocuments,
    waitForTaskResult,
    type PostDocumentOptions,
    type UpdateDocumentPayload,
    formatMonetaryValue,
} from '@steuererklaerung/paperless';
import { getLogger } from '../../lib/logger.ts';
import { toDateOnly } from '@steuererklaerung/shared';
import { selectLabelToOptionId } from '../../lib/select-field-constants.ts';
import { runInvoiceExtractionForDocument } from '../paperless/extract-invoice.ts';
import type { SyncConfig } from '../../config/index.ts';
import { loadPaperlessConfig } from '../../config/index.ts';
import type { InvoiceProvider, InvoiceListItem, InvoiceListFilter } from '../../types/invoice-provider.ts';

const log = getLogger('invoices-import');

export interface ImportInvoicesOptions {
    filter?: InvoiceListFilter;
    /** Specific invoice IDs to import (skip listing if provided). */
    ids?: string[];
    /** Dry run: list what would be imported without uploading. */
    dryRun?: boolean;
    /** Skip LLM extraction (API + config metadata and an e-invoice data set are still applied). */
    skipExtraction?: boolean;
    /** Provider key in sync-config invoice_providers (e.g. "inwx"). */
    providerKey?: string;
    /** Override: pass config explicitly instead of loading from file. */
    config?: SyncConfig;
}

export interface ImportInvoiceDetail {
    id: string;
    filename: string;
    documentId?: number;
    created?: boolean;
    fieldsSet?: number;
    extracted?: boolean;
    /** Where the extracted fields came from; "e-rechnung" means no AI call was made. */
    extractedFrom?: 'e-rechnung' | 'ai' | 'nur-einstufung';
    error?: string;
}

export interface ImportInvoicesResult {
    source: string;
    imported: number;
    duplicates: number;
    errors: number;
    skipped: number;
    details: ImportInvoiceDetail[];
}

/**
 * Build a custom fields map from API metadata + provider config defaults.
 * Returns a Record<fieldId, value> for use with bulkEditDocuments add_custom_fields.
 */
export function buildCustomFieldsFromApiData(
    metadata: InvoiceListItem,
    defaults: SyncConfig['invoice_providers'][string]['defaults'],
    cf: SyncConfig['custom_field_ids'],
    selectOptions?: SyncConfig['select_field_options'],
): Record<number, unknown> {
    const fields: Record<number, unknown> = {};
    const currency = defaults.currency ?? metadata.currency ?? 'EUR';

    if (cf.invoice_number > 0 && metadata.id) {
        fields[cf.invoice_number] = metadata.id;
    }
    if (cf.invoice_date > 0 && metadata.date) {
        const d = toDateOnly(metadata.date);
        if (d) fields[cf.invoice_date] = d;
    }
    if (cf.total_net > 0 && metadata.amountNet != null) {
        fields[cf.total_net] = formatMonetaryValue(metadata.amountNet, currency);
    }
    if (cf.total_gross > 0 && metadata.amountGross != null) {
        fields[cf.total_gross] = formatMonetaryValue(metadata.amountGross, currency);
    }

    // Calculated fields
    const taxAmount = metadata.amountGross - metadata.amountNet;
    if (cf.tax_amount > 0 && taxAmount > 0) {
        fields[cf.tax_amount] = formatMonetaryValue(taxAmount, currency);
    }
    if (cf.tax_rate > 0 && metadata.amountNet > 0 && taxAmount > 0) {
        const rate = Math.round((taxAmount / metadata.amountNet) * 100);
        const rateLabel = `${rate}%`;
        const optId = selectLabelToOptionId(selectOptions?.tax_rate, rateLabel);
        fields[cf.tax_rate] = optId ?? rateLabel;
    }

    // Currency
    if (cf.invoice_currency > 0) {
        fields[cf.invoice_currency] = currency;
    }

    // Static defaults from provider config
    if (cf.supplier_country > 0 && defaults.supplier_country) {
        const optId = selectLabelToOptionId(selectOptions?.supplier_country, defaults.supplier_country);
        fields[cf.supplier_country] = optId ?? defaults.supplier_country;
    }
    if (cf.supplier_vat_id > 0 && defaults.supplier_vat_id) {
        fields[cf.supplier_vat_id] = defaults.supplier_vat_id;
    }
    if (cf.reverse_charge > 0 && defaults.reverse_charge != null) {
        fields[cf.reverse_charge] = defaults.reverse_charge;
    }
    if (cf.sale_type > 0 && defaults.sale_type) {
        const optId = selectLabelToOptionId(selectOptions?.sale_type, defaults.sale_type);
        fields[cf.sale_type] = optId ?? defaults.sale_type;
    }

    return fields;
}

export async function importProviderInvoices(
    provider: InvoiceProvider,
    options: ImportInvoicesOptions = {},
): Promise<ImportInvoicesResult> {
    const syncConfig = options.config ?? loadPaperlessConfig();
    const providerKey = options.providerKey ?? provider.name.toLowerCase();
    const providerConfig = syncConfig.invoice_providers[providerKey];
    const defaults = providerConfig?.defaults ?? {};

    // Resolve document type: provider config → sync-config incoming_invoice
    const documentTypeId =
        (providerConfig?.document_type_id || 0) > 0
            ? providerConfig!.document_type_id
            : syncConfig.document_type_ids.incoming_invoice;

    const correspondentId = providerConfig?.correspondent_id || undefined;
    const tagIds = providerConfig?.tag_ids ?? [];

    // Determine which invoices to import
    let ids: string[];
    if (options.ids && options.ids.length > 0) {
        // Ensure provider has metadata cached by listing first
        await provider.listInvoices();
        ids = options.ids;
    } else {
        const invoices = await provider.listInvoices(options.filter);
        ids = invoices.map((inv) => inv.id);
    }

    const details: ImportInvoiceDetail[] = [];
    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    let skipped = 0;

    for (const id of ids) {
        if (options.dryRun) {
            details.push({ id, filename: `${provider.name.toLowerCase()}-invoice-${id}.pdf` });
            skipped++;
            continue;
        }

        try {
            // 1. Download PDF
            const result = await provider.downloadInvoice(id);
            log.info(`Downloaded ${result.filename} (${result.pdf.length} bytes)`);

            // 2. Upload to Paperless
            const postOpts: PostDocumentOptions = {};
            if (documentTypeId > 0) postOpts.document_type = documentTypeId;
            if (correspondentId && correspondentId > 0) postOpts.correspondent = correspondentId;
            if (tagIds.length > 0) postOpts.tags = tagIds;

            const taskId = await postDocument(result.pdf, result.filename, postOpts);
            log.info(`Upload task: ${taskId}`);

            const outcome = await waitForTaskResult(taskId);
            log.info(`Task done: documentId=${outcome.documentId} created=${outcome.created}`);

            const detail: ImportInvoiceDetail = {
                id,
                filename: result.filename,
                documentId: outcome.documentId,
                created: outcome.created,
            };

            if (outcome.created) {
                imported++;
            } else {
                duplicates++;
                // 2b. For duplicates: update document_type, correspondent, merge tags
                try {
                    const existingDoc = await getDocument(outcome.documentId);
                    const metaUpdates: Partial<UpdateDocumentPayload> = {};
                    if (documentTypeId > 0 && existingDoc.document_type !== documentTypeId) {
                        metaUpdates.document_type = documentTypeId;
                    }
                    if (correspondentId && correspondentId > 0 && existingDoc.correspondent !== correspondentId) {
                        metaUpdates.correspondent = correspondentId;
                    }
                    if (tagIds.length > 0) {
                        const existingTags = existingDoc.tags ?? [];
                        const mergedTags = [...new Set([...existingTags, ...tagIds])];
                        if (mergedTags.length !== existingTags.length) {
                            metaUpdates.tags = mergedTags;
                        }
                    }
                    if (Object.keys(metaUpdates).length > 0) {
                        await updateDocument(outcome.documentId, metaUpdates);
                        log.info(
                            `Updated metadata (type/correspondent/tags) on duplicate document #${outcome.documentId}`,
                        );
                    }
                } catch (metaErr) {
                    log.error(
                        `Failed to update metadata on duplicate #${outcome.documentId}: ${metaErr instanceof Error ? metaErr.message : metaErr}`,
                    );
                }
            }

            // 3. Set structured metadata from API + config
            const apiFields = buildCustomFieldsFromApiData(
                result.metadata,
                defaults,
                syncConfig.custom_field_ids,
                syncConfig.select_field_options,
            );
            const apiFieldIds = new Set(Object.keys(apiFields).map(Number));
            const fieldCount = Object.keys(apiFields).length;
            if (fieldCount > 0) {
                await bulkEditDocuments([outcome.documentId], 'modify_custom_fields', {
                    add_custom_fields: apiFields,
                    remove_custom_fields: [],
                });
                detail.fieldsSet = fieldCount;
                log.info(`Set ${fieldCount} custom fields from API+config on document #${outcome.documentId}`);
            }

            // 4. Remaining fields: from the file's own e-invoice data set when it has one (no AI),
            // otherwise from the OCR text via the LLM — unless extraction was switched off.
            try {
                const doc = await getDocument(outcome.documentId);
                const extraction = await runInvoiceExtractionForDocument(doc, syncConfig, 'incoming_invoice', {
                    original: result.pdf,
                    aiAllowed: !options.skipExtraction,
                });
                if (extraction && extraction.payload.custom_fields) {
                    // Preserve API-sourced field values: API data is authoritative, extraction should not overwrite it.
                    extraction.payload.custom_fields = extraction.payload.custom_fields.map((cf) => {
                        if (apiFieldIds.has(cf.field)) {
                            const docCf = doc.custom_fields?.find((e) => e.field === cf.field);
                            return docCf ?? cf;
                        }
                        return cf;
                    });
                    await updateDocument(outcome.documentId, extraction.payload);
                    detail.extracted = extraction.source !== 'nur-einstufung';
                    detail.extractedFrom = extraction.source;
                    log.info(`Extraction (${extraction.source}) completed for document #${outcome.documentId}`);
                } else if (!options.skipExtraction && !doc.content?.trim()) {
                    log.info(`Document #${outcome.documentId} has no OCR content yet, skipping LLM extraction`);
                }
            } catch (extractErr) {
                log.error(
                    `Extraction failed for document #${outcome.documentId}: ${extractErr instanceof Error ? extractErr.message : extractErr}`,
                );
                // Non-fatal: metadata from API is already set
            }

            details.push(detail);
        } catch (err) {
            errors++;
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Failed to import invoice ${id}: ${msg}`);
            details.push({ id, filename: `${provider.name.toLowerCase()}-invoice-${id}.pdf`, error: msg });
        }
    }

    return { source: provider.name, imported, duplicates, errors, skipped, details };
}
