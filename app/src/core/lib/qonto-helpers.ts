/**
 * Shared helpers for Qonto transaction data.
 * Used by sync matching and push actions.
 */

import type { Transaction } from '../clients/qonto/types.ts';

/**
 * Signed amount for a Qonto transaction: debit → negative, credit → positive (absolute amount in currency units).
 */
export function qontoSignedAmount(tx: Transaction): number {
  const abs = Math.abs(tx.amount_cents) / 100;
  return tx.side === 'debit' ? -abs : abs;
}

/**
 * Normalize label for matching: trim, toLowerCase, keep alphanumeric and spaces.
 */
export function normalizeLabel(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
