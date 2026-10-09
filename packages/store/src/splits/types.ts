/**
 * Splitbuchungen (schema v22, the `booking_splits` table): one booking split into parts with their own
 * category and VAT rate. An overlay — the bank transaction stays untouched, keyed by its unified tx id.
 */

export interface SplitPartRecord {
  txId: string;
  /** 1-based, in the order the owner entered the parts. */
  partNo: number;
  category: string;
  /** Gross of the part in cents (positive); null for the one part that takes the remainder. */
  amountCents: number | null;
  /** VAT rate as a fraction (0.19). */
  vatRate: number;
  note: string | null;
  decidedAt: string;
  decidedBy: string | null;
}

export interface SplitPartInput {
  category: string;
  /** Null marks the remainder part. */
  amountCents: number | null;
  vatRate: number;
  note?: string | null;
}
