/**
 * MCP-specific types and helpers.
 * Translates Paperless custom field arrays into named properties for LLM consumption.
 */

import type { SyncConfig } from '../../core/config/index.ts';
import {
    type DocumentWithCustomFields,
    type MonetaryValue,
    getCustomFieldValue,
    parseMonetaryValue,
    isEmptyValue,
} from '@steuererklaerung/paperless';
import {
    getSelectFieldLabel,
    selectLabelToOptionId,
    SALE_TYPE_OPTIONS,
    TAX_RATE_OPTIONS,
    SUPPLIER_COUNTRY_OPTIONS,
    ACCOUNTING_CATEGORY_OPTIONS,
    PAYMENT_STATUS_OPTIONS,
    AI_CONFIDENCE_OPTIONS,
    DATA_SCOPE_OPTIONS,
    normalizeTaxRateLabel,
} from '../../core/lib/select-field-constants.ts';

/** Parsed document custom fields with friendly names instead of opaque IDs. */
export interface ParsedCustomFields {
    // Qonto fields
    qonto_transaction_id: string | null;
    qonto_attachment_id: string | null;
    qonto_transaction_amount: MonetaryValue | null;
    qonto_settled_at: string | null;
    qonto_currency: string | null;
    qonto_label: string | null;
    qonto_reference: string | null;
    qonto_vat_amount: MonetaryValue | null;

    // Invoice fields
    invoice_currency: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    total_net: MonetaryValue | null;
    total_gross: MonetaryValue | null;
    tax_amount: MonetaryValue | null;
    tax_rate: string | null;
    customer_number: string | null;
    service_period_start: string | null;
    service_period_end: string | null;
    supplier_country: string | null;
    supplier_vat_id: string | null;
    reverse_charge: boolean | null;
    sale_type: string | null;

    // Category fields
    qonto_category: string | null;
    accounting_category: string | null;

    // Document relationships + AI/document-workflow fields
    cancelled_by: number[] | null;
    cancels: number[] | null;
    related_documents: number[] | null;
    payment_status: string | null;
    amount_to_pay: MonetaryValue | null;
    ai_note: string | null;
    ai_confidence: string | null;
    ai_reviewed_at: string | null;
    data_scope: string | null;
}

/**
 * Parse all custom fields from a Paperless document into named properties.
 * Uses SyncConfig field ID mappings to resolve opaque IDs.
 */
export function parseDocumentCustomFields(doc: DocumentWithCustomFields, config: SyncConfig): ParsedCustomFields {
    const cf = config.custom_field_ids;

    const str = (fieldId: number): string | null => {
        const v = getCustomFieldValue(doc, fieldId);
        if (isEmptyValue(v)) return null;
        return String(v);
    };

    const monetary = (fieldId: number): MonetaryValue | null => {
        return parseMonetaryValue(getCustomFieldValue(doc, fieldId));
    };

    const bool = (fieldId: number): boolean | null => {
        const v = getCustomFieldValue(doc, fieldId);
        if (v == null) return null;
        return Boolean(v);
    };

    // documentlink fields store an array of linked document IDs.
    const links = (fieldId: number): number[] | null => {
        const v = getCustomFieldValue(doc, fieldId);
        if (!Array.isArray(v)) return null;
        const ids = v.filter((x): x is number => typeof x === 'number');
        return ids.length > 0 ? ids : null;
    };

    // Resolve select field option IDs to human-readable labels (fallback to raw value)
    const opts = config.select_field_options;
    const selectLabel = (
        fieldId: number,
        validLabels: readonly string[],
        optionMap: Record<string, string> | undefined,
    ): string | null => {
        const raw = getCustomFieldValue(doc, fieldId);
        if (isEmptyValue(raw)) return null;
        const label = getSelectFieldLabel(validLabels, optionMap, raw);
        return label ?? String(raw);
    };

    return {
        qonto_transaction_id: str(cf.qonto_transaction_id),
        qonto_attachment_id: str(cf.qonto_attachment_id),
        qonto_transaction_amount: monetary(cf.qonto_transaction_amount),
        qonto_settled_at: str(cf.qonto_settled_at),
        qonto_currency: str(cf.qonto_currency),
        qonto_label: str(cf.qonto_label),
        qonto_reference: str(cf.qonto_reference),
        qonto_vat_amount: monetary(cf.qonto_vat_amount),

        invoice_currency: str(cf.invoice_currency),
        invoice_number: str(cf.invoice_number),
        invoice_date: str(cf.invoice_date),
        due_date: str(cf.due_date),
        total_net: monetary(cf.total_net),
        total_gross: monetary(cf.total_gross),
        tax_amount: monetary(cf.tax_amount),
        tax_rate: selectLabel(cf.tax_rate, TAX_RATE_OPTIONS, opts?.tax_rate),
        customer_number: str(cf.customer_number),
        service_period_start: str(cf.service_period_start),
        service_period_end: str(cf.service_period_end),
        supplier_country: selectLabel(cf.supplier_country, SUPPLIER_COUNTRY_OPTIONS, opts?.supplier_country),
        supplier_vat_id: str(cf.supplier_vat_id),
        reverse_charge: bool(cf.reverse_charge),
        sale_type: selectLabel(cf.sale_type, SALE_TYPE_OPTIONS, opts?.sale_type),

        qonto_category: str(cf.qonto_category),
        accounting_category: selectLabel(
            cf.accounting_category,
            ACCOUNTING_CATEGORY_OPTIONS,
            opts?.accounting_category,
        ),

        cancelled_by: links(cf.cancelled_by),
        cancels: links(cf.cancels),
        related_documents: links(cf.related_documents),
        payment_status: selectLabel(cf.payment_status, PAYMENT_STATUS_OPTIONS, opts?.payment_status),
        amount_to_pay: monetary(cf.amount_to_pay),
        ai_note: str(cf.ai_note),
        ai_confidence: selectLabel(cf.ai_confidence, AI_CONFIDENCE_OPTIONS, opts?.ai_confidence),
        ai_reviewed_at: str(cf.ai_reviewed_at),
        data_scope: selectLabel(cf.data_scope, DATA_SCOPE_OPTIONS, opts?.data_scope),
    };
}

/**
 * Resolve friendly custom field names to Paperless field IDs.
 * Accepts a Record<string, unknown> with keys like "invoice_number" and
 * returns an array of { field: number, value: unknown } entries.
 */
export function resolveCustomFieldUpdates(
    fields: Record<string, unknown>,
    config: SyncConfig,
): Array<{ field: number; value: unknown }> {
    const cf = config.custom_field_ids as Record<string, number>;
    const opts = config.select_field_options;

    // Select fields that need label → option ID conversion
    const selectFieldMaps: Record<
        string,
        { labels: readonly string[]; optionMap: Record<string, string> | undefined }
    > = {
        sale_type: { labels: SALE_TYPE_OPTIONS, optionMap: opts?.sale_type },
        tax_rate: { labels: TAX_RATE_OPTIONS, optionMap: opts?.tax_rate },
        supplier_country: { labels: SUPPLIER_COUNTRY_OPTIONS, optionMap: opts?.supplier_country },
        accounting_category: { labels: ACCOUNTING_CATEGORY_OPTIONS, optionMap: opts?.accounting_category },
        payment_status: { labels: PAYMENT_STATUS_OPTIONS, optionMap: opts?.payment_status },
        ai_confidence: { labels: AI_CONFIDENCE_OPTIONS, optionMap: opts?.ai_confidence },
        data_scope: { labels: DATA_SCOPE_OPTIONS, optionMap: opts?.data_scope },
    };

    const entries: Array<{ field: number; value: unknown }> = [];
    for (const [key, value] of Object.entries(fields)) {
        const fieldId = cf[key];
        if (!fieldId || fieldId <= 0) continue;

        // For select fields: convert label to Paperless option ID
        const selectInfo = selectFieldMaps[key];
        if (selectInfo && typeof value === 'string') {
            let resolvedValue: unknown = value;
            // Normalize tax_rate labels ("19%" format)
            const label = key === 'tax_rate' ? (normalizeTaxRateLabel(value) ?? value) : value;
            if ((selectInfo.labels as readonly string[]).includes(label)) {
                const optId = selectLabelToOptionId(selectInfo.optionMap, label);
                // Paperless expects numeric index for index-based select fields
                resolvedValue = optId != null && /^\d+$/.test(optId) ? Number(optId) : (optId ?? label);
            }
            entries.push({ field: fieldId, value: resolvedValue });
        } else {
            entries.push({ field: fieldId, value });
        }
    }
    return entries;
}

/** Standard MCP tool error response. */
export function mcpError(message: string) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}

/** MCP tool error response built from a caught value (the common catch handler). */
export function mcpErrorFrom(err: unknown) {
    return mcpError(err instanceof Error ? err.message : String(err));
}

/** Standard MCP tool success response. */
export function mcpSuccess(data: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
}
