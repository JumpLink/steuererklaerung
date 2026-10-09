/**
 * Resolve friendly custom-field names (e.g. "invoice_number", "data_scope") to Paperless
 * custom-field entries `{ field: id, value }`, converting select-field labels to the option IDs
 * the (unversioned) Paperless serializer expects. Core helper shared by the document upload
 * action and the MCP write tools — keep the resolution logic in one place.
 *
 * Non-select values are additionally coerced to the JS type Paperless' API expects for the
 * field's `data_type` (boolean / monetary / integer / float / date / string): the CLI's
 * `--custom-field name=value` parsing always yields strings, and Paperless answers a PATCH that
 * carries `"true"` for a boolean field or `"57.60"` for a monetary field with HTTP 500. See
 * {@link coerceCustomFieldValue}.
 */

import type { SyncConfig } from '../config/schema/paperless.ts';
import { formatMonetaryValue, parseMonetaryValue, type CustomFieldDataType } from '@steuererklaerung/paperless';
import {
    selectLabelToOptionId,
    normalizeTaxRateLabel,
    SALE_TYPE_OPTIONS,
    TAX_RATE_OPTIONS,
    SUPPLIER_COUNTRY_OPTIONS,
    ACCOUNTING_CATEGORY_OPTIONS,
    PAYMENT_STATUS_OPTIONS,
    AI_CONFIDENCE_OPTIONS,
    DATA_SCOPE_OPTIONS,
    canonicalSelectLabel,
} from './select-field-constants.ts';

/**
 * Paperless `data_type` for each friendly custom-field name. Mirrors the field definitions
 * created in `setupPaperlessFields` (core/actions/paperless/setup.ts) — that action is the
 * authoritative source and this map MUST be kept in sync with it: a new custom field created
 * there needs an entry here, otherwise its value is treated as a string and a boolean / monetary
 * / number field will 500 on write. `select` fields are intentionally omitted — they are resolved
 * to option IDs in the select branch below, never through {@link coerceCustomFieldValue}.
 */
const CUSTOM_FIELD_DATA_TYPES: Record<string, CustomFieldDataType> = {
    // string / url
    qonto_transaction_id: 'string',
    qonto_attachment_id: 'string',
    qonto_currency: 'string',
    qonto_label: 'string',
    qonto_reference: 'string',
    invoice_currency: 'string',
    invoice_number: 'string',
    customer_number: 'string',
    supplier_vat_id: 'string',
    qonto_category: 'string',
    ai_note: 'string',
    invoice_kind: 'string',
    // float
    qonto_transaction_amount: 'float',
    // monetary (stored as "<ISO4217><amount>", e.g. "EUR57.60")
    qonto_vat_amount: 'monetary',
    total_net: 'monetary',
    total_gross: 'monetary',
    tax_amount: 'monetary',
    amount_to_pay: 'monetary',
    // date (ISO YYYY-MM-DD)
    qonto_settled_at: 'date',
    invoice_date: 'date',
    due_date: 'date',
    service_period_start: 'date',
    service_period_end: 'date',
    ai_reviewed_at: 'date',
    // boolean
    reverse_charge: 'boolean',
    // documentlink (related document ids)
    cancelled_by: 'documentlink',
    cancels: 'documentlink',
    related_documents: 'documentlink',
    // select fields (sale_type, tax_rate, supplier_country, accounting_category,
    // payment_status, ai_confidence, data_scope) are resolved in the select branch.
};

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'ja']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'nein']);

/** A monetary value handed in programmatically as `{ amount, currency }` rather than a string. */
function isMonetaryObject(value: unknown): value is { amount: number; currency?: string } {
    return typeof value === 'object' && value !== null && 'amount' in value;
}

/**
 * Coerce a raw custom-field value to the JS type Paperless' REST API expects for the given
 * `data_type`. The CLI always passes strings (`--custom-field reverse_charge=true` → `"true"`),
 * which Paperless rejects with HTTP 500 for typed fields — so strings-that-should-be-typed are
 * converted here. Values that already carry the right type (a real boolean, a number, a
 * `{ amount, currency }` object) pass through unharmed.
 *
 * @param dataType Paperless data_type of the field (from {@link CUSTOM_FIELD_DATA_TYPES}).
 * @param value Raw value (string from the CLI, or an already-typed value from a programmatic caller).
 * @param defaultCurrency Currency to assume for a monetary value without an embedded code (e.g. `"57.60"`).
 * @returns `{ value }` to write, or `null` to SKIP the field (e.g. an unparseable number/boolean).
 */
export function coerceCustomFieldValue(
    dataType: CustomFieldDataType,
    value: unknown,
    defaultCurrency = 'EUR',
): { value: unknown } | null {
    switch (dataType) {
        case 'boolean': {
            if (typeof value === 'boolean') return { value };
            if (typeof value === 'string') {
                const s = value.trim().toLowerCase();
                if (BOOLEAN_TRUE.has(s)) return { value: true };
                if (BOOLEAN_FALSE.has(s)) return { value: false };
            }
            // Unrecognised boolean literal: skip rather than send a type Paperless will reject.
            return null;
        }
        case 'monetary': {
            // Programmatic caller may hand in { amount, currency } directly.
            if (isMonetaryObject(value)) {
                if (typeof value.amount !== 'number' || Number.isNaN(value.amount)) return null;
                return { value: formatMonetaryValue(value.amount, value.currency ?? defaultCurrency) };
            }
            // Strings ("57.60", "USD57.60") and plain numbers → the "<CUR><amount>" round-trip
            // format Paperless stores (see formatMonetaryValue / parseMonetaryValue). An embedded
            // currency code is preserved; otherwise defaultCurrency is used.
            const parsed = parseMonetaryValue(value, defaultCurrency);
            if (!parsed) return null;
            return { value: formatMonetaryValue(parsed.amount, parsed.currency) };
        }
        case 'integer': {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            if (Number.isNaN(n)) return null;
            return { value: Math.trunc(n) };
        }
        case 'float': {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            if (Number.isNaN(n)) return null;
            return { value: n };
        }
        case 'documentlink': {
            // Paperless expects a LIST of document ids and answers a bare string with
            // HTTP 400 "Value must be a list" — the CLI's `--custom-field related_documents=3081`
            // hands in exactly such a string, so "3081" / "3081,3082" is parsed into [3081, 3082].
            const raw = Array.isArray(value) ? value : String(value).split(',');
            const ids = raw
                .map((v) => (typeof v === 'number' ? v : Number(String(v).trim())))
                .filter((n) => Number.isFinite(n))
                .map((n) => Math.trunc(n));
            return ids.length > 0 ? { value: ids } : null;
        }
        // date (ISO YYYY-MM-DD), string and url are stored/sent as-is; string fields are
        // capped at the Paperless 128-char limit.
        default:
            return { value: capText(value) };
    }
}

/**
 * Map a Record of friendly field names → values into Paperless `{ field, value }` entries.
 * Unknown or unconfigured fields (id ≤ 0) are skipped. Select-field labels are converted to
 * their option ID (numeric-coerced when the option ID is all digits); every other field's value
 * is coerced to its Paperless `data_type` (see {@link coerceCustomFieldValue}) so booleans and
 * monetary/number fields are not sent as raw strings (which Paperless rejects with HTTP 500).
 */
export function resolveCustomFieldEntries(
    fields: Record<string, unknown>,
    config: SyncConfig,
): Array<{ field: number; value: unknown }> {
    const cf = config.custom_field_ids as Record<string, number>;
    const opts = config.select_field_options;

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

    // Currency to assume for monetary values that carry no embedded code — mirror the read path
    // (prefer an explicit invoice_currency in the same batch, else EUR).
    const rawCurrency = fields.invoice_currency;
    const defaultCurrency =
        typeof rawCurrency === 'string' && rawCurrency.trim().length === 3
            ? rawCurrency.trim().toUpperCase()
            : 'EUR';

    const entries: Array<{ field: number; value: unknown }> = [];
    for (const [key, value] of Object.entries(fields)) {
        const fieldId = cf[key];
        if (!fieldId || fieldId <= 0) continue;

        const selectInfo = selectFieldMaps[key];
        if (selectInfo && typeof value === 'string') {
            let resolvedValue: unknown = value;
            const raw = key === 'tax_rate' ? (normalizeTaxRateLabel(value) ?? value) : value;
            // Tolerant, so `geschaeftlich` finds `geschäftlich` — see canonicalSelectLabel for
            // why an exact comparison here produced an unreadable Paperless error.
            const label = canonicalSelectLabel(selectInfo.labels, raw);
            if (label != null) {
                const optId = selectLabelToOptionId(selectInfo.optionMap, label);
                resolvedValue = optId != null && /^\d+$/.test(optId) ? Number(optId) : (optId ?? label);
            }
            entries.push({ field: fieldId, value: resolvedValue });
            continue;
        }

        const dataType = CUSTOM_FIELD_DATA_TYPES[key];
        if (dataType) {
            const coerced = coerceCustomFieldValue(dataType, value, defaultCurrency);
            if (coerced) entries.push({ field: fieldId, value: coerced.value });
            // else: unparseable typed value (e.g. bogus boolean/number) — skip, don't 500.
        } else {
            // Unknown field: preserve prior behaviour (string passthrough, capped at 128).
            entries.push({ field: fieldId, value: capText(value) });
        }
    }
    return entries;
}

/** Paperless string custom fields are limited to 128 characters; cap over-long text (e.g. ai_note). */
const MAX_STRING_FIELD = 128;
function capText(value: unknown): unknown {
    return typeof value === 'string' && value.length > MAX_STRING_FIELD ? value.slice(0, MAX_STRING_FIELD) : value;
}
