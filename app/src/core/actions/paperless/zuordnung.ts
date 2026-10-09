/**
 * Which Paperless rule assigned a document's correspondent, type and tags — loaded from Paperless,
 * explained by `dokumentregeln/paperless-erklaerung.ts` (Idee 11). Read-only: Paperless keeps doing
 * the matching, the app only shows which rule applied.
 */

import {
    getDocument,
    listCorrespondents,
    listDocumentTypes,
    listTags,
    resolvePaperlessConfig,
    type PaperlessConfig,
    type PaperlessCreds,
} from '@steuererklaerung/paperless';
import {
    erklaereZuordnung,
    zuordnungKopf,
    type PaperlessKatalog,
    type PaperlessMatchObjekt,
    type PaperlessZuordnung,
} from '../../dokumentregeln/paperless-erklaerung.ts';
import { resolveWorkspaceEntities } from '../../config/accessors.ts';

export interface PaperlessZuordnungResult {
    documentId: number;
    /** The line to show first. */
    kopf: string;
    eintraege: PaperlessZuordnung[];
}

interface Page<T> {
    results: T[];
    next: string | null;
}

/** All pages of a list endpoint; Paperless pages at 100 at most. */
async function alle<T>(fetchPage: (page: number) => Promise<Page<T>>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
        const resp = await fetchPage(page);
        out.push(...resp.results);
        if (!resp.next || resp.results.length === 0) break;
    }
    return out;
}

/** Correspondents, types and tags with their rules — the catalogue is small (hundreds), so all pages. */
export async function loadPaperlessKatalog(cfg?: PaperlessConfig): Promise<PaperlessKatalog> {
    const [correspondents, documentTypes, tags] = await Promise.all([
        alle<PaperlessMatchObjekt>((page) => listCorrespondents({ page, page_size: 100 }, cfg)),
        alle<PaperlessMatchObjekt>((page) => listDocumentTypes({ page, page_size: 100 }, cfg)),
        alle<PaperlessMatchObjekt>((page) => listTags({ page, page_size: 100 }, cfg)),
    ]);
    return { correspondents, documentTypes, tags };
}

/** Explain one document. `creds` selects a per-entity Paperless instance; omitted = the env default. */
export async function paperlessZuordnung(
    documentId: number,
    creds?: PaperlessCreds,
): Promise<PaperlessZuordnungResult> {
    const cfg = creds && (creds.url || creds.token) ? resolvePaperlessConfig(creds).config : undefined;
    const [doc, katalog] = await Promise.all([getDocument(documentId, cfg), loadPaperlessKatalog(cfg)]);
    const eintraege = erklaereZuordnung(doc, katalog);
    return { documentId, kopf: zuordnungKopf(eintraege), eintraege };
}

/** Explain a document of an entity's own Paperless instance (its URL/token from the manifest, else the env default). */
export async function paperlessZuordnungForEntity(
    entityId: string,
    documentId: number,
): Promise<PaperlessZuordnungResult> {
    const entity = resolveWorkspaceEntities([]).find((e) => e.id === entityId);
    if (!entity) throw new Error(`Unbekannte Entität '${entityId}'.`);
    if (entity.dms?.type !== 'paperless') throw new Error(`Entität '${entityId}' nutzt kein Paperless.`);
    return paperlessZuordnung(documentId, entity.dms.paperless);
}
