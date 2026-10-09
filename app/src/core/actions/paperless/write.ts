/**
 * Write Paperless-NGX API actions for CLI commands: correct a document's metadata
 * (title / type / correspondent / created date / tags) and trash (delete) a document.
 * Thin wrappers over the client; the command layer handles input parsing and output.
 */

import {
    updateDocument,
    deleteDocument,
    getDocument,
    mergeCustomFields,
    type UpdateDocumentPayload,
} from '@steuererklaerung/paperless';
import { loadPaperlessConfig, type SyncConfig } from '../../config/index.ts';
import { resolveCustomFieldEntries } from '../../lib/custom-fields.ts';

/**
 * Patch a single document's metadata. Only the provided fields are changed
 * (Paperless PATCH semantics) — pass `null` to clear correspondent/type/created.
 */
export async function paperlessUpdateDocument(id: number, payload: UpdateDocumentPayload) {
    return updateDocument(id, payload);
}

/**
 * Update a document's metadata AND custom fields, addressing custom fields by friendly name
 * (e.g. { data_scope: 'privat', ai_note: '…' }). Read-modify-write: merges the resolved values
 * into the document's existing custom fields so untouched fields are preserved. Use to correct
 * or enrich a document that is already in Paperless.
 */
export async function paperlessUpdateDocumentFields(
    id: number,
    opts: { payload?: UpdateDocumentPayload; customFields?: Record<string, unknown>; config?: SyncConfig },
) {
    const payload: UpdateDocumentPayload = { ...opts.payload };
    if (opts.customFields && Object.keys(opts.customFields).length > 0) {
        const config = opts.config ?? loadPaperlessConfig();
        const doc = await getDocument(id);
        const entries = resolveCustomFieldEntries(opts.customFields, config);
        payload.custom_fields = mergeCustomFields(doc.custom_fields ?? [], entries);
    }
    return updateDocument(id, payload);
}

/**
 * Move a document to the Paperless trash (soft delete — restorable for the
 * configured retention window). Used to drop the worse copy of a duplicate scan.
 */
export async function paperlessTrashDocument(id: number): Promise<{ id: number; trashed: true }> {
    await deleteDocument(id);
    return { id, trashed: true };
}
