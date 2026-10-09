/**
 * Paperless-NGX API – Tags.
 * List and create tags (e.g. "qonto-import" for documents imported from Qonto).
 */

import { get, post, type PaperlessConfig } from './request.ts';
import type { Tag, PaginatedTags, CreateTagOptions } from './types.ts';

const TAGS_PATH = '/api/tags/';

export interface ListTagsParams {
    page_size?: number;
    page?: number;
}

/**
 * List all tags (paginated). Use to resolve tag IDs for sync config.
 */
export async function listTags(params: ListTagsParams = {}, cfg?: PaperlessConfig): Promise<PaginatedTags> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedTags>(TAGS_PATH, query, cfg);
}

/**
 * Get a single tag by ID.
 */
export async function getTag(id: number): Promise<Tag> {
    return get<Tag>(`/api/tags/${id}/`);
}

/**
 * Create a tag (e.g. "qonto-import"). Returns the created tag including its ID.
 */
export async function createTag(options: CreateTagOptions): Promise<Tag> {
    const body: Record<string, unknown> = { name: options.name };
    if (options.color != null) body.color = options.color;
    if (options.match != null) body.match = options.match;
    if (options.matching_algorithm != null) body.matching_algorithm = options.matching_algorithm;
    if (options.is_insensitive != null) body.is_insensitive = options.is_insensitive;
    return post<Tag>(TAGS_PATH, body);
}
