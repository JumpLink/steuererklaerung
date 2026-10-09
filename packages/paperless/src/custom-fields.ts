/**
 * Paperless-NGX API – Custom Fields.
 * List, get, create, update custom fields (for central document/invoice metadata from Qonto and the ledger store).
 */

import { get, patch, post } from './request.ts';
import type {
    CreateCustomFieldOptions,
    CustomField,
    PaginatedCustomFields,
    UpdateCustomFieldOptions,
} from './types.ts';

const CUSTOM_FIELDS_PATH = '/api/custom_fields/';

export interface ListCustomFieldsParams {
    page_size?: number;
    page?: number;
}

/**
 * List all custom fields (e.g. to resolve field IDs for sync logic).
 */
export async function listCustomFields(params: ListCustomFieldsParams = {}): Promise<PaginatedCustomFields> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedCustomFields>(CUSTOM_FIELDS_PATH, query);
}

/**
 * Get a single custom field by ID.
 */
export async function getCustomField(id: number): Promise<CustomField> {
    return get<CustomField>(`/api/custom_fields/${id}/`);
}

/**
 * Create a custom field (e.g. "Qonto Transaction ID", "Rechnungsnummer", "Amount", "Currency").
 */
export async function createCustomField(options: CreateCustomFieldOptions): Promise<CustomField> {
    return post<CustomField>(CUSTOM_FIELDS_PATH, options as unknown as Record<string, unknown>);
}

/**
 * Update a custom field (name, data_type, extra_data).
 */
export async function updateCustomField(id: number, options: UpdateCustomFieldOptions): Promise<CustomField> {
    return patch<CustomField>(`/api/custom_fields/${id}/`, options as unknown as Record<string, unknown>);
}
