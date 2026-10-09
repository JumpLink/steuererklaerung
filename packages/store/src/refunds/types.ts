/**
 * Erstattungen (schema v19, the `refund_links` table): which debit an incoming refund belongs to, and
 * which candidates the owner rejected. Both ids are unified transaction ids, like `classifications`.
 */

/** `linked` = „Ja, gehört dazu"; `rejected` = „Nein" for this one candidate. */
export type RefundLinkStatus = "linked" | "rejected";

export interface RefundLinkRecord {
  refundTxId: string;
  originalTxId: string;
  status: RefundLinkStatus;
  /** What the refund inherits, frozen at „Ja" — null on a rejection. */
  category: string | null;
  /** VAT rate of the original as a fraction (0.19). */
  vatRate: number | null;
  /** The receipt that carried the original's Vorsteuer, if it was classified from one. */
  originalDocumentId: number | null;
  decidedAt: string;
  decidedBy: string | null;
}

export interface RefundLinkInput {
  refundTxId: string;
  originalTxId: string;
  category: string;
  vatRate: number;
  originalDocumentId?: number | null;
  decidedBy?: string | null;
}
