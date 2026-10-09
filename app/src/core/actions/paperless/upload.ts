/**
 * Upload a local file into Paperless-NGX with metadata, then enrich its custom fields.
 *
 * Two-step by design: `postDocument` starts an async consumption task (OCR + archive), so we
 * poll `waitForTaskResult` for the created document ID and only then PATCH the custom fields via
 * `updateDocument` — the same unversioned-serializer path the enrichment workflow already uses
 * for select fields (see the Accept-header note in `@steuererklaerung/paperless` request.ts). Thin
 * wrapper over the client; the CLI and MCP tool are adapters over this.
 *
 * Correspondent and tags may be given by name (create-or-reuse, case-insensitive) so a document
 * from a not-yet-known sender uploads in one step instead of a separate create round-trip.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
    postDocument,
    updateDocument,
    waitForTaskResult,
    listCorrespondents,
    createCorrespondent,
    listTags,
    createTag,
    fetchAllPages,
} from '@steuererklaerung/paperless';
import { loadPaperlessConfig, type SyncConfig } from '../../config/index.ts';
import { resolveCustomFieldEntries } from '../../lib/custom-fields.ts';

export interface UploadDocumentInput {
    /** Absolute or cwd-relative path to the file to upload. */
    filePath: string;
    title?: string;
    /** Document date, YYYY-MM-DD. */
    created?: string;
    correspondentId?: number;
    /** Correspondent by name — reused if it exists (case-insensitive), else created. */
    correspondentName?: string;
    documentTypeId?: number;
    /** Tag IDs to attach on upload. */
    tagIds?: number[];
    /** Tag names to attach — each reused if it exists (case-insensitive), else created. */
    tagNames?: string[];
    /** Friendly custom-field names → values (e.g. { data_scope: 'privat', ai_note: '…' }). */
    customFields?: Record<string, unknown>;
    /** Max wait for the consumption task, ms (default 180000). */
    timeoutMs?: number;
}

export interface UploadDocumentResult {
    taskId: string;
    documentId: number;
    /** True if this upload created the document; false if Paperless detected a duplicate. */
    created: boolean;
    filename: string;
    correspondentId?: number;
    tagIds: number[];
    customFieldsApplied: string[];
}

/** Find a correspondent by name (case-insensitive) or create it; returns its id. */
async function resolveCorrespondentId(name?: string, explicitId?: number): Promise<number | undefined> {
    if (explicitId != null) return explicitId;
    const wanted = name?.trim();
    if (!wanted) return undefined;
    const all = await fetchAllPages((page, page_size) => listCorrespondents({ page, page_size }));
    const found = all.find((c) => c.name?.trim().toLowerCase() === wanted.toLowerCase());
    return found ? found.id : (await createCorrespondent({ name: wanted })).id;
}

/** Merge tag IDs with tag names (each reused or created); returns a de-duplicated id list. */
async function resolveTagIds(tagIds: number[] = [], tagNames: string[] = []): Promise<number[]> {
    const wanted = tagNames.map((n) => n.trim()).filter(Boolean);
    if (wanted.length === 0) return [...new Set(tagIds)];
    const all = await fetchAllPages((page, page_size) => listTags({ page, page_size }));
    const ids = [...tagIds];
    for (const name of wanted) {
        const found = all.find((t) => t.name?.trim().toLowerCase() === name.toLowerCase());
        ids.push(found ? found.id : (await createTag({ name })).id);
    }
    return [...new Set(ids)];
}

/**
 * Upload `input.filePath` to Paperless and set its custom fields. Resolves the consumption task to
 * a document ID (or the existing duplicate) and applies friendly custom-field values afterwards.
 */
export async function paperlessUploadDocument(
    input: UploadDocumentInput,
    cfg?: SyncConfig,
): Promise<UploadDocumentResult> {
    const config = cfg ?? loadPaperlessConfig();
    const bytes = readFileSync(input.filePath);
    const filename = basename(input.filePath);

    const correspondentId = await resolveCorrespondentId(input.correspondentName, input.correspondentId);
    const tagIds = await resolveTagIds(input.tagIds, input.tagNames);

    let taskId: string;
    try {
        taskId = await postDocument(bytes, filename, {
            title: input.title,
            created: input.created,
            correspondent: correspondentId,
            document_type: input.documentTypeId,
            tags: tagIds.length > 0 ? tagIds : undefined,
        });
    } catch (err) {
        // Paperless answers a rejected file type with the SNIFFED MIME type and nothing else
        // ("File type text/xml not supported"), which reads like a wrong header and invites the
        // one fix that cannot work: renaming the file. The server runs libmagic over the CONTENT,
        // so an ELSTER response saved as `.txt` still sniffs as text/xml and is still refused.
        // Say that here, where the reader is looking, instead of leaving them to discover it.
        const msg = err instanceof Error ? err.message : String(err);
        if (/File type .* not supported/i.test(msg)) {
            const sniffed = msg.match(/File type ([\w.+/-]+) not supported/i)?.[1] ?? 'unbekannt';
            throw new Error(
                `Paperless lehnt den Dateityp ab: ${sniffed} (${filename}).\n` +
                    '  Der Server erkennt den Typ am INHALT (libmagic) und ignoriert die Endung —\n' +
                    '  Umbenennen hilft daher nicht. Akzeptiert werden u. a. PDF, Bilder und text/plain.\n' +
                    '  Für maschinelle XML (ELSTER-Daten, Serverantworten): einen lesbaren Text-Nachweis\n' +
                    '  ablegen und die Roh-XML neben der Abgabe behalten — im DMS ist der Text ohnehin\n' +
                    '  das nützlichere Dokument, weil er durchsuchbar ist.',
            );
        }
        throw err;
    }

    const { documentId, created } = await waitForTaskResult(taskId, {
        timeoutMs: input.timeoutMs ?? 180_000,
    });

    const applied: string[] = [];
    if (input.customFields && Object.keys(input.customFields).length > 0) {
        const entries = resolveCustomFieldEntries(input.customFields, config);
        if (entries.length > 0) {
            await updateDocument(documentId, { custom_fields: entries });
            applied.push(...Object.keys(input.customFields));
        }
    }

    return { taskId, documentId, created, filename, correspondentId, tagIds, customFieldsApplied: applied };
}
