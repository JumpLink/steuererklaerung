/**
 * Beleg ⇄ Buchung linking: score which document belongs to a bank transaction (and vice-versa).
 *
 * This is the *worklist* counterpart to {@link ./reconcile.ts}: the "Offene Belege" surface lists
 * expense transactions that claim Vorsteuer but have no linked receipt, and lets the user attach the
 * invoice that belongs to one. Rather than duplicate the amount/date/reference heuristics, both
 * directions delegate to {@link findStoreMatches} — the same, unit-tested reconcile engine — and only
 * translate a {@link DmsDocument} into its {@link DocMatchCriteria} and the raw match into a compact,
 * German-labelled {@link LinkCandidate} for the UI.
 *
 * Pure + deterministic (no I/O, no AI): given the two pools it returns ranked candidates, so it is
 * unit-testable and reused by the CLI, the MCP tools and the native app. An AI re-rank could be
 * layered on top as an OPTIONAL booster (score the top-N against the document's OCR text), but it is
 * deliberately not required here — the heuristics alone resolve the common cases.
 */

import type { DmsDocument } from '@steuererklaerung/dms';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { eur } from '../format.ts';
import {
  findStoreMatches,
  type DocMatchCriteria,
  type InvoiceDirection,
  type StoreMatchCandidate,
  type StoreMatchOptions,
} from './reconcile.ts';

/**
 * One scored link candidate. Exactly one of {@link documentId} / {@link transactionId} is set,
 * naming the *other* side of the proposed link:
 *  - suggesting documents for a transaction → {@link documentId} is set,
 *  - suggesting transactions for a document → {@link transactionId} is set.
 */
export interface LinkCandidate {
  /** Candidate document id (set when suggesting documents for a transaction). */
  documentId?: string;
  /** Candidate store transaction id (set when suggesting transactions for a document). */
  transactionId?: string;
  /** Confidence in 0..1 (normalised from the reconcile engine's ~0..160 raw score) — display only. */
  score: number;
  /** The reconcile engine's RAW score (~0..160). Confidence gates (pickBestMatch's minScore 60 /
   *  minLead 15) MUST use this: the display normalisation clamps at 100 and erases the winner's
   *  lead exactly for the strongest matches. */
  rawScore: number;
  /** Human, German match reasons, e.g. `['Betrag exakt', 'gleiches Datum', 'Korrespondent ähnlich']`. */
  reasons: string[];
  /** Gross amount of the candidate side (document gross, or the transaction's signed amount). */
  amount: number;
  /** Date of the candidate side (document date, or the transaction's booking date), YYYY-MM-DD. */
  date: string;
  /** Correspondent / counterparty of the candidate side, if known. */
  counterparty?: string;
  /** Document title, when the candidate is a document (for a richer row). */
  title?: string;
}

export interface LinkCandidateOptions extends StoreMatchOptions {
  /** Max candidates returned (best-first). Default 8. */
  limit?: number;
  /**
   * When suggesting documents for a transaction: skip documents that are already linked to some
   * transaction (they back another payment). Default true — the worklist offers the *free* receipts.
   */
  excludeLinked?: boolean;
}

const DEFAULT_LIMIT = 8;

/** Map a reconcile score (~0..160) into a 0..1 confidence for display. */
function normaliseScore(raw: number): number {
  return Math.max(0, Math.min(1, raw / 100));
}

/**
 * Translate the reconcile engine's structured match into compact German reasons. Reuses the raw
 * candidate's `amountDiff`/`dayGap` and only re-reads the English marker reasons for the boolean
 * name/reference/currency signals — no heuristic is re-implemented here.
 */
function germanReasons(c: StoreMatchCandidate): string[] {
  const out: string[] = [];
  const isFx = c.reasons.some((r) => r.startsWith('fx:'));
  if (isFx) out.push('Fremdwährung — Betrag aus Buchung');
  else if (Math.abs(c.amountDiff) <= 0.005) out.push('Betrag exakt');
  else out.push(`Betrag ± ${eur(Math.abs(c.amountDiff))}`);

  if (c.dayGap == null) out.push('kein Belegdatum');
  else if (c.dayGap === 0) out.push('gleiches Datum');
  else {
    const days = Math.abs(c.dayGap);
    out.push(`Datum ${days} Tag${days === 1 ? '' : 'e'} ${c.dayGap > 0 ? 'nach' : 'vor'} Beleg`);
  }

  if (c.reasons.includes('counterparty name match')) out.push('Korrespondent ähnlich');
  if (c.reasons.includes('invoice no. in reference')) out.push('Rechnungsnr. im Zweck');
  if (c.reasons.some((r) => r.startsWith('currency mismatch'))) out.push('Währung weicht ab');
  return out;
}

/** Gross amount of a DMS document (gross, else net + vat), always positive; null if unknown. */
function grossOf(doc: DmsDocument): number | null {
  if (doc.gross != null) return Math.abs(doc.gross);
  if (doc.net != null) return Math.abs(doc.net) + Math.abs(doc.vat ?? 0);
  return null;
}

/**
 * Build the reconcile {@link DocMatchCriteria} from a back-end-agnostic {@link DmsDocument}. Returns
 * null when the document can't be matched on amount (no direction / no gross) — the caller skips it.
 */
export function criteriaFromDmsDocument(doc: DmsDocument): DocMatchCriteria | null {
  if (doc.direction == null) return null;
  const gross = grossOf(doc);
  if (gross == null) return null;
  return {
    grossAmount: gross,
    currency: 'EUR',
    direction: doc.direction,
    invoiceDate: doc.created ?? undefined,
    counterpartyName: doc.correspondent ?? undefined,
    invoiceNumber: doc.invoiceNumber ?? undefined,
  };
}

/**
 * Rank invoice **documents** that could be the receipt for a bank transaction (best first).
 *
 * A debit (money out) expects an incoming invoice, a credit an outgoing one; the direction, amount
 * and date filters are enforced by {@link findStoreMatches} (each document scored against the single
 * transaction). Already-linked documents are skipped by default.
 */
export function suggestDocumentsForTransaction(
  tx: UnifiedTransaction,
  docs: DmsDocument[],
  options: LinkCandidateOptions = {},
): LinkCandidate[] {
  const wantDirection: InvoiceDirection = tx.amount < 0 ? 'incoming' : 'outgoing';
  const scored: Array<{ raw: number; candidate: LinkCandidate }> = [];

  for (const doc of docs) {
    if (options.excludeLinked !== false && doc.linkedTxIds.length > 0) continue;
    const criteria = criteriaFromDmsDocument(doc);
    if (!criteria || criteria.direction !== wantDirection) continue;
    const [best] = findStoreMatches(criteria, [tx], options);
    if (!best) continue;
    scored.push({
      raw: best.score,
      candidate: {
        documentId: doc.id,
        score: normaliseScore(best.score),
        rawScore: best.score,
        reasons: germanReasons(best),
        amount: grossOf(doc) ?? Math.abs(tx.amount),
        date: doc.created ?? tx.bookingDate,
        counterparty: doc.correspondent ?? undefined,
        title: doc.title ?? undefined,
      },
    });
  }

  scored.sort((a, b) => b.raw - a.raw);
  return scored.slice(0, options.limit ?? DEFAULT_LIMIT).map((s) => s.candidate);
}

/**
 * Rank store **transactions** that could be the payment for an invoice document (best first). The
 * inverse direction — reuses {@link findStoreMatches} directly (document criteria vs. the tx pool).
 */
export function suggestTransactionsForDocument(
  doc: DmsDocument,
  transactions: UnifiedTransaction[],
  options: LinkCandidateOptions = {},
): LinkCandidate[] {
  const criteria = criteriaFromDmsDocument(doc);
  if (!criteria) return [];
  const ranked = findStoreMatches(criteria, transactions, options);
  return ranked.slice(0, options.limit ?? DEFAULT_LIMIT).map((c) => ({
    transactionId: c.transaction.id,
    score: normaliseScore(c.score),
    rawScore: c.score,
    reasons: germanReasons(c),
    amount: c.transaction.amount,
    date: c.transaction.bookingDate,
    counterparty: c.transaction.counterparty ?? undefined,
  }));
}
