/**
 * Paperless-NGX API – Document Types.
 * List, get, and create document types (e.g. "Incoming Invoice", "Outgoing Invoice").
 */

import { get, post, type PaperlessConfig } from './request.ts';
import type { DocumentType, PaginatedDocumentTypes } from './types.ts';

const DOCUMENT_TYPES_PATH = '/api/document_types/';

export interface CreateDocumentTypeOptions {
    name: string;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
}

export interface ListDocumentTypesParams {
    page_size?: number;
    page?: number;
}

/**
 * List all document types (paginated). Use this to discover IDs for sync-config (e.g. incoming_invoice, outgoing_invoice).
 * Requires PAPERLESS_BASE_URL and PAPERLESS_API_TOKEN.
 */
export async function listDocumentTypes(
    params: ListDocumentTypesParams = {},
    cfg?: PaperlessConfig,
): Promise<PaginatedDocumentTypes> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedDocumentTypes>(DOCUMENT_TYPES_PATH, query, cfg);
}

/**
 * Get a single document type by ID.
 * Requires PAPERLESS_BASE_URL and PAPERLESS_API_TOKEN.
 */
export async function getDocumentType(id: number): Promise<DocumentType> {
    return get<DocumentType>(`/api/document_types/${id}/`);
}

/**
 * Create a document type (e.g. "Incoming Invoice", "Outgoing Invoice").
 * Returns the created document type including its ID.
 */
export async function createDocumentType(options: CreateDocumentTypeOptions): Promise<DocumentType> {
    const body: Record<string, unknown> = { name: options.name };
    if (options.match != null) body.match = options.match;
    if (options.matching_algorithm != null) body.matching_algorithm = options.matching_algorithm;
    if (options.is_insensitive != null) body.is_insensitive = options.is_insensitive;
    return post<DocumentType>(DOCUMENT_TYPES_PATH, body);
}
