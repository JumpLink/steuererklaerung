/**
 * Paperless-NGX API – Correspondents.
 * List, get, and create correspondents (e.g. for document metadata and review-metadata).
 */

import { get, post, type PaperlessConfig } from './request.ts';
import type { Correspondent, PaginatedCorrespondents, CreateCorrespondentOptions } from './types.ts';

const CORRESPONDENTS_PATH = '/api/correspondents/';

export interface ListCorrespondentsParams {
    page_size?: number;
    page?: number;
}

/**
 * List all correspondents (paginated). Use to resolve correspondent IDs for config and AI review.
 * Pass `cfg` (from resolvePaperlessConfig) to target a specific instance; omit for the env default.
 */
export async function listCorrespondents(
    params: ListCorrespondentsParams = {},
    cfg?: PaperlessConfig,
): Promise<PaginatedCorrespondents> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedCorrespondents>(CORRESPONDENTS_PATH, query, cfg);
}

/**
 * Get a single correspondent by ID.
 */
export async function getCorrespondent(id: number): Promise<Correspondent> {
    return get<Correspondent>(`/api/correspondents/${id}/`);
}

/**
 * Create a correspondent. Returns the created correspondent including its ID.
 */
export async function createCorrespondent(options: CreateCorrespondentOptions): Promise<Correspondent> {
    const body: Record<string, unknown> = { name: options.name };
    if (options.match != null) body.match = options.match;
    if (options.matching_algorithm != null) body.matching_algorithm = options.matching_algorithm;
    if (options.is_insensitive != null) body.is_insensitive = options.is_insensitive;
    return post<Correspondent>(CORRESPONDENTS_PATH, body);
}
