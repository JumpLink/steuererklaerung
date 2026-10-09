/**
 * Beleg ⇄ Buchung link suggestions, entity-scoped (the I/O layer over the pure scorer in
 * lib/transactions/link-candidates.ts). Resolves a workspace entity to its store accounts + DMS
 * back-end, loads the two pools inside a date window, and returns ranked {@link LinkCandidate}s.
 *
 * Read-only: the WRITE side (recording the link) is the DMS provider's own `link()` — the built-in
 * DMS writes the `document_links` table, Paperless appends the `qonto_transaction_id` field — plus
 * the richer automated path {@link reconcileDocumentToStore}. Shared by the CLI, the MCP tools and
 * the native app's data layer so the heuristic lives in exactly one place.
 */

import { searchAccountKeys, transactionsSummary, type UnifiedTransaction } from '@steuererklaerung/store';
import { type DmsDocument, type DmsProvider } from '@steuererklaerung/dms';
import { dmsProviderForEntity } from '../dms-provider.ts';
import { shiftDate } from '@steuererklaerung/shared';
import { createAppContext } from '../context.ts';
import { loadManifest, resolveWorkspaceEntities } from '../config/index.ts';
import {
    suggestDocumentsForTransaction,
    suggestTransactionsForDocument,
    type LinkCandidate,
    type LinkCandidateOptions,
} from '../lib/transactions/link-candidates.ts';
import { assertTxPeriodUnlocked } from '../lib/ledger/period-guard.ts';
import { filterDocuments } from '../presenters/belege.ts';

export type { LinkCandidate, LinkCandidateOptions } from '../lib/transactions/link-candidates.ts';

/** How far either side of the anchor date to pull the opposite pool (payments lag invoices by weeks). */
const WINDOW_DAYS = 92;

interface ResolvedEntity {
    accountKeys: string[];
    provider: DmsProvider;
}

/**
 * Resolve a workspace entity id to its store account keys + configured DMS provider — shared with
 * the sibling write actions (beleg-review, auto-link) so the entity → DMS resolution stays in one place.
 */
export function resolveEntityDms(entityId: string, path?: string): ResolvedEntity {
    return resolveEntity(entityId, path);
}

/** Resolve a workspace entity id to its store account keys + configured DMS provider. */
function resolveEntity(entityId: string, path?: string): ResolvedEntity {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const resolved = resolveWorkspaceEntities(storeKeys, loadManifest(path));
    const entity = resolved.find((e) => e.id === entityId);
    const accountKeys = entity?.accountKeys ?? [];
    const provider = dmsProviderForEntity(entityId, entity?.dms, createAppContext().config);
    return { accountKeys, provider };
}

/** The store transaction with this id among the entity's accounts, or undefined. */
function findEntityTransaction(accountKeys: string[], txId: string): UnifiedTransaction | undefined {
    return searchAccountKeys(accountKeys).find((t) => t.id === txId);
}

/**
 * Suggest invoice **documents** that could be the receipt for one of the entity's bank transactions
 * (best first). The reverse of the automated reconcile write — powers the "Offene Belege → Verknüpfen"
 * worklist: pick the receipt for an expense that has none.
 */
export async function suggestDocumentLinksForTransaction(
    entityId: string,
    txId: string,
    options: LinkCandidateOptions & { path?: string } = {},
): Promise<LinkCandidate[]> {
    const { accountKeys, provider } = resolveEntity(entityId, options.path);
    const tx = findEntityTransaction(accountKeys, txId);
    if (!tx) return [];
    const docs = await provider.list({
        from: shiftDate(tx.bookingDate, -WINDOW_DAYS),
        to: shiftDate(tx.bookingDate, WINDOW_DAYS),
    });
    return suggestDocumentsForTransaction(tx, docs, options);
}

/**
 * Suggest store **transactions** that could be the payment for an invoice document (best first) —
 * the inverse direction, for a document-centric surface or external AI.
 */
export async function suggestTransactionLinksForDocument(
    entityId: string,
    documentId: string,
    options: LinkCandidateOptions & { path?: string } = {},
): Promise<LinkCandidate[]> {
    const { accountKeys, provider } = resolveEntity(entityId, options.path);
    const doc: DmsDocument | null = await provider.get(documentId);
    if (!doc) return [];
    const anchor = doc.created ?? undefined;
    const range = anchor ? { from: shiftDate(anchor, -WINDOW_DAYS), to: shiftDate(anchor, WINDOW_DAYS) } : {};
    const txs = searchAccountKeys(accountKeys, range);
    return suggestTransactionsForDocument(doc, txs, options);
}

/**
 * Find documents to link BY SEARCH, ignoring the ±92-day window.
 *
 * `suggestDocumentLinksForTransaction` only ever looks inside that window, and only ever ranks by
 * heuristic. Both are right for the common case and wrong for the one a user actually gets stuck
 * on: a receipt filed months late, an annual invoice paid in instalments, a booking whose
 * correspondent bears no resemblance to the vendor on the paper. When the heuristic finds nothing
 * there is currently NO way to say "it is this one" — which is precisely the moment a person knows
 * the answer and the machine does not.
 *
 * So: the window stays as a PRE-SORT for the suggestion path, and this is the escape hatch. The
 * search covers title, correspondent, invoice number, OCR text and tags (the shared
 * `filterDocuments`), across the given range.
 *
 * `onlyUnlinked` defaults to true — a receipt already attached to another booking is almost never
 * the answer, and showing it invites attaching one invoice to two expenses.
 */
export async function searchLinkableDocuments(
    entityId: string,
    query: string,
    options: { from?: string; to?: string; onlyUnlinked?: boolean; limit?: number; path?: string } = {},
): Promise<DmsDocument[]> {
    const { provider } = resolveEntity(entityId, options.path);
    const from = options.from ?? '1970-01-01';
    const to = options.to ?? '2999-12-31';
    const docs = await provider.list({ from, to });
    const matched = filterDocuments(docs, {
        query,
        linked: options.onlyUnlinked === false ? undefined : 'no',
    });
    // Newest first: a receipt someone is hunting for is far more often recent than not.
    matched.sort((a, b) => ((a.created ?? '') < (b.created ?? '') ? 1 : -1));
    return matched.slice(0, options.limit ?? 50);
}

/**
 * Record the link between a document and a store transaction via the entity's DMS provider — the
 * authoritative mechanism the reconciliation reads (built-in: `document_links`; Paperless:
 * `qonto_transaction_id`). Idempotent; returns the document's resulting linked-transaction set.
 */
export async function linkDocumentToTransaction(
    entityId: string,
    documentId: string,
    txId: string,
    options: { path?: string } = {},
): Promise<{ documentId: string; linkedTxIds: string[] }> {
    const { provider } = resolveEntity(entityId, options.path);
    if (!provider.link) throw new Error('Dieses DMS unterstützt das Verknüpfen nicht.');
    // GoBD: guarded HERE so the lock holds for every back-end (Paperless has no ledger access).
    assertTxPeriodUnlocked(txId, 'Verknüpfen');
    await provider.link(documentId, txId);
    const doc = await provider.get(documentId);
    return { documentId, linkedTxIds: doc?.linkedTxIds ?? [txId] };
}

/**
 * Remove the link between a document and a store transaction (the inverse of
 * {@link linkDocumentToTransaction}) — the Undo write behind the review flow's Undo-Toast.
 * Idempotent; returns the document's remaining linked-transaction set.
 */
export async function unlinkDocumentFromTransaction(
    entityId: string,
    documentId: string,
    txId: string,
    options: { path?: string } = {},
): Promise<{ documentId: string; linkedTxIds: string[] }> {
    const { provider } = resolveEntity(entityId, options.path);
    if (!provider.unlink) throw new Error('Dieses DMS unterstützt das Entknüpfen nicht.');
    // GoBD: guarded HERE so the lock holds for every back-end (Paperless has no ledger access).
    assertTxPeriodUnlocked(txId, 'Entknüpfen');
    await provider.unlink(documentId, txId);
    const doc = await provider.get(documentId);
    return { documentId, linkedTxIds: doc?.linkedTxIds ?? [] };
}
