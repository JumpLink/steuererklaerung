/**
 * Slim Paperless-ngx client for the phone: list, tags, inbox (tag "Neu"), upload.
 * Same wire contract as packages/paperless (API version pinned to 9) without its
 * Buffer / @steuererklaerung/shared / process.env dependencies.
 */
import { buildMultipart } from './multipart.ts';
import { buildQuery, requestJson } from './http.ts';
import { cachedOnce, nameMap, type Named } from './lookup.ts';

export const PAPERLESS_API_VERSION = '9';
const TIMEOUT_MS = 60_000;
export const INBOX_TAG = 'Neu';

export interface PaperlessCreds {
    url: string;
    token: string;
}
export interface Tag { id: number; name: string }
export interface Document {
    id: number;
    title: string | null;
    tags: number[];
    correspondent?: number | null;
    created: string | null;
    added: string | null;
    original_file_name: string | null;
}
export interface Page<T> { count: number; next: string | null; results: T[] }
export interface UploadOptions { title?: string; tags?: number[]; created?: string }

export function contentTypeForFilename(name: string): string {
    switch (name.toLowerCase().split('.').pop()) {
        case 'pdf': return 'application/pdf';
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'tif':
        case 'tiff': return 'image/tiff';
        default: return 'application/octet-stream';
    }
}

export function uploadFields(o: UploadOptions = {}): Array<[string, string]> {
    const f: Array<[string, string]> = [];
    if (o.title != null) f.push(['title', o.title]);
    if (o.created != null) f.push(['created', o.created]);
    for (const t of o.tags ?? []) f.push(['tags', String(t)]);
    return f;
}

export function createPaperlessClient(creds: PaperlessCreds) {
    const base = creds.url.replace(/\/$/, '');
    const auth = { Accept: `application/json; version=${PAPERLESS_API_VERSION}`, Authorization: `Token ${creds.token}` };
    const get = <T>(path: string, q: Record<string, unknown> = {}) =>
        requestJson<T>(`${base}${path}${buildQuery(q)}`, { method: 'GET', headers: auth }, TIMEOUT_MS, 'Paperless');

    let inboxTagId: number | undefined;
    const listTags = async (): Promise<Tag[]> => (await get<Page<Tag>>('/api/tags/', { page_size: 500 })).results;
    const listCorrespondents = async (): Promise<Named[]> =>
        (await get<Page<Named>>('/api/correspondents/', { page_size: 500 })).results;
    return {
        listTags,
        listCorrespondents,
        /** id → name tables, fetched once per client. */
        tagNames: cachedOnce(async () => nameMap(await listTags())),
        correspondentNames: cachedOnce(async () => nameMap(await listCorrespondents())),
        listDocuments: (p: { page?: number; page_size?: number; ordering?: string; tag_ids?: number[]; query?: string } = {}) =>
            get<Page<Document>>('/api/documents/', {
                page: p.page,
                page_size: p.page_size ?? 25,
                ordering: p.ordering ?? '-added',
                query: p.query,
                tags__id__in: p.tag_ids?.length ? p.tag_ids.join(',') : undefined,
            }),
        /** Documents carrying the inbox tag; empty page when the tag does not exist. */
        async listInbox(page = 1): Promise<Page<Document>> {
            inboxTagId ??= (await listTags()).find((t) => t.name === INBOX_TAG)?.id;
            const tag = inboxTagId == null ? undefined : { id: inboxTagId };
            if (!tag) return { count: 0, next: null, results: [] };
            return get<Page<Document>>('/api/documents/', { tags__id__all: tag.id, page, page_size: 25, ordering: '-added' });
        },
        /** Returns the consume task id (Paperless answers with a bare JSON string). */
        uploadDocument(filename: string, bytes: Uint8Array, o: UploadOptions = {}): Promise<string> {
            const mp = buildMultipart(uploadFields(o), 'document', filename, bytes, contentTypeForFilename(filename));
            return requestJson<string>(
                `${base}/api/documents/post_document/`,
                { method: 'POST', headers: { ...auth, 'Content-Type': mp.contentType }, body: mp.body },
                TIMEOUT_MS,
                'Paperless',
            );
        },
    };
}
