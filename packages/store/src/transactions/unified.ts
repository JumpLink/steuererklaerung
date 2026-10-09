/**
 * Unified transaction model + normalizers.
 *
 * Both Qonto (REST) and FinTS/HBCI (Volksbank et al.) feed into one shape so the
 * store can be searched across all accounts at once. Pure functions only (no I/O),
 * so they are unit-testable and reusable by the CLI and the MCP tool.
 */

import { createHash } from 'node:crypto';

export type TxSource = 'qonto' | 'fints' | 'camt' | 'paypal';

/** One bank transaction, normalized across sources. Amounts are signed EUR (debit negative). */
export interface UnifiedTransaction {
  /** Stable id: Qonto transaction id, or a content hash for FinTS (no native id). */
  id: string;
  source: TxSource;
  /** e.g. "qonto:<bankAccountId>" or "fints:<configName>:<accountNumber>". */
  accountKey: string;
  iban?: string;
  /** Booking date YYYY-MM-DD (entryDate / settled_at). */
  bookingDate: string;
  /** Value date YYYY-MM-DD. */
  valueDate?: string;
  /** Signed amount in EUR; debit/expense is negative. */
  amount: number;
  currency: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  reference?: string;
  /** Booking text (FinTS) or operation type (Qonto). */
  type?: string;
  /** Qonto category, if any. */
  category?: string;
  /**
   * The import that first brought this transaction in, when it came from a file import (CAMT,
   * PayPal). Absent for API-synced rows and for anything stored before batches existed — both are
   * simply not undoable as a batch, which is correct: a sync is not a discrete action to take back.
   */
  importBatch?: string;
}

/** Stable key for upsert / dedup across syncs. */
export function dedupeKey(t: UnifiedTransaction): string {
  return `${t.source}:${t.id}`;
}

/** Normalize a date-ish value to YYYY-MM-DD (undefined if unparseable). */
export function toIsoDate(input: string | Date | undefined | null): string | undefined {
  if (!input) return undefined;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/** Subset of FinTS (lib-fints) transaction fields we consume; all optional for resilience. */
export interface FintsRawTx {
  valueDate?: string | Date;
  entryDate?: string | Date;
  amount?: number;
  currency?: string;
  purpose?: string;
  remoteName?: string;
  remoteAccountNumber?: string;
  remoteBankId?: string;
  bookingText?: string;
  e2eReference?: string;
  mandateReference?: string;
  bankReference?: string;
  transactionCode?: string;
  additionalInformation?: string;
}

/** The booking fields that make a content id; shared so FinTS and CAMT hash identically. */
function idBasis(accountKey: string, tx: FintsRawTx): unknown[] {
  return [
    accountKey,
    toIsoDate(tx.valueDate) ?? '',
    toIsoDate(tx.entryDate) ?? '',
    tx.amount ?? 0,
    tx.purpose ?? '',
    tx.remoteName ?? '',
    tx.remoteAccountNumber ?? '',
    tx.bankReference ?? '',
    tx.e2eReference ?? '',
  ];
}

function hashId(prefix: 'fints' | 'camt', parts: unknown[]): string {
  return `${prefix}_${createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20)}`;
}

/** Deterministic id for a FinTS transaction (the protocol provides no stable id). */
export function fintsContentId(accountKey: string, tx: FintsRawTx): string {
  return hashId('fints', idBasis(accountKey, tx));
}

/**
 * Deterministic id for a CAMT-file-imported transaction (the export carries no
 * stable id). A bank export may legitimately contain bookings indistinguishable
 * by content — same day, amount, counterparty, no unique reference (e.g. two
 * identical payments). Folding the entry's position `seq` into the hash keeps
 * such bookings distinct, while a re-import of the same file (same order) stays
 * idempotent. Omit `seq` for content-only hashing (e.g. in tests).
 */
export function camtContentId(accountKey: string, tx: FintsRawTx, seq?: number): string {
  const parts = idBasis(accountKey, tx);
  if (seq !== undefined) parts.push(seq);
  return hashId('camt', parts);
}

const isUsable = (s: string | undefined): s is string => !!s && s !== 'NOTPROVIDED';

/** Shared field mapping for bank bookings without a native id (FinTS, CAMT file import). */
function bankTx(
  source: 'fints' | 'camt',
  accountKey: string,
  iban: string | undefined,
  tx: FintsRawTx,
  id: string,
): UnifiedTransaction {
  return {
    id,
    source,
    accountKey,
    iban,
    bookingDate: toIsoDate(tx.entryDate) ?? toIsoDate(tx.valueDate) ?? '',
    valueDate: toIsoDate(tx.valueDate),
    amount: typeof tx.amount === 'number' ? tx.amount : 0,
    currency: tx.currency ?? 'EUR',
    counterparty: tx.remoteName || undefined,
    counterpartyIban: tx.remoteAccountNumber || undefined,
    purpose: tx.purpose || undefined,
    reference: isUsable(tx.e2eReference) ? tx.e2eReference : tx.bankReference || undefined,
    type: tx.bookingText || undefined,
  };
}

/** Normalize a FinTS transaction into the unified shape. */
export function normalizeFints(
  accountKey: string,
  iban: string | undefined,
  tx: FintsRawTx,
): UnifiedTransaction {
  return bankTx('fints', accountKey, iban, tx, fintsContentId(accountKey, tx));
}

/**
 * Normalize a CAMT-exported booking (a standalone / closed account imported from
 * file rather than live-synced). Same fields as FinTS, tagged source 'camt'. Pass
 * the entry's position `seq` so content-identical-but-distinct bookings are kept.
 */
export function normalizeCamt(
  accountKey: string,
  iban: string | undefined,
  tx: FintsRawTx,
  seq?: number,
): UnifiedTransaction {
  return bankTx('camt', accountKey, iban, tx, camtContentId(accountKey, tx, seq));
}

/** Filters for searching the unified store. Dates are YYYY-MM-DD (inclusive). */
export interface TxFilter {
  query?: string;
  from?: string;
  to?: string;
  /** Minimum absolute amount. */
  minAmount?: number;
  /** Maximum absolute amount. */
  maxAmount?: number;
  /** income = credit (amount > 0), expense = debit (amount < 0). */
  side?: 'income' | 'expense';
  source?: TxSource;
  accountKey?: string;
}

/** Whether a transaction matches all provided filter criteria. */
export function matchesFilter(t: UnifiedTransaction, f: TxFilter): boolean {
  if (f.source && t.source !== f.source) return false;
  if (f.accountKey && t.accountKey !== f.accountKey) return false;
  if (f.from && t.bookingDate < f.from) return false;
  if (f.to && t.bookingDate > f.to) return false;
  if (f.side === 'income' && t.amount <= 0) return false;
  if (f.side === 'expense' && t.amount >= 0) return false;
  const abs = Math.abs(t.amount);
  if (typeof f.minAmount === 'number' && abs < f.minAmount) return false;
  if (typeof f.maxAmount === 'number' && abs > f.maxAmount) return false;
  if (f.query) {
    const hay =
      `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''} ${t.counterpartyIban ?? ''}`.toLowerCase();
    if (!hay.includes(f.query.toLowerCase())) return false;
  }
  return true;
}
