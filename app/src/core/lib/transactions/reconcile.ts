/**
 * Pure matching logic: link a Paperless invoice document to a bank transaction
 * in the local unified store (camt:/fints:/qonto:).
 *
 * This is the store-based counterpart to the live-Qonto reconciliation in
 * mcp/tools/cross-system.ts. It exists for *closed* accounts (e.g. a dissolved
 * company) whose history was imported from CAMT exports and is therefore no
 * longer reachable via the Qonto API — the camt: store is the only
 * remaining source of the payment (Zufluss/Abfluss) date and amount.
 *
 * No I/O: takes already-extracted document criteria plus a list of store
 * transactions and returns ranked candidates, so it is unit-testable and reused
 * by both the MCP tool and the CLI.
 */

import { DEFAULTS } from '../../constants.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

/** Direction of the invoice relative to the business. */
export type InvoiceDirection = 'incoming' | 'outgoing';

export interface DocMatchCriteria {
  /** Gross amount of the invoice, always positive. */
  grossAmount: number;
  /** Invoice currency (defaults to EUR when omitted). */
  currency?: string;
  /** incoming → expect a debit (money out); outgoing → expect a credit (money in). */
  direction: InvoiceDirection;
  /** Relevant document dates (YYYY-MM-DD); the closest of the two is used. */
  invoiceDate?: string;
  dueDate?: string;
  /** Correspondent / supplier or customer name, for a soft name match. */
  counterpartyName?: string;
  /**
   * Invoice number (e.g. "RE-00042"). When it appears in the transaction's
   * purpose/reference it is a decisive disambiguator for same-amount rivals.
   */
  invoiceNumber?: string;
  /**
   * Document is in a foreign currency: the EUR booking can't equal the gross, so
   * match by supplier name + nearest date instead of amount (the EUR amount is
   * taken from the matched transaction by the transaction-driven EÜR).
   */
  foreignCurrency?: boolean;
}

export interface StoreMatchOptions {
  /** Max absolute amount difference in EUR. Default {@link DEFAULTS.AMOUNT_TOLERANCE_EUR}. */
  amountTolerance?: number;
  /**
   * Hard cap on |days| between the booking date and the nearest document date.
   * Candidates outside the window are dropped. Default 60 (payment commonly lags
   * the invoice by weeks). A closeness bonus is given within
   * {@link DEFAULTS.DATE_TOLERANCE_DAYS} days.
   */
  maxDayGap?: number;
}

export interface StoreMatchCandidate {
  transaction: UnifiedTransaction;
  /** Higher = better. Roughly 0..100. */
  score: number;
  /** Absolute amount difference (EUR). */
  amountDiff: number;
  /** Signed day gap (bookingDate − nearest doc date); negative = booked before. Null if no doc date. */
  dayGap: number | null;
  reasons: string[];
}

const MS_PER_DAY = 86_400_000;

/** Whole-day difference a − b for two YYYY-MM-DD strings (null if either is unparseable). */
export function dayDiff(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / MS_PER_DAY);
}

/** Tokens of length ≥ 3, lowercased, alnum only — for a coarse name overlap test. */
function nameTokens(value: string | undefined): Set<string> {
  if (!value) return new Set();
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

/** Whether the correspondent name and the transaction's text share a meaningful token. */
function nameMatches(counterpartyName: string | undefined, tx: UnifiedTransaction): boolean {
  const wanted = nameTokens(counterpartyName);
  if (wanted.size === 0) return false;
  const hay = nameTokens(`${tx.counterparty ?? ''} ${tx.purpose ?? ''} ${tx.reference ?? ''}`);
  for (const token of wanted) {
    if (hay.has(token)) return true;
  }
  return false;
}

/**
 * Whether the invoice number (or its ≥4-char alphanumeric core / numeric tail)
 * appears in the transaction's purpose/reference/counterparty. Strong signal:
 * SEPA payers usually quote the invoice number in the Verwendungszweck.
 */
export function referenceMatches(
  invoiceNumber: string | undefined,
  tx: Pick<UnifiedTransaction, 'purpose' | 'reference' | 'counterparty'>,
): boolean {
  if (!invoiceNumber) return false;
  const core = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (core.length < 4) return false;
  const hay = `${tx.purpose ?? ''} ${tx.reference ?? ''} ${tx.counterparty ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (hay.includes(core)) return true;
  const numTail = core.replace(/^[a-z]+/, '');
  return numTail.length >= 4 && hay.includes(numTail);
}

/** Signed day gap to the *closest* of the candidate document dates. */
function nearestDayGap(bookingDate: string, criteria: DocMatchCriteria): number | null {
  const gaps = [criteria.invoiceDate, criteria.dueDate]
    .map((d) => dayDiff(bookingDate, d))
    .filter((g): g is number => g != null);
  if (gaps.length === 0) return null;
  return gaps.reduce((best, g) => (Math.abs(g) < Math.abs(best) ? g : best));
}

/**
 * Rank store transactions as candidate payments for an invoice document.
 *
 * Hard filters: matching direction (debit for incoming / credit for outgoing),
 * amount within tolerance, and — when a document date is known — booking date
 * within the day-gap window. Soft scoring: amount closeness, date closeness,
 * and a counterparty-name bonus. Returns candidates sorted best-first.
 */
export function findStoreMatches(
  criteria: DocMatchCriteria,
  transactions: UnifiedTransaction[],
  options: StoreMatchOptions = {},
): StoreMatchCandidate[] {
  const amountTolerance = options.amountTolerance ?? DEFAULTS.AMOUNT_TOLERANCE_EUR;
  const maxDayGap = options.maxDayGap ?? 60;
  const wantDebit = criteria.direction === 'incoming';
  const candidates: StoreMatchCandidate[] = [];

  for (const tx of transactions) {
    // Direction must match (incoming invoice ⇒ money leaves the account).
    if (wantDebit && tx.amount >= 0) continue;
    if (!wantDebit && tx.amount <= 0) continue;

    const amountDiff = Math.round((Math.abs(tx.amount) - criteria.grossAmount) * 100) / 100;
    const nameHit = nameMatches(criteria.counterpartyName, tx);
    // Foreign-currency invoices: the EUR booking can't equal the foreign gross,
    // so the supplier name (must appear in the booking) is the anchor instead of
    // the amount; the EUR amount is taken from the transaction downstream.
    const isFx = criteria.foreignCurrency === true;
    if (isFx) {
      if (!nameHit) continue;
    } else if (Math.abs(amountDiff) > amountTolerance) {
      continue;
    }

    const dayGap = nearestDayGap(tx.bookingDate, criteria);
    if (dayGap != null && Math.abs(dayGap) > maxDayGap) continue;

    const reasons: string[] = [];
    // Amount: 60 points toward the tolerance edge (0 for FX — amount is no signal).
    const amountScore = isFx ? 0 : 60 * (1 - Math.abs(amountDiff) / (amountTolerance || 1));
    if (isFx) reasons.push(`fx: paid EUR ${Math.abs(tx.amount).toFixed(2)} vs doc ${criteria.currency ?? '?'} ${criteria.grossAmount.toFixed(2)}`);
    else reasons.push(Math.abs(amountDiff) <= 0.005 ? 'amount exact' : `amount Δ${amountDiff.toFixed(2)}`);

    // Date: up to 30 points, decaying CONTINUOUSLY with distance so the
    // temporally-nearest payment strictly outscores a farther same-amount rival
    // — this is what resolves recurring same-amount invoices (Hetzner €49/mo …).
    let dateScore = 0;
    if (dayGap == null) {
      reasons.push('no document date');
    } else {
      // Weighted 40 so a monthly (~30d) gap difference exceeds the confidence
      // lead threshold — the nearest of two same-amount monthly payments wins.
      dateScore = 40 * Math.max(0, 1 - Math.abs(dayGap) / maxDayGap);
      reasons.push(`${dayGap >= 0 ? '+' : ''}${dayGap}d from doc date`);
    }

    // Name: the correspondent appears in the booking text. For FX this is the
    // primary anchor (weighted 40); otherwise a soft +10 tie-breaker.
    let nameScore = 0;
    if (nameHit) {
      nameScore = isFx ? 40 : 10;
      reasons.push('counterparty name match');
    }

    // Invoice number in the booking text: decisive disambiguator (+50) — lets a
    // same-amount/same-date rival that quotes the invoice number win confidently.
    let refScore = 0;
    if (referenceMatches(criteria.invoiceNumber, tx)) {
      refScore = 50;
      reasons.push('invoice no. in reference');
    }

    // Currency mismatch is suspicious for an amount-EQUALITY match — flag and
    // penalise. (Not for FX, where the currencies differ by design.)
    let currencyPenalty = 0;
    if (!isFx && criteria.currency && tx.currency && criteria.currency.toUpperCase() !== tx.currency.toUpperCase()) {
      currencyPenalty = 25;
      reasons.push(`currency mismatch (${criteria.currency} vs ${tx.currency})`);
    }

    const score = Math.round(amountScore + dateScore + nameScore + refScore - currencyPenalty);
    candidates.push({ transaction: tx, score, amountDiff, dayGap, reasons });
  }

  candidates.sort((a, b) => b.score - a.score || Math.abs(a.amountDiff) - Math.abs(b.amountDiff));
  return candidates;
}

export interface BestMatchResult {
  match: StoreMatchCandidate | null;
  /** True when there is a clear winner; false when ambiguous or none. */
  confident: boolean;
  /** Other candidates that were close enough to make the pick ambiguous. */
  rivals: StoreMatchCandidate[];
}

/**
 * Pick the single best match if it is unambiguous: the top candidate must clear
 * `minScore` and lead the runner-up by at least `minLead` points. Otherwise the
 * caller should ask a human (the rivals are returned for display).
 */
export function pickBestMatch(
  candidates: StoreMatchCandidate[],
  opts: { minScore?: number; minLead?: number } = {},
): BestMatchResult {
  const minScore = opts.minScore ?? 60;
  const minLead = opts.minLead ?? 15;
  if (candidates.length === 0) return { match: null, confident: false, rivals: [] };
  const [top, second] = candidates;
  const lead = second ? top.score - second.score : Number.POSITIVE_INFINITY;
  const confident = top.score >= minScore && lead >= minLead;
  const rivals = confident ? [] : candidates.slice(0, 3);
  return { match: top, confident, rivals };
}
