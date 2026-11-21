import type { Document } from './paperless.ts';
import { namesFor } from './lookup.ts';

export interface DocumentDetail {
    title: string;
    correspondent: string;
    created: string;
    tags: string[];
}

/** What the detail page shows; ids are resolved through the cached lookup tables. */
export function documentDetail(doc: Document, tagNames: Map<number, string>, correspondentNames: Map<number, string>): DocumentDetail {
    return {
        title: doc.title?.trim() || doc.original_file_name || `#${doc.id}`,
        correspondent: doc.correspondent == null ? '' : (correspondentNames.get(doc.correspondent) ?? `#${doc.correspondent}`),
        created: (doc.created ?? doc.added ?? '').slice(0, 10),
        tags: namesFor(doc.tags, tagNames),
    };
}
