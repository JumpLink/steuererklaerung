/**
 * Extract invoice fields from a Paperless document: FIRST from the file's own structured data set
 * when it is an e-invoice (XRechnung XML, ZUGFeRD/Factur-X PDF — no AI, exact values), and only for
 * everything else from the OCR content via the configured LLM provider (default: Claude Agent SDK
 * on your subscription). The result is saved to Paperless custom fields.
 * Used by paperless extract-invoice-fields-incoming, extract-invoice-fields-outgoing, and review-metadata type handlers.
 */

import {
    listDocuments,
    getDocument,
    updateDocument,
    type Document,
    type UpdateDocumentPayload,
    getCustomFieldValue,
    getStringField,
    isEmptyValue,
    normalizeAmountValue,
    formatMonetaryValue,
    parseMonetaryValue,
    downloadDocument,
} from '@steuererklaerung/paperless';
import { extractPdfText } from '@steuererklaerung/dms';
import {
    eInvoiceToFields,
    readEInvoice,
    type EInvoiceClassification,
    type EInvoiceReading,
} from '../../invoices/e-rechnung/index.ts';
import { getLLMProvider } from '../../clients/llm/index.ts';
import {
    extractJsonCandidate,
    parseJsonLeniently,
    isDateInRangeStrict,
    normalizeDateValue,
    toDateOnly,
} from '@steuererklaerung/shared';
import { DEFAULTS } from '../../constants.ts';
import { getLogger } from '../../lib/logger.ts';
import { fetchAllPages } from '@steuererklaerung/paperless';
import { INVOICE_EXTRACTION_SYSTEM_PROMPT, buildInvoiceExtractionUserPrompt } from '../../lib/prompts.ts';
import {
    SUPPLIER_COUNTRY_OPTIONS,
    ACCOUNTING_CATEGORY_OPTIONS,
    selectLabelToOptionId,
    normalizeTaxRateLabel,
} from '../../lib/select-field-constants.ts';
import type { SyncConfig } from '../../config/index.ts';

const log = getLogger('paperless-extract-invoice');

const THROTTLE_MS = DEFAULTS.API_THROTTLE_MS;

/** Max characters sent to the LLM to avoid context overflow and API max_tokens errors. */
export const MAX_CONTENT_LENGTH = DEFAULTS.LLM_MAX_CONTENT_LENGTH;

/** Extracted fields from LLM (all optional; leave empty if not found). */
export interface ExtractedInvoiceFields {
    invoice_number?: string;
    invoice_date?: string;
    due_date?: string;
    /** ISO 4217 currency code (e.g. EUR, USD) from the invoice. */
    currency?: string;
    total_net?: number;
    total_gross?: number;
    tax_amount?: number;
    /** Tax rate as shown on invoice (e.g. "19%" or "7%"). */
    tax_rate?: string;
    customer_number?: string;
    /** First day of service period (YYYY-MM-DD). */
    service_period_start?: string;
    /** Last day of service period (YYYY-MM-DD). */
    service_period_end?: string;
    /** ISO 3166-1 alpha-2 country code of the supplier/seller (e.g. "DE", "US", "NL"). */
    supplier_country?: string;
    /** Supplier's VAT ID (USt-IdNr.), e.g. "DE123456789" or "FR12345678901". */
    supplier_vat_id?: string;
    /** Whether the invoice uses Reverse Charge (Steuerschuldnerschaft des Leistungsempfängers). */
    reverse_charge?: boolean;
    /** Type of supply: "GOODS" or "SERVICES". */
    sale_type?: string;
    /** SKR03-nahe Buchungskategorie (e.g. "4964 Software/Lizenzen"). */
    accounting_category?: string;
}

/** Where the fields of one extraction came from. */
/** `nur-einstufung`: no field was filled, only the classification was recorded. */
export type InvoiceExtractionSource = 'e-rechnung' | 'ai' | 'nur-einstufung';

/** Options of {@link runInvoiceExtractionForDocument}; all optional. */
export interface InvoiceExtractionOptions {
    /** The original file when the caller already holds it (import); else it is downloaded. */
    original?: Uint8Array | null;
    /** Override how the original is fetched (tests). */
    fetchOriginal?: (documentId: number) => Promise<Uint8Array>;
    /** False = never call the AI; only an e-invoice data set may fill the fields. Default true. */
    aiAllowed?: boolean;
}

export interface ExtractInvoiceFieldsProcessedInfo {
    documentId: number;
    title: string | null;
    fileName: string | null;
    extracted: ExtractedInvoiceFields;
    updated: boolean;
}

export interface ExtractInvoiceFieldsOptions {
    /** When true, skip documents that already have Rechnungsnummer set. */
    onlyMissing?: boolean;
    dryRun?: boolean;
    /** When set, only process documents whose relevant date (invoice_date or qonto_settled_at) falls in [from, to] (YYYY-MM-DD). */
    from?: string;
    to?: string;
    /** When set, called after each processed document (interactive mode). */
    onDocumentProcessed?: (info: ExtractInvoiceFieldsProcessedInfo) => Promise<void>;
}

export interface ExtractInvoiceFieldsResult {
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
}

export type InvoiceDocumentTypeKey = 'incoming_invoice' | 'outgoing_invoice';

/** Optional Qonto transaction context to help the LLM cross-check extracted values. */
export interface QontoExtractionContext {
    amount: number;
    currency: string;
    label?: string;
    reference?: string | null;
    settledAt?: string;
    /** Qonto transaction category (hint for accounting_category). */
    category?: string;
}

/**
 * Extract invoice fields from OCR content via LLM.
 * Optionally pass Qonto transaction context for cross-checking.
 * @throws on LLM transport error or unparseable JSON
 */
export async function extractInvoiceFieldsFromContent(
    content: string,
    _direction: InvoiceDocumentTypeKey,
    qontoContext?: QontoExtractionContext,
): Promise<ExtractedInvoiceFields> {
    const provider = getLLMProvider();
    const contentForLlm = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;
    const userPrompt = buildInvoiceExtractionUserPrompt(contentForLlm, qontoContext);
    const raw = (
        await provider.complete({
            system: INVOICE_EXTRACTION_SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 1024,
        })
    ).text;
    const parsed = parseJsonLeniently(extractJsonCandidate(raw) ?? raw);
    if (parsed == null || typeof parsed !== 'object') {
        throw new Error('LLM returned no parseable JSON for invoice extraction');
    }
    return parsed as ExtractedInvoiceFields;
}

/**
 * Build custom field entries from extracted invoice fields and config.
 */
export function buildInvoiceCustomFieldsPayload(
    config: SyncConfig,
    extracted: ExtractedInvoiceFields,
): Array<{ field: number; value: unknown }> {
    const cf = config.custom_field_ids;
    const customFields: Array<{ field: number; value: unknown }> = [];
    if (cf.invoice_number > 0 && !isEmptyValue(extracted.invoice_number)) {
        customFields.push({ field: cf.invoice_number, value: String(extracted.invoice_number).trim() });
    }
    if (cf.invoice_date > 0) {
        const d = toDateOnly(extracted.invoice_date ?? null);
        if (d) customFields.push({ field: cf.invoice_date, value: d });
    }
    if (cf.due_date > 0) {
        const d = toDateOnly(extracted.due_date ?? null);
        if (d) customFields.push({ field: cf.due_date, value: d });
    }
    // Determine invoice currency (default EUR if not extracted)
    const invoiceCurrency =
        !isEmptyValue(extracted.currency) && String(extracted.currency).trim().length === 3
            ? String(extracted.currency).trim().toUpperCase()
            : 'EUR';

    // Write monetary fields with currency prefix (e.g. "USD57.60") so Paperless
    // displays the correct currency. The separate invoice_currency field is no longer needed.
    if (cf.total_net > 0 && typeof extracted.total_net === 'number' && !Number.isNaN(extracted.total_net)) {
        customFields.push({ field: cf.total_net, value: formatMonetaryValue(extracted.total_net, invoiceCurrency) });
    }
    if (cf.total_gross > 0 && typeof extracted.total_gross === 'number' && !Number.isNaN(extracted.total_gross)) {
        customFields.push({
            field: cf.total_gross,
            value: formatMonetaryValue(extracted.total_gross, invoiceCurrency),
        });
    }
    if (cf.tax_amount > 0 && typeof extracted.tax_amount === 'number' && !Number.isNaN(extracted.tax_amount)) {
        customFields.push({ field: cf.tax_amount, value: formatMonetaryValue(extracted.tax_amount, invoiceCurrency) });
    }
    // Legacy: still write invoice_currency if configured (for backward compat), but prefer embedded currency above
    if (cf.invoice_currency > 0 && invoiceCurrency) {
        customFields.push({ field: cf.invoice_currency, value: invoiceCurrency });
    }
    if (cf.tax_rate > 0 && !isEmptyValue(extracted.tax_rate)) {
        const taxLabel = normalizeTaxRateLabel(extracted.tax_rate);
        if (taxLabel) {
            const optId = selectLabelToOptionId(config.select_field_options?.tax_rate, taxLabel);
            customFields.push({ field: cf.tax_rate, value: optId ?? taxLabel });
        }
    }
    if (cf.customer_number > 0 && !isEmptyValue(extracted.customer_number)) {
        customFields.push({ field: cf.customer_number, value: String(extracted.customer_number).trim() });
    }
    // service_period as two explicit date fields (start/end)
    if (cf.service_period_start > 0 && extracted.service_period_start) {
        const d = toDateOnly(extracted.service_period_start);
        if (d) customFields.push({ field: cf.service_period_start, value: d });
    }
    if (cf.service_period_end > 0 && extracted.service_period_end) {
        const d = toDateOnly(extracted.service_period_end);
        if (d) customFields.push({ field: cf.service_period_end, value: d });
    }
    if (cf.supplier_country > 0 && !isEmptyValue(extracted.supplier_country)) {
        const countryCode = String(extracted.supplier_country).trim().toUpperCase();
        if (SUPPLIER_COUNTRY_OPTIONS.includes(countryCode as (typeof SUPPLIER_COUNTRY_OPTIONS)[number])) {
            const optId = selectLabelToOptionId(config.select_field_options?.supplier_country, countryCode);
            customFields.push({ field: cf.supplier_country, value: optId ?? countryCode });
        } else {
            // Unknown country code — store as-is (backward compat, migration will handle)
            customFields.push({ field: cf.supplier_country, value: countryCode });
        }
    }
    if (cf.supplier_vat_id > 0 && !isEmptyValue(extracted.supplier_vat_id)) {
        customFields.push({ field: cf.supplier_vat_id, value: String(extracted.supplier_vat_id).trim() });
    }
    if (cf.reverse_charge > 0 && extracted.reverse_charge != null) {
        customFields.push({ field: cf.reverse_charge, value: extracted.reverse_charge });
    }
    if (cf.sale_type > 0 && !isEmptyValue(extracted.sale_type)) {
        const st = String(extracted.sale_type).trim().toUpperCase();
        if (st === 'GOODS' || st === 'SERVICES') {
            const optId = selectLabelToOptionId(config.select_field_options?.sale_type, st);
            customFields.push({ field: cf.sale_type, value: optId ?? st });
        }
    }
    if (cf.accounting_category > 0 && !isEmptyValue(extracted.accounting_category)) {
        const cat = String(extracted.accounting_category).trim();
        if ((ACCOUNTING_CATEGORY_OPTIONS as readonly string[]).includes(cat)) {
            const optId = selectLabelToOptionId(config.select_field_options?.accounting_category, cat);
            customFields.push({ field: cf.accounting_category, value: optId ?? cat });
        }
    }
    return customFields;
}

/**
 * Build Qonto context from a document's custom fields (if available).
 * Used to help the LLM cross-check its extraction against the bank transaction.
 */
function buildQontoContextFromDoc(doc: Document, config: SyncConfig): QontoExtractionContext | undefined {
    const cf = config.custom_field_ids;
    const txAmount =
        cf.qonto_transaction_amount > 0
            ? normalizeAmountValue(getCustomFieldValue(doc, cf.qonto_transaction_amount))
            : null;
    const txCurrency = cf.qonto_currency > 0 ? getStringField(doc, cf.qonto_currency) : '';
    const settledAt =
        cf.qonto_settled_at > 0 ? normalizeDateValue(getCustomFieldValue(doc, cf.qonto_settled_at)) : null;

    if (txAmount == null) return undefined;

    const label = cf.qonto_label > 0 ? getStringField(doc, cf.qonto_label) || undefined : undefined;
    const reference = cf.qonto_reference > 0 ? getStringField(doc, cf.qonto_reference) || undefined : undefined;

    const category = cf.qonto_category > 0 ? getStringField(doc, cf.qonto_category) || undefined : undefined;

    return {
        amount: Math.abs(txAmount),
        currency: txCurrency || 'EUR',
        label,
        reference,
        settledAt: settledAt ?? undefined,
        category,
    };
}

/** Paperless string fields hold at most 128 characters. */
const KIND_FIELD_MAX = 128;

/** "<kind>|<reason>" — the shape `PaperlessDmsProvider` reads back (packages/dms). */
export function encodeInvoiceKind(c: EInvoiceClassification): string {
    const value = `${c.kind}|${c.reason}`;
    return value.length > KIND_FIELD_MAX ? `${value.slice(0, KIND_FIELD_MAX - 1)}…` : value;
}

/**
 * Read the document's original file as an e-invoice. `null` when the file cannot be fetched — the
 * caller then simply falls back to the AI, exactly as before this reader existed.
 */
async function readOriginal(doc: Document, opts: InvoiceExtractionOptions): Promise<EInvoiceReading | null> {
    const mime = (doc.mime_type ?? '').toLowerCase();
    try {
        // A scan or photo has no data set; no need to download it to find that out.
        if (mime.startsWith('image/')) return readEInvoice(new Uint8Array(0));
        const bytes =
            opts.original ??
            (await (opts.fetchOriginal ?? ((id: number) => downloadDocument(id, { original: true })))(doc.id));
        return readEInvoice(bytes, { pdfText: extractPdfText });
    } catch (e) {
        log.info(`Document ${doc.id}: original not readable as e-invoice (${e instanceof Error ? e.message : e}).`);
        return null;
    }
}

function buildPayload(
    doc: Document,
    config: SyncConfig,
    customFields: Array<{ field: number; value: unknown }>,
    aiReviewed: boolean,
): Partial<UpdateDocumentPayload> {
    const extractionFieldIds = new Set(customFields.map((c) => c.field));
    const existing = (doc.custom_fields ?? []).filter((c) => !extractionFieldIds.has(c.field));
    const payload: Partial<UpdateDocumentPayload> = { custom_fields: [...existing, ...customFields] };
    const kiTagId = config.tag_ids.ai_reviewed;
    // The KI tag means "an AI looked at this" — an e-invoice read from its own data set never gets it.
    if (aiReviewed && kiTagId > 0) {
        const existingTagIds = doc.tags ?? [];
        payload.tags = existingTagIds.includes(kiTagId) ? existingTagIds : [...existingTagIds, kiTagId];
    }
    return payload;
}

/**
 * Run invoice extraction for a single document. Returns payload (custom_fields + tags) to apply, or null if nothing to do.
 * Does not call updateDocument; caller merges with other updates and writes once.
 *
 * Order: (1) the original file as e-invoice — no AI call; (2) the AI on the OCR text, unless
 * `aiAllowed` is false. The §14 classification (E-Rechnung / sonstige Rechnung) is recorded on
 * either path when the `invoice_kind` field is configured.
 */
export async function runInvoiceExtractionForDocument(
    doc: Document,
    config: SyncConfig,
    direction: InvoiceDocumentTypeKey,
    opts: InvoiceExtractionOptions = {},
): Promise<{
    payload: Partial<UpdateDocumentPayload>;
    extracted: ExtractedInvoiceFields;
    source: InvoiceExtractionSource;
    classification: EInvoiceClassification | null;
} | null> {
    const reading = await readOriginal(doc, opts);
    const classification = reading?.classification ?? null;
    const kindFieldId = config.custom_field_ids.invoice_kind ?? 0;
    const kindField = (): Array<{ field: number; value: unknown }> =>
        classification && kindFieldId > 0 ? [{ field: kindFieldId, value: encodeInvoiceKind(classification) }] : [];

    if (reading?.invoice) {
        const extracted: ExtractedInvoiceFields = eInvoiceToFields(reading.invoice);
        const customFields = [...buildInvoiceCustomFieldsPayload(config, extracted), ...kindField()];
        if (customFields.length === 0) return null;
        return {
            payload: buildPayload(doc, config, customFields, false),
            extracted,
            source: 'e-rechnung',
            classification,
        };
    }

    if (opts.aiAllowed === false) {
        const customFields = kindField();
        if (customFields.length === 0) return null;
        return {
            payload: buildPayload(doc, config, customFields, false),
            extracted: {},
            source: 'nur-einstufung',
            classification,
        };
    }

    const content = doc.content?.trim();
    if (!content) return null;

    const qontoContext = buildQontoContextFromDoc(doc, config);
    const extracted = await extractInvoiceFieldsFromContent(content, direction, qontoContext);
    const customFields = [...buildInvoiceCustomFieldsPayload(config, extracted), ...kindField()];
    if (customFields.length === 0) return null;
    return { payload: buildPayload(doc, config, customFields, true), extracted, source: 'ai', classification };
}

/**
 * List all document IDs for the given document type (paginated).
 */
async function listAllDocumentIds(documentTypeId: number): Promise<number[]> {
    const docs = await fetchAllPages((page, pageSize) =>
        listDocuments({ document_type_id: documentTypeId, page_size: pageSize, page }),
    );
    return docs.map((doc) => doc.id);
}

/**
 * List document IDs whose relevant date falls in [dateFrom, dateTo].
 * Incoming: invoice_date or qonto_settled_at in range; outgoing: qonto_settled_at in range.
 */
async function listDocumentIdsInDateRange(
    config: SyncConfig,
    documentTypeId: number,
    dateFrom: string,
    dateTo: string,
    direction: InvoiceDocumentTypeKey,
): Promise<number[]> {
    const cf = config.custom_field_ids;
    const ids: number[] = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
        const res = await listDocuments({
            document_type_id: documentTypeId,
            page_size: pageSize,
            page,
        });
        const docs = res.results ?? [];
        for (const doc of docs) {
            const settledAt = normalizeDateValue(getCustomFieldValue(doc, cf.qonto_settled_at));
            const invoiceDate = normalizeDateValue(getCustomFieldValue(doc, cf.invoice_date));
            const dateToUse = direction === 'outgoing_invoice' ? settledAt : (settledAt ?? invoiceDate);
            if (dateToUse && isDateInRangeStrict(dateToUse, dateFrom, dateTo)) {
                ids.push(doc.id);
            }
        }
        if (docs.length < pageSize) break;
        page += 1;
    }
    return ids;
}

/**
 * Extract invoice fields from documents of the given type. Optionally only process documents
 * that don't have invoice_number set yet. Optionally dry-run (no updates).
 */
export async function extractInvoiceFields(
    config: SyncConfig,
    documentTypeId: number,
    options: ExtractInvoiceFieldsOptions = {},
): Promise<ExtractInvoiceFieldsResult> {
    const direction: InvoiceDocumentTypeKey =
        documentTypeId === config.document_type_ids.incoming_invoice ? 'incoming_invoice' : 'outgoing_invoice';

    const ids =
        options.from != null && options.to != null
            ? await listDocumentIdsInDateRange(config, documentTypeId, options.from, options.to, direction)
            : await listAllDocumentIds(documentTypeId);
    const result: ExtractInvoiceFieldsResult = { processed: 0, updated: 0, skipped: 0, errors: 0 };
    const cf = config.custom_field_ids;
    const invoiceNumberFieldId = cf.invoice_number;

    /** In onlyMissing mode: skip only when all key fields are already set.
     *  Checks: invoice_number present, at least one amount present, and that amount includes an embedded currency. */
    function hasAllKeyExtractionFields(doc: Document): boolean {
        if (invoiceNumberFieldId <= 0) return false;
        const invoiceNumber = getCustomFieldValue(doc, invoiceNumberFieldId);
        if (isEmptyValue(invoiceNumber)) return false;

        // Check that at least one monetary amount has an embedded currency (e.g. "USD57.60")
        const grossVal = cf.total_gross > 0 ? getCustomFieldValue(doc, cf.total_gross) : undefined;
        const netVal = cf.total_net > 0 ? getCustomFieldValue(doc, cf.total_net) : undefined;
        const grossParsed = parseMonetaryValue(grossVal);
        const netParsed = parseMonetaryValue(netVal);

        // Need at least one amount set
        if (!grossParsed && !netParsed) return false;

        // Check that the amount carries an explicit currency prefix (not just a bare number).
        // Bare numbers (legacy) have no currency info embedded and should be re-extracted.
        const hasEmbeddedCurrency =
            (typeof grossVal === 'string' && /^[A-Z]{3}/.test(grossVal.trim())) ||
            (typeof netVal === 'string' && /^[A-Z]{3}/.test(netVal.trim()));
        if (!hasEmbeddedCurrency) return false;

        // Check that supplier_country is set (new field — re-extract if missing)
        if (cf.supplier_country > 0) {
            const supplierCountry = getCustomFieldValue(doc, cf.supplier_country);
            if (isEmptyValue(supplierCountry)) return false;
        }

        return true;
    }

    for (const id of ids) {
        let doc: Document;
        try {
            doc = await getDocument(id);
        } catch (e) {
            log.error(`Failed to get document ${id}: ${e instanceof Error ? e.message : e}`);
            result.errors += 1;
            continue;
        }

        if (doc.document_type !== documentTypeId) {
            result.skipped += 1;
            continue;
        }

        if (options.onlyMissing && hasAllKeyExtractionFields(doc)) {
            result.skipped += 1;
            continue;
        }

        // No OCR content is no reason to skip: an e-invoice is read from the file, not from the text.
        const content = doc.content?.trim() ?? '';
        if (content.length > MAX_CONTENT_LENGTH) {
            log.info(`Document ${id}: OCR truncated from ${content.length} to ${MAX_CONTENT_LENGTH} chars.`);
        }

        result.processed += 1;

        let runResult: Awaited<ReturnType<typeof runInvoiceExtractionForDocument>>;
        try {
            runResult = await runInvoiceExtractionForDocument(doc, config, direction);
        } catch (e) {
            log.error(`Extraction failed for document ${id}: ${e instanceof Error ? e.message : e}`);
            result.errors += 1;
            continue;
        }

        if (!runResult) {
            // Nothing readable (no data set, no OCR text): not processed, as before.
            result.processed -= 1;
            result.skipped += 1;
            continue;
        }

        const { payload, extracted } = runResult;

        if (options.dryRun) {
            log.info(`[dry-run] Document ${id}: would set ${payload.custom_fields?.length ?? 0} fields`);
            result.updated += 1;
        } else {
            try {
                await updateDocument(id, payload as UpdateDocumentPayload);
                result.updated += 1;
            } catch (e) {
                log.error(`Failed to update document ${id}: ${e instanceof Error ? e.message : e}`);
                result.errors += 1;
            }
        }

        if (options.onDocumentProcessed) {
            await options.onDocumentProcessed({
                documentId: id,
                title: doc.title ?? null,
                fileName: doc.original_file_name ?? null,
                extracted,
                updated: !options.dryRun,
            });
        }

        if (THROTTLE_MS > 0 && !options.dryRun) {
            await new Promise((r) => setTimeout(r, THROTTLE_MS));
        }
    }

    return result;
}
