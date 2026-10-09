/**
 * Update existing Paperless documents with structured API metadata from an invoice provider.
 * Flow: List provider invoices → find matching Paperless documents → update custom fields → e-invoice data set (no AI),
 * else optional LLM extraction.
 */

import {
    listDocuments,
    getDocument,
    updateDocument,
    bulkEditDocuments,
    type Document,
} from '@steuererklaerung/paperless';
import { getLogger } from '../../lib/logger.ts';
import { runInvoiceExtractionForDocument } from '../paperless/extract-invoice.ts';
import type { SyncConfig } from '../../config/index.ts';
import { loadPaperlessConfig } from '../../config/index.ts';
import type { InvoiceProvider, InvoiceListItem, InvoiceListFilter } from '../../types/invoice-provider.ts';
import { buildCustomFieldsFromApiData } from './import.ts';

const log = getLogger('invoices-update');

export interface UpdateInvoicesOptions {
    filter?: InvoiceListFilter;
    /** Specific provider invoice IDs to update. */
    ids?: string[];
    /** Dry run: list what would be updated without changing anything. */
    dryRun?: boolean;
    /** Skip LLM extraction (API + config metadata and an e-invoice data set are still applied). */
    skipExtraction?: boolean;
    /** Provider key in sync-config invoice_providers (e.g. "inwx"). */
    providerKey?: string;
    /** Override: pass config explicitly instead of loading from file. */
    config?: SyncConfig;
}

export interface UpdateInvoiceDetail {
    /** Provider invoice ID. */
    id: string;
    /** Paperless document ID (if matched). */
    documentId?: number;
    /** Number of custom fields updated from API+config. */
    fieldsUpdated?: number;
    /** Whether LLM extraction was run. */
    extracted?: boolean;
    /** Where the extracted fields came from; "e-rechnung" means no AI call was made. */
    extractedFrom?: 'e-rechnung' | 'ai' | 'nur-einstufung';
    /** True if document was not found in Paperless. */
    notFound?: boolean;
    error?: string;
}

export interface UpdateInvoicesResult {
    source: string;
    updated: number;
    notFound: number;
    skipped: number;
    errors: number;
    details: UpdateInvoiceDetail[];
}

/**
 * Fetch ALL documents for a correspondent from Paperless (paginates automatically).
 */
async function fetchAllDocumentsForCorrespondent(correspondentId: number): Promise<Document[]> {
    const all: Document[] = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
        const result = await listDocuments({
            correspondent_id: correspondentId,
            page_size: pageSize,
            page,
            ordering: 'id',
        });
        all.push(...result.results);
        if (!result.next) break;
        page++;
    }

    return all;
}

/**
 * Build a map from invoice_number custom field value → Document.
 */
function buildInvoiceNumberMap(documents: Document[], invoiceNumberFieldId: number): Map<string, Document> {
    const map = new Map<string, Document>();
    for (const doc of documents) {
        const cf = doc.custom_fields?.find((f) => f.field === invoiceNumberFieldId);
        if (cf?.value != null && String(cf.value).trim()) {
            map.set(String(cf.value).trim(), doc);
        }
    }
    return map;
}

export async function updateProviderInvoices(
    provider: InvoiceProvider,
    options: UpdateInvoicesOptions = {},
): Promise<UpdateInvoicesResult> {
    const syncConfig = options.config ?? loadPaperlessConfig();
    const providerKey = options.providerKey ?? provider.name.toLowerCase();
    const providerConfig = syncConfig.invoice_providers[providerKey];
    const defaults = providerConfig?.defaults ?? {};
    const correspondentId = providerConfig?.correspondent_id;

    if (!correspondentId || correspondentId <= 0) {
        throw new Error(`No correspondent_id configured for provider "${providerKey}" in sync-config.json`);
    }

    // 1. List provider invoices (with filter)
    let invoices: InvoiceListItem[];
    if (options.ids && options.ids.length > 0) {
        await provider.listInvoices(); // cache metadata
        invoices = (await provider.listInvoices()).filter((inv) => options.ids!.includes(inv.id));
    } else {
        invoices = await provider.listInvoices(options.filter);
    }

    log.info(`Found ${invoices.length} invoices from ${provider.name} API`);

    // 2. Fetch all Paperless documents for this correspondent
    const paperlessDocs = await fetchAllDocumentsForCorrespondent(correspondentId);
    log.info(`Found ${paperlessDocs.length} documents in Paperless for correspondent #${correspondentId}`);

    // 3. Build lookup map: invoice_number → Document
    const invoiceNumberFieldId = syncConfig.custom_field_ids.invoice_number;
    const docMap = buildInvoiceNumberMap(paperlessDocs, invoiceNumberFieldId);
    log.info(`${docMap.size} documents have invoice_number field set`);

    const details: UpdateInvoiceDetail[] = [];
    let updated = 0;
    let notFound = 0;
    let skipped = 0;
    let errors = 0;

    for (const invoice of invoices) {
        const detail: UpdateInvoiceDetail = { id: invoice.id };

        // Match by invoice_number
        const doc = docMap.get(invoice.id);
        if (!doc) {
            detail.notFound = true;
            notFound++;
            log.info(`Invoice ${invoice.id} (${invoice.date}) – no matching document in Paperless`);
            details.push(detail);
            continue;
        }

        detail.documentId = doc.id;

        if (options.dryRun) {
            skipped++;
            log.info(`[dry-run] Would update document #${doc.id} with invoice ${invoice.id}`);
            details.push(detail);
            continue;
        }

        try {
            // 4. Update API+config custom fields
            const apiFields = buildCustomFieldsFromApiData(
                invoice,
                defaults,
                syncConfig.custom_field_ids,
                syncConfig.select_field_options,
            );
            const apiFieldIds = new Set(Object.keys(apiFields).map(Number));
            const fieldCount = Object.keys(apiFields).length;

            if (fieldCount > 0) {
                await bulkEditDocuments([doc.id], 'modify_custom_fields', {
                    add_custom_fields: apiFields,
                    remove_custom_fields: [],
                });
                detail.fieldsUpdated = fieldCount;
                log.info(`Updated ${fieldCount} custom fields on document #${doc.id} (invoice ${invoice.id})`);
            }

            // 5. Remaining fields: the e-invoice data set when the file has one (no AI), else the
            // LLM on the OCR text — unless extraction was switched off.
            try {
                const freshDoc = await getDocument(doc.id);
                const extraction = await runInvoiceExtractionForDocument(freshDoc, syncConfig, 'incoming_invoice', {
                    aiAllowed: !options.skipExtraction,
                });
                if (extraction && extraction.payload.custom_fields) {
                    // Preserve API-sourced field values: API data is authoritative, extraction should not overwrite it.
                    extraction.payload.custom_fields = extraction.payload.custom_fields.map((cf) => {
                        if (apiFieldIds.has(cf.field)) {
                            const docCf = freshDoc.custom_fields?.find((e) => e.field === cf.field);
                            return docCf ?? cf;
                        }
                        return cf;
                    });
                    await updateDocument(doc.id, extraction.payload);
                    detail.extracted = extraction.source !== 'nur-einstufung';
                    detail.extractedFrom = extraction.source;
                    log.info(`Extraction (${extraction.source}) completed for document #${doc.id}`);
                } else if (!options.skipExtraction && !freshDoc.content?.trim()) {
                    log.info(`Document #${doc.id} has no OCR content, skipping LLM extraction`);
                }
            } catch (extractErr) {
                log.error(
                    `Extraction failed for document #${doc.id}: ${extractErr instanceof Error ? extractErr.message : extractErr}`,
                );
            }

            updated++;
            details.push(detail);
        } catch (err) {
            errors++;
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Failed to update document #${doc.id} (invoice ${invoice.id}): ${msg}`);
            detail.error = msg;
            details.push(detail);
        }
    }

    return { source: provider.name, updated, notFound, skipped, errors, details };
}
