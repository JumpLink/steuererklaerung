/**
 * Document-type-specific handlers for review-metadata.
 * Each handler can enrich a document (e.g. invoice field extraction) and returns additional payload to merge.
 */

import type { Document, UpdateDocumentPayload } from '@steuererklaerung/paperless';
import type { SyncConfig } from '../../config/index.ts';
import { runInvoiceExtractionForDocument } from './extract-invoice.ts';

export type DocumentTypeHandler = (doc: Document, config: SyncConfig) => Promise<Partial<UpdateDocumentPayload> | null>;

/**
 * Build the registry of document type ID -> handler. Only includes types that have a handler and a valid config ID.
 */
export function getDocumentTypeHandlers(config: SyncConfig): Map<number, DocumentTypeHandler> {
    const map = new Map<number, DocumentTypeHandler>();
    const incomingId = config.document_type_ids.incoming_invoice;
    const outgoingId = config.document_type_ids.outgoing_invoice;
    if (incomingId > 0) {
        map.set(incomingId, async (doc, cfg) => {
            const result = await runInvoiceExtractionForDocument(doc, cfg, 'incoming_invoice');
            return result?.payload ?? null;
        });
    }
    if (outgoingId > 0) {
        map.set(outgoingId, async (doc, cfg) => {
            const result = await runInvoiceExtractionForDocument(doc, cfg, 'outgoing_invoice');
            return result?.payload ?? null;
        });
    }
    return map;
}
