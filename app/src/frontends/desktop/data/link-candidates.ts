/**
 * Beleg ⇄ Buchung linking for the native app — thin adapters over the shared core action
 * (core/actions/link-candidates.ts). `loadLinkCandidates` ranks the receipts that could belong to an
 * expense on the "Offene Belege" worklist; `linkDocument` records the chosen link through the
 * entity's DMS provider (the same field the reconciliation reads, so the item leaves "offen").
 */

import {
    linkDocumentToTransaction,
    searchLinkableDocuments,
    suggestDocumentLinksForTransaction,
    suggestTransactionLinksForDocument,
    unlinkDocumentFromTransaction,
    type LinkCandidate,
} from '../../../core/actions/link-candidates.ts';
import type { DmsDocument } from '../../../core/presenters/belege.ts';
import type { AppEntity } from '../entities.ts';
import { appSession } from './session.ts';

export type { LinkCandidate } from '../../../core/actions/link-candidates.ts';

/** Which side is fixed: suggest documents for a transaction, or transactions for a document. */
export type LinkRef = { transactionId: string } | { documentId: string };

/** Scored link candidates for the given anchor (transaction → receipts, or document → payments). */
export async function loadLinkCandidates(entity: AppEntity, ref: LinkRef): Promise<LinkCandidate[]> {
    return 'transactionId' in ref
        ? suggestDocumentLinksForTransaction(entity.id, ref.transactionId)
        : suggestTransactionLinksForDocument(entity.id, ref.documentId);
}

/** Link a document to a store transaction; resolves to the document's resulting linked-tx set. */
export async function linkDocument(
    entity: AppEntity,
    documentId: string,
    txId: string,
): Promise<{ documentId: string; linkedTxIds: string[] }> {
    const result = await linkDocumentToTransaction(entity.id, documentId, txId);
    // A freshly linked receipt must leave the Eingang on reload, and the booking (now source='document')
    // can move the EÜR/USt — invalidate the entity's session caches (aggregate + documents) so the queue
    // + tax figures recompute (before this the queue showed the just-linked receipt stale).
    appSession().invalidate(entity.id);
    return result;
}

/**
 * Free-text search for a document to link, past the heuristic window.
 *
 * The suggestion path only looks ±92 days around the booking and only ranks by heuristic. Both are
 * right most of the time and useless in exactly the case a user gets stuck on — a receipt filed
 * months late, or a vendor whose name on the paper is nothing like the one on the bank statement.
 * That is the moment a person knows the answer and the machine does not, and until now there was no
 * way to say so.
 */
export async function searchDocuments(entity: AppEntity, query: string): Promise<DmsDocument[]> {
    return searchLinkableDocuments(entity.id, query, { limit: 40 });
}

/** Remove a document ⇄ transaction link. GoBD-guarded in the core. */
export async function unlinkDocument(entity: AppEntity, documentId: string, txId: string): Promise<void> {
    await unlinkDocumentFromTransaction(entity.id, documentId, txId);
}
