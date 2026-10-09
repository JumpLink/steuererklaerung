/**
 * Paperless-NGX API – Documents.
 * List, get, post (upload), update; optional bulk edit.
 */

import { del, get, getBinary, patch, post, postMultipartManual, type PaperlessConfig } from './request.ts';
import type {
    Document,
    PaginatedDocuments,
    PostDocumentOptions,
    PostDocumentResponse,
    UpdateDocumentPayload,
} from './types.ts';

const DOCUMENTS_PATH = '/api/documents/';
const POST_DOCUMENT_PATH = '/api/documents/post_document/';
const BULK_EDIT_PATH = '/api/documents/bulk_edit/';

export interface ListDocumentsParams {
    page_size?: number;
    page?: number;
    query?: string;
    /** Filter by custom field values (API syntax e.g. ["fieldname", "exact", value]). */
    custom_field_query?: string;
    /** Filter by document type ID (Paperless-NGX may support this as query param). */
    document_type_id?: number;
    /** Filter by correspondent ID. */
    correspondent_id?: number;
    /** Filter to documents carrying ALL of these tag IDs (Paperless `tags__id__in`, comma-joined). */
    tag_ids?: number[];
    /** Sort order for stable pagination (e.g. "id" or "-created"). */
    ordering?: string;
}

/**
 * List documents with optional pagination and filters.
 * Use custom_field_query to filter by custom field values (e.g. all documents with Qonto transaction X).
 */
export async function listDocuments(
    params: ListDocumentsParams = {},
    cfg?: PaperlessConfig,
): Promise<PaginatedDocuments> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    if (params.query != null) query.query = params.query;
    if (params.custom_field_query != null) query.custom_field_query = params.custom_field_query;
    if (params.document_type_id != null) query['document_type__id'] = params.document_type_id;
    if (params.correspondent_id != null) query['correspondent__id'] = params.correspondent_id;
    if (params.tag_ids != null && params.tag_ids.length > 0) query['tags__id__in'] = params.tag_ids.join(',');
    if (params.ordering != null) query.ordering = params.ordering;
    return get<PaginatedDocuments>(DOCUMENTS_PATH, query, cfg);
}

/**
 * Get a single document by ID (includes custom_fields).
 */
export async function getDocument(id: number, cfg?: PaperlessConfig): Promise<Document> {
    return get<Document>(`/api/documents/${id}/`, {}, cfg);
}

export interface DownloadDocumentOptions {
    /** If true, download the original file; otherwise the archived version. */
    original?: boolean;
}

/**
 * Download document file from Paperless. Returns file content as Buffer.
 * Use for re-uploading the same file to another service (e.g. Qonto attachments).
 */
export async function downloadDocument(
    id: number,
    options?: DownloadDocumentOptions,
    cfg?: PaperlessConfig,
): Promise<Buffer> {
    const query: Record<string, unknown> = {};
    if (options?.original) query.original = 'true';
    return getBinary(`/api/documents/${id}/download/`, query, cfg);
}

/**
 * Download Paperless' pre-rendered thumbnail (WebP) for a document — generated on consume
 * for every doc incl. PDFs. Used for the Belege card previews. Returns the image as Buffer.
 */
export async function downloadThumbnail(id: number, cfg?: PaperlessConfig): Promise<Buffer> {
    return getBinary(`/api/documents/${id}/thumb/`, {}, cfg);
}

/**
 * Infer the multipart part content-type from the file extension. Paperless consumes by content,
 * but sending a truthful type avoids surprises for non-PDF uploads (meter photos, scans, images).
 */
export function contentTypeForFilename(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    switch (ext) {
        case 'pdf':
            return 'application/pdf';
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'tif':
        case 'tiff':
            return 'image/tiff';
        case 'webp':
            return 'image/webp';
        case 'txt':
            return 'text/plain';
        case 'csv':
            return 'text/csv';
        case 'md':
            return 'text/markdown';
        case 'xml':
            // Declared honestly even though Paperless will very likely REJECT it: the server
            // sniffs the CONTENT with libmagic and ignores this header entirely, so claiming
            // text/plain here would not smuggle an XML file in — it would only make the
            // rejection harder to understand. See postDocument's note on the sniffing.
            return 'text/xml';
        default:
            return 'application/octet-stream';
    }
}

/** Collect the optional metadata into ordered multipart text fields (tags repeat). */
function buildPostDocumentFields(options?: PostDocumentOptions): Array<[string, string]> {
    const fields: Array<[string, string]> = [];
    if (options?.title != null) fields.push(['title', options.title]);
    if (options?.created != null) fields.push(['created', options.created]);
    if (options?.correspondent != null) fields.push(['correspondent', String(options.correspondent)]);
    if (options?.document_type != null) fields.push(['document_type', String(options.document_type)]);
    if (options?.storage_path != null) fields.push(['storage_path', String(options.storage_path)]);
    if (options?.archive_serial_number != null)
        fields.push(['archive_serial_number', String(options.archive_serial_number)]);
    if (options?.tags != null) {
        for (const tagId of options.tags) fields.push(['tags', String(tagId)]);
    }
    if (options?.custom_fields != null) fields.push(['custom_fields', JSON.stringify(options.custom_fields)]);
    return fields;
}

/**
 * Upload a document to Paperless. Returns the consumption task UUID; use getTask(task_id)
 * to poll status and get the created document ID. The multipart body is built by hand
 * (see {@link postMultipartManual}) so the file part survives GJS' fetch.
 *
 * WHICH TYPES ARE ACCEPTED IS THE SERVER'S CALL, AND IT SNIFFS THE CONTENT. Paperless runs
 * libmagic over the bytes and ignores the Content-Type declared here, so the accepted set is
 * whatever that instance's parsers cover (PDF, images, text/plain, …) — and renaming a file does
 * NOT change the verdict. An ELSTER server response saved as `.txt` still sniffs as `text/xml`
 * and is still refused ("File type text/xml not supported"). When machine XML has to reach the
 * DMS, put a human-readable text record there and keep the raw XML beside the filing; that is
 * also the more useful document, since a DMS indexes prose and not EDS envelopes.
 */
export async function postDocument(
    file: Buffer | Blob | Uint8Array,
    filename: string,
    options?: PostDocumentOptions,
    contentType?: string,
): Promise<PostDocumentResponse> {
    const bytes =
        file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : Uint8Array.from(file as ArrayLike<number>);
    return postMultipartManual<PostDocumentResponse>(
        POST_DOCUMENT_PATH,
        buildPostDocumentFields(options),
        'document',
        filename,
        bytes,
        contentType ?? contentTypeForFilename(filename),
    );
}

/**
 * Update a document (e.g. set custom_fields for Qonto/ledger data as single source of truth).
 */
export async function updateDocument(
    id: number,
    payload: UpdateDocumentPayload,
    cfg?: PaperlessConfig,
): Promise<Document> {
    return patch<Document>(`/api/documents/${id}/`, payload as unknown as Record<string, unknown>, cfg);
}

/**
 * Bulk edit documents – modify_custom_fields: add and/or remove custom field values.
 * Both add_custom_fields and remove_custom_fields are required by the Paperless API.
 */
export async function bulkEditDocuments(
    documentIds: number[],
    method: 'modify_custom_fields',
    parameters: {
        add_custom_fields: Record<number, unknown> | number[];
        remove_custom_fields: number[];
    },
): Promise<void> {
    await post(BULK_EDIT_PATH, {
        documents: documentIds,
        method,
        parameters: {
            add_custom_fields: parameters.add_custom_fields ?? {},
            remove_custom_fields: parameters.remove_custom_fields ?? [],
        },
    });
}

/**
 * Delete a document by ID. Irreversible.
 */
export async function deleteDocument(id: number): Promise<void> {
    await del(`/api/documents/${id}/`);
}
