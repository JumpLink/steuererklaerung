/**
 * Setup Paperless resources for Belege-Sync: create document types, custom fields,
 * and tags when their IDs are 0 in sync-config; write new IDs back to config.
 * Used by paperless setup-fields.
 */

import {
    createCustomField,
    createDocumentType,
    createTag,
    getCustomField,
    updateCustomField,
} from '@steuererklaerung/paperless';
import { loadPaperlessConfig, writeSyncConfig } from '../../config/index.ts';
import type { SyncConfig } from '../../config/index.ts';
import {
    SALE_TYPE_EXTRA_DATA,
    TAX_RATE_EXTRA_DATA,
    SUPPLIER_COUNTRY_EXTRA_DATA,
    ACCOUNTING_CATEGORY_EXTRA_DATA,
    PAYMENT_STATUS_EXTRA_DATA,
    AI_CONFIDENCE_EXTRA_DATA,
    DATA_SCOPE_EXTRA_DATA,
} from '../../lib/select-field-constants.ts';

export interface SetupPaperlessFieldsResult {
    updated: boolean;
    lines: string[];
}

type SyncConfigResourceKey = 'document_type_ids' | 'custom_field_ids' | 'tag_ids';

const RESOURCE_LABEL: Record<SyncConfigResourceKey, string> = {
    document_type_ids: 'Document type',
    custom_field_ids: 'Custom field',
    tag_ids: 'Tag',
};

/** Select field config keys that need option ID mappings stored in select_field_options. */
const SELECT_FIELD_KEYS = new Set([
    'sale_type',
    'tax_rate',
    'supplier_country',
    'accounting_category',
    'payment_status',
    'ai_confidence',
    'data_scope',
]);

const RESOURCES: Array<{
    key: SyncConfigResourceKey;
    entries: Array<{
        configKey: string;
        name: string;
        create: () => Promise<{
            id: number;
            extra_data?: { select_options?: Array<{ label?: string | null; id?: string | null }> } | null;
        }>;
    }>;
}> = [
    {
        key: 'document_type_ids',
        entries: [
            {
                configKey: 'incoming_invoice',
                name: 'Incoming Invoice',
                create: () => createDocumentType({ name: 'Incoming Invoice' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'outgoing_invoice',
                name: 'Outgoing Invoice',
                create: () => createDocumentType({ name: 'Outgoing Invoice' }).then((r) => ({ id: r.id })),
            },
        ],
    },
    {
        key: 'custom_field_ids',
        entries: [
            {
                configKey: 'qonto_transaction_id',
                name: 'Qonto Transaction ID',
                create: () =>
                    createCustomField({ name: 'Qonto Transaction ID', data_type: 'string' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'qonto_attachment_id',
                name: 'Qonto Attachment ID',
                create: () =>
                    createCustomField({ name: 'Qonto Attachment ID', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'qonto_transaction_amount',
                name: 'Qonto Transaktionsbetrag',
                create: () =>
                    createCustomField({ name: 'Qonto Transaktionsbetrag', data_type: 'float' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'qonto_settled_at',
                name: 'Qonto Buchungsdatum',
                create: () =>
                    createCustomField({ name: 'Qonto Buchungsdatum', data_type: 'date' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'qonto_currency',
                name: 'Qonto Währung',
                create: () =>
                    createCustomField({ name: 'Qonto Währung', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'qonto_label',
                name: 'Qonto Label',
                create: () =>
                    createCustomField({ name: 'Qonto Label', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'qonto_reference',
                name: 'Qonto Referenz',
                create: () =>
                    createCustomField({ name: 'Qonto Referenz', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'qonto_vat_amount',
                name: 'Qonto USt-Betrag',
                create: () =>
                    createCustomField({
                        name: 'Qonto USt-Betrag',
                        data_type: 'monetary',
                        extra_data: { default_currency: 'EUR' },
                    }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'invoice_currency',
                name: 'Rechnungswährung',
                create: () =>
                    createCustomField({ name: 'Rechnungswährung', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'invoice_number',
                name: 'Rechnungsnummer',
                create: () =>
                    createCustomField({ name: 'Rechnungsnummer', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'invoice_date',
                name: 'Rechnungsdatum',
                create: () =>
                    createCustomField({ name: 'Rechnungsdatum', data_type: 'date' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'due_date',
                name: 'Fälligkeitsdatum',
                create: () =>
                    createCustomField({ name: 'Fälligkeitsdatum', data_type: 'date' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'total_net',
                name: 'Betrag (Netto)',
                create: () =>
                    createCustomField({
                        name: 'Betrag (Netto)',
                        data_type: 'monetary',
                        extra_data: { default_currency: 'EUR' },
                    }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'total_gross',
                name: 'Betrag (Brutto)',
                create: () =>
                    createCustomField({
                        name: 'Betrag (Brutto)',
                        data_type: 'monetary',
                        extra_data: { default_currency: 'EUR' },
                    }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'tax_amount',
                name: 'Umsatzsteuerbetrag',
                create: () =>
                    createCustomField({
                        name: 'Umsatzsteuerbetrag',
                        data_type: 'monetary',
                        extra_data: { default_currency: 'EUR' },
                    }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'tax_rate',
                name: 'Steuersatz',
                create: () =>
                    createCustomField({
                        name: 'Steuersatz',
                        data_type: 'select',
                        extra_data: TAX_RATE_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            {
                configKey: 'customer_number',
                name: 'Kundennummer',
                create: () =>
                    createCustomField({ name: 'Kundennummer', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'service_period_start',
                name: 'Leistungszeitraum Beginn',
                create: () =>
                    createCustomField({ name: 'Leistungszeitraum Beginn', data_type: 'date' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'service_period_end',
                name: 'Leistungszeitraum Ende',
                create: () =>
                    createCustomField({ name: 'Leistungszeitraum Ende', data_type: 'date' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'supplier_country',
                name: 'Lieferantenland',
                create: () =>
                    createCustomField({
                        name: 'Lieferantenland',
                        data_type: 'select',
                        extra_data: SUPPLIER_COUNTRY_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            {
                configKey: 'supplier_vat_id',
                name: 'Lieferanten-USt-IdNr',
                create: () =>
                    createCustomField({ name: 'Lieferanten-USt-IdNr', data_type: 'string' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'reverse_charge',
                name: 'Reverse Charge',
                create: () =>
                    createCustomField({ name: 'Reverse Charge', data_type: 'boolean' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'sale_type',
                name: 'Leistungsart',
                create: () =>
                    createCustomField({
                        name: 'Leistungsart',
                        data_type: 'select',
                        extra_data: SALE_TYPE_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            {
                configKey: 'qonto_category',
                name: 'Qonto Kategorie',
                create: () =>
                    createCustomField({ name: 'Qonto Kategorie', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'accounting_category',
                name: 'Buchungskategorie',
                create: () =>
                    createCustomField({
                        name: 'Buchungskategorie',
                        data_type: 'select',
                        extra_data: ACCOUNTING_CATEGORY_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            // --- Document relationships + AI/document-workflow fields ---
            {
                configKey: 'cancelled_by',
                name: 'Storniert durch',
                create: () =>
                    createCustomField({ name: 'Storniert durch', data_type: 'documentlink' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'cancels',
                name: 'Storniert Dokument',
                create: () =>
                    createCustomField({ name: 'Storniert Dokument', data_type: 'documentlink' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'related_documents',
                name: 'Verknüpfte Dokumente',
                create: () =>
                    createCustomField({ name: 'Verknüpfte Dokumente', data_type: 'documentlink' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'payment_status',
                name: 'Zahlstatus',
                create: () =>
                    createCustomField({
                        name: 'Zahlstatus',
                        data_type: 'select',
                        extra_data: PAYMENT_STATUS_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            {
                configKey: 'amount_to_pay',
                name: 'Zu zahlen',
                create: () =>
                    createCustomField({
                        name: 'Zu zahlen',
                        data_type: 'monetary',
                        extra_data: { default_currency: 'EUR' },
                    }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'ai_note',
                name: 'KI-Hinweis',
                create: () =>
                    createCustomField({ name: 'KI-Hinweis', data_type: 'string' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'invoice_kind',
                name: 'Rechnungsart (E-Rechnung)',
                create: () =>
                    createCustomField({ name: 'Rechnungsart (E-Rechnung)', data_type: 'string' }).then((r) => ({
                        id: r.id,
                    })),
            },
            {
                configKey: 'ai_confidence',
                name: 'KI-Konfidenz',
                create: () =>
                    createCustomField({
                        name: 'KI-Konfidenz',
                        data_type: 'select',
                        extra_data: AI_CONFIDENCE_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
            {
                configKey: 'ai_reviewed_at',
                name: 'KI-geprüft am',
                create: () =>
                    createCustomField({ name: 'KI-geprüft am', data_type: 'date' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'data_scope',
                name: 'Datenbereich',
                create: () =>
                    createCustomField({
                        name: 'Datenbereich',
                        data_type: 'select',
                        extra_data: DATA_SCOPE_EXTRA_DATA,
                    }).then((r) => ({ id: r.id, extra_data: r.extra_data })),
            },
        ],
    },
    {
        key: 'tag_ids',
        entries: [
            {
                configKey: 'qonto_import',
                name: 'qonto-import',
                create: () => createTag({ name: 'qonto-import' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'ai_reviewed',
                name: 'ki-uberarbeitet',
                create: () => createTag({ name: 'ki-uberarbeitet' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'irrelevant',
                name: 'unrelevant',
                create: () => createTag({ name: 'unrelevant' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'duplicate',
                name: 'duplikat',
                create: () => createTag({ name: 'duplikat' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'school',
                name: 'schule',
                create: () => createTag({ name: 'schule' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'finance',
                name: 'finanzen',
                create: () => createTag({ name: 'finanzen' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'server_infrastructure',
                name: 'server-infrastruktur',
                create: () => createTag({ name: 'server-infrastruktur' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'cancelled',
                name: 'Storniert',
                create: () => createTag({ name: 'Storniert' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'storno',
                name: 'Storno',
                create: () => createTag({ name: 'Storno' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'water',
                name: 'Wasser',
                create: () => createTag({ name: 'Wasser' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'wastewater',
                name: 'Abwasser',
                create: () => createTag({ name: 'Abwasser' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'ai_conflict',
                name: 'KI-Konflikt',
                create: () => createTag({ name: 'KI-Konflikt' }).then((r) => ({ id: r.id })),
            },
            {
                configKey: 'inbox',
                name: 'Neu',
                create: () => createTag({ name: 'Neu' }).then((r) => ({ id: r.id })),
            },
        ],
    },
];

/**
 * Ensure all sync resources exist in Paperless; create any with ID 0 and persist IDs to config.
 * Returns log lines and whether config was written (for caller to print).
 */
export async function setupPaperlessFields(): Promise<SetupPaperlessFieldsResult> {
    const config = loadPaperlessConfig({ strict: false });
    const lines: string[] = [];
    let updated = false;

    const updates: Partial<SyncConfig> = {
        document_type_ids: { ...config.document_type_ids },
        custom_field_ids: { ...config.custom_field_ids },
        tag_ids: { ...config.tag_ids },
        select_field_options: { ...config.select_field_options },
    };

    for (const { key, entries } of RESOURCES) {
        const section = updates[key] as Record<string, number>;
        for (const { configKey, name, create } of entries) {
            const currentId = section[configKey];
            const label = RESOURCE_LABEL[key];
            if (currentId) {
                lines.push(`${label} "${name}" already has id ${currentId}, skipping.`);
                continue;
            }
            const created = await create();
            section[configKey] = created.id;
            updated = true;
            lines.push(`Created ${label.toLowerCase()} "${name}" (id: ${created.id}).`);

            // Select fields: this Paperless build's POST-create can leave options
            // WITHOUT ids, which breaks value rendering in the web UI. PATCH with the
            // same labels to force id generation. Note: the client pins an API version
            // that serializes select values as the option INDEX (not the id), so we
            // store a label -> index map for read/write.
            if (SELECT_FIELD_KEYS.has(configKey)) {
                let opts = (await getCustomField(created.id)).extra_data?.select_options ?? [];
                if (opts.some((o) => !o.id)) {
                    const patched = await updateCustomField(created.id, {
                        data_type: 'select',
                        extra_data: { select_options: opts.map((o) => ({ label: o.label })) },
                    });
                    opts = patched.extra_data?.select_options ?? opts;
                }
                const optionMap: Record<string, string> = {};
                opts.forEach((opt, i) => {
                    if (opt.label) optionMap[opt.label] = String(i);
                });
                (updates.select_field_options as Record<string, Record<string, string>>)[configKey] = optionMap;
                lines.push(
                    `  Stored ${Object.keys(optionMap).length} select option mappings for "${configKey}" (index-based; option ids ensured).`,
                );
            }
        }
    }

    if (updated) {
        writeSyncConfig(updates);
        lines.push('Updated sync-config.json with new IDs.');
    }

    return { updated, lines };
}
