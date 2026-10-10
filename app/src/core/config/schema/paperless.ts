/**
 * Manifest section schema: top-level `paperless` (the global Paperless-ngx sync config).
 *
 * This module OWNS the former `sync-config.json` schema (custom field / tag / doc-type ids, providers,
 * select-field option maps, …) — the standalone `sync-config.ts` loader is gone; the payload now lives
 * inline under the consolidated manifest's `paperless` key.
 *
 * The section is LENIENT (document_type_ids may be 0) so a not-yet-fully-set-up payload still validates
 * — the strict variant (positive doc-type ids) is kept for the setup flow only.
 */

import { z } from 'zod';

const nonNegativeInt = z.number().int().nonnegative().default(0);
const positiveInt = z.number().int().positive();

const DocumentTypeIdsSchema = z.object({
    incoming_invoice: nonNegativeInt,
    outgoing_invoice: nonNegativeInt,
});

const DocumentTypeIdsStrictSchema = z.object({
    incoming_invoice: positiveInt,
    outgoing_invoice: positiveInt,
});

const CustomFieldIdsSchema = z.object({
    qonto_transaction_id: nonNegativeInt,
    qonto_attachment_id: nonNegativeInt,
    qonto_transaction_amount: nonNegativeInt,
    qonto_settled_at: nonNegativeInt,
    qonto_currency: nonNegativeInt,
    /** Qonto transaction label (counterparty name, e.g. "DIGITALOCEAN_COM"). */
    qonto_label: nonNegativeInt,
    /** Qonto SEPA reference / Verwendungszweck (may contain invoice number). */
    qonto_reference: nonNegativeInt,
    /** Qonto VAT amount from the bank transaction. */
    qonto_vat_amount: nonNegativeInt,
    invoice_currency: nonNegativeInt,
    invoice_number: nonNegativeInt,
    invoice_date: nonNegativeInt,
    due_date: nonNegativeInt,
    total_net: nonNegativeInt,
    total_gross: nonNegativeInt,
    tax_amount: nonNegativeInt,
    tax_rate: nonNegativeInt,
    customer_number: nonNegativeInt,
    /** First day of service period (date field). */
    service_period_start: nonNegativeInt,
    /** Last day of service period (date field). */
    service_period_end: nonNegativeInt,
    /** ISO 3166-1 alpha-2 country of the supplier (e.g. DE, US, NL). */
    supplier_country: nonNegativeInt,
    /** Supplier's VAT ID (USt-IdNr.). */
    supplier_vat_id: nonNegativeInt,
    /** Whether invoice uses Reverse Charge (boolean field). */
    reverse_charge: nonNegativeInt,
    /** GOODS or SERVICES. */
    sale_type: nonNegativeInt,
    /** Qonto transaction category (e.g. "marketing", "online_service", "fees"). */
    qonto_category: nonNegativeInt,
    /** SKR03-nahe Buchungskategorie (select field). */
    accounting_category: nonNegativeInt,
    // --- Document relationships + AI/document-workflow fields ---
    /** documentlink: invoice → the credit note / Storno that cancels it. */
    cancelled_by: nonNegativeInt,
    /** documentlink: Storno → the invoice it cancels. */
    cancels: nonNegativeInt,
    /** documentlink: general "see also" between related documents. */
    related_documents: nonNegativeInt,
    /** Payment status select (offen/bezahlt/verrechnet/storniert/nicht-zahlungsrelevant). */
    payment_status: nonNegativeInt,
    /** Amount actually due after offsets (monetary, ≠ total_gross). */
    amount_to_pay: nonNegativeInt,
    /** Free-form AI annotation (string). */
    ai_note: nonNegativeInt,
    /** §14 UStG classification of the invoice file (string "<kind>|<reason>"), set without AI. */
    invoice_kind: nonNegativeInt,
    /** Confidence of the AI annotation (select: high/medium/low). */
    ai_confidence: nonNegativeInt,
    /** Date the document was last AI-reviewed. */
    ai_reviewed_at: nonNegativeInt,
    /** Business / private / mixed scope (select: privat/geschäftlich/gemischt). */
    data_scope: nonNegativeInt,
});

const TagIdsSchema = z.object({
    qonto_import: nonNegativeInt,
    ai_reviewed: nonNegativeInt,
    irrelevant: nonNegativeInt,
    /** Tag applied to duplicate documents before moving them to trash. */
    duplicate: nonNegativeInt,
    school: nonNegativeInt,
    finance: nonNegativeInt,
    server_infrastructure: nonNegativeInt,
    /** Document has been cancelled by a credit note / Storno ("Storniert"). */
    cancelled: nonNegativeInt,
    /** Document IS a credit note / cancellation ("Storno"). */
    storno: nonNegativeInt,
    /** Water ("Wasser"). */
    water: nonNegativeInt,
    /** Wastewater ("Abwasser"). */
    wastewater: nonNegativeInt,
    /** AI found a discrepancy needing human review ("KI-Konflikt"). */
    ai_conflict: nonNegativeInt,
    /** Inbox: documents waiting for review ("Neu"). Read by the backend-agnostic dms_list_inbox tool. */
    inbox: nonNegativeInt,
});

const PreferredLanguageSchema = z.enum(['de', 'en']).default('de');

const InvoiceProviderDefaultsSchema = z
    .object({
        supplier_country: z.string().optional(),
        supplier_vat_id: z.string().optional(),
        sale_type: z.enum(['GOODS', 'SERVICES']).optional(),
        reverse_charge: z.boolean().optional(),
        currency: z.string().optional(),
    })
    .default({});

const InvoiceProviderSchema = z.object({
    /** Paperless correspondent ID for this provider. 0 = not set. */
    correspondent_id: nonNegativeInt,
    /** Paperless document type ID. 0 = fall back to document_type_ids.incoming_invoice. */
    document_type_id: nonNegativeInt,
    /** Paperless tag IDs to apply on import. */
    tag_ids: z.array(z.number().int().nonnegative()).default([]),
    /** Static invoice fields known for this provider. */
    defaults: InvoiceProviderDefaultsSchema,
});

const DEFAULT_CUSTOM_FIELD_IDS = {
    qonto_transaction_id: 0,
    qonto_attachment_id: 0,
    qonto_transaction_amount: 0,
    qonto_settled_at: 0,
    qonto_currency: 0,
    qonto_label: 0,
    qonto_reference: 0,
    qonto_vat_amount: 0,
    invoice_currency: 0,
    invoice_number: 0,
    invoice_date: 0,
    due_date: 0,
    total_net: 0,
    total_gross: 0,
    tax_amount: 0,
    tax_rate: 0,
    customer_number: 0,
    service_period_start: 0,
    service_period_end: 0,
    supplier_country: 0,
    supplier_vat_id: 0,
    reverse_charge: 0,
    sale_type: 0,
    qonto_category: 0,
    accounting_category: 0,
    cancelled_by: 0,
    cancels: 0,
    related_documents: 0,
    payment_status: 0,
    amount_to_pay: 0,
    ai_note: 0,
    invoice_kind: 0,
    ai_confidence: 0,
    ai_reviewed_at: 0,
    data_scope: 0,
} as const;

const DEFAULT_TAG_IDS = {
    qonto_import: 0,
    ai_reviewed: 0,
    irrelevant: 0,
    duplicate: 0,
    school: 0,
    finance: 0,
    server_infrastructure: 0,
    cancelled: 0,
    storno: 0,
    water: 0,
    wastewater: 0,
    ai_conflict: 0,
    inbox: 0,
} as const;

const DEFAULT_DOCUMENT_TYPE_IDS = {
    incoming_invoice: 0,
    outgoing_invoice: 0,
} as const;

/** Label → Paperless option ID mapping for a single select field. */
const SelectFieldOptionMapSchema = z.record(z.string(), z.string()).default({});

/** Per-select-field option mappings. Keyed by field config key (e.g. "sale_type"). */
const SelectFieldOptionsSchema = z
    .object({
        sale_type: SelectFieldOptionMapSchema,
        tax_rate: SelectFieldOptionMapSchema,
        supplier_country: SelectFieldOptionMapSchema,
        accounting_category: SelectFieldOptionMapSchema,
        payment_status: SelectFieldOptionMapSchema,
        ai_confidence: SelectFieldOptionMapSchema,
        data_scope: SelectFieldOptionMapSchema,
    })
    .default({
        sale_type: {},
        tax_rate: {},
        supplier_country: {},
        accounting_category: {},
        payment_status: {},
        ai_confidence: {},
        data_scope: {},
    });

const SyncConfigBaseSchema = z.object({
    custom_field_ids: CustomFieldIdsSchema.default(DEFAULT_CUSTOM_FIELD_IDS),
    tag_ids: TagIdsSchema.default(DEFAULT_TAG_IDS),
    own_correspondent_ids: z.array(z.number().int().positive()).default([]),
    /**
     * Paperless tag IDs whose documents are out of business scope (e.g. the per-person "* Privat"
     * tags on privately-paid purchases). Documents bearing any of these are hidden from the DMS
     * view — Beleg-Eingang, document browser and reconciliation. Default: exclude nothing.
     */
    exclude_tag_ids: z.array(z.number().int().positive()).default([]),
    preferred_language: PreferredLanguageSchema,
    /** Per-provider configuration for the invoices command. Keyed by provider name (e.g. "inwx"). */
    invoice_providers: z.record(z.string(), InvoiceProviderSchema).default({}),
    /** Label → Paperless option ID mappings for select custom fields. Populated by setup/migration. */
    select_field_options: SelectFieldOptionsSchema,
});

/** Strict variant — document_type_ids must be positive. Kept for the `paperless setup-fields` flow. */
export const SyncConfigStrictSchema = SyncConfigBaseSchema.extend({
    document_type_ids: DocumentTypeIdsStrictSchema,
});

/**
 * Lenient variant (document_type_ids may be 0) — the manifest's `paperless` section so a
 * not-yet-fully-set-up sync payload still validates.
 */
export const SyncConfigLenientSchema = SyncConfigBaseSchema.extend({
    document_type_ids: DocumentTypeIdsSchema.default(DEFAULT_DOCUMENT_TYPE_IDS),
});

export type SyncConfig = z.infer<typeof SyncConfigStrictSchema>;
export type PreferredLanguage = z.infer<typeof PreferredLanguageSchema>;

/** Built-in defaults for an empty paperless payload (all ids 0). */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
    document_type_ids: { ...DEFAULT_DOCUMENT_TYPE_IDS },
    custom_field_ids: { ...DEFAULT_CUSTOM_FIELD_IDS },
    tag_ids: { ...DEFAULT_TAG_IDS },
    own_correspondent_ids: [],
    exclude_tag_ids: [],
    preferred_language: 'de',
    invoice_providers: {},
    select_field_options: {
        sale_type: {},
        tax_rate: {},
        supplier_country: {},
        accounting_category: {},
        payment_status: {},
        ai_confidence: {},
        data_scope: {},
    },
};

export const PaperlessSectionSchema = SyncConfigLenientSchema;
export type PaperlessSection = z.infer<typeof PaperlessSectionSchema>;
