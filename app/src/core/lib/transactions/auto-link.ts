/**
 * "Automatisch zuordnen" planning — which open bookings can be linked to a receipt WITHOUT a human,
 * i.e. only the unambiguous hits. Pure + deterministic (no I/O): given the gap bookings and the
 * period's document pool it returns the planned links plus what stays for hand-review, so the UI
 * can preview (dry-run) and then execute exactly this plan.
 *
 * The confidence gate applies {@link pickBestMatch}'s "nur eindeutige Treffer" rule (raw minScore 60,
 * minLead 15) on the RAW reconcile scores — never on the clamped 0..1 display score, which erases
 * the winner's lead exactly for the strongest matches. Claiming is greedy-chronological like
 * {@link reconcileStoreBatch}: one receipt backs at most one booking, early bookings claim first.
 */

import type { DmsDocument } from '@steuererklaerung/dms';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
  suggestDocumentsForTransaction,
  suggestTransactionsForDocument,
  type LinkCandidate,
  type LinkCandidateOptions,
} from './link-candidates.ts';

/** One planned (or executed) automatic link: this booking gets this receipt. */
export interface AutoLinkPair {
  txId: string;
  documentId: string;
  /** Confidence 0..1 (normalised reconcile score of the winning receipt) — display only. */
  score: number;
  /** German match reasons, e.g. ['Betrag exakt', 'gleiches Datum']. */
  reasons: string[];
  bookingDate: string;
  counterparty?: string;
  docTitle?: string;
  docCorrespondent?: string;
}

export interface AutoLinkPlan {
  /** Unambiguous hits — safe to write. */
  planned: AutoLinkPair[];
  /** Booking ids with candidates too close to call — stay for hand-review. */
  ambiguous: string[];
  /** Booking ids with no candidate receipt at all. */
  unmatched: string[];
}

/** {@link pickBestMatch}'s thresholds on the RAW reconcile score. */
const MIN_SCORE_RAW = 60;
const MIN_LEAD_RAW = 15;

/** pickBestMatch's rule for two ranked candidates: a clear winner, judged on raw scores. */
export function isConfidentPair(best: LinkCandidate | undefined, second: LinkCandidate | undefined): boolean {
  if (!best) return false;
  return best.rawScore >= MIN_SCORE_RAW && (second == null || best.rawScore - second.rawScore >= MIN_LEAD_RAW);
}

/**
 * Plan the automatic links for the given gap bookings against the period's receipt pool.
 * Only free receipts (no linked booking) are considered; a receipt claimed by an earlier booking
 * is gone for later ones. Bookings are processed chronologically regardless of input order.
 *
 * "Eindeutig" is required in BOTH directions (mutual best match): the receipt must be the booking's
 * clear winner AND the booking must be the receipt's best payment — else an early booking could
 * steal a recurring vendor's receipt from the later booking it actually belongs to. The doc-side
 * check runs over `allTxs` when given (ideally EVERY entity booking in the window, so a receipt
 * whose true payment lies outside the gap set is not mispaired), falling back to the gap set.
 */
export function planAutoLinks(
  txs: UnifiedTransaction[],
  docs: DmsDocument[],
  options: LinkCandidateOptions & { allTxs?: UnifiedTransaction[] } = {},
): AutoLinkPlan {
  const planned: AutoLinkPair[] = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];

  let pool = docs.filter((d) => d.linkedTxIds.length === 0);
  const ordered = [...txs].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  const { allTxs, ...candidateOptions } = options;
  const mutualPool = allTxs ?? ordered;

  for (const tx of ordered) {
    // Top candidate + runner-up are enough for the confidence gate.
    const [best, second] = suggestDocumentsForTransaction(tx, pool, { ...candidateOptions, limit: 2 });
    if (!best?.documentId) {
      unmatched.push(tx.id);
      continue;
    }
    const doc = pool.find((d) => d.id === best.documentId);
    // Mutual check: the receipt's best payment must be THIS booking (conservative: judged against
    // the widest known booking pool, even bookings already planned elsewhere).
    const [docsBest] = doc
      ? suggestTransactionsForDocument(doc, mutualPool, { ...candidateOptions, limit: 1 })
      : [];
    if (!isConfidentPair(best, second) || !doc || (docsBest != null && docsBest.transactionId !== tx.id)) {
      ambiguous.push(tx.id);
      continue;
    }
    planned.push({
      txId: tx.id,
      documentId: best.documentId,
      score: best.score,
      reasons: best.reasons,
      bookingDate: tx.bookingDate,
      counterparty: tx.counterparty ?? undefined,
      docTitle: doc.title ?? undefined,
      docCorrespondent: doc.correspondent ?? undefined,
    });
    pool = pool.filter((d) => d.id !== best.documentId); // claimed — gone for later bookings
  }

  return { planned, ambiguous, unmatched };
}
