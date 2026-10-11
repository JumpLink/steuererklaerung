/**
 * Verträge (schema v27, ADR 0004): a contract with its term and payment data, the bookings linked to
 * it (or rejected as candidates) and the documents that belong to it. Ids of bookings are unified
 * transaction ids, document refs are DMS-agnostic strings — both FK-free like `refund_links`.
 */

/** The payment intervals, the same as the Laufende-Kosten series. */
export type ContractCycle = "monatlich" | "vierteljaehrlich" | "halbjaehrlich" | "jaehrlich";
export const CONTRACT_CYCLES: readonly ContractCycle[] = ["monatlich", "vierteljaehrlich", "halbjaehrlich", "jaehrlich"];

export type NoticeUnit = "days" | "weeks" | "months";
export const NOTICE_UNITS: readonly NoticeUnit[] = ["days", "weeks", "months"];

export type ContractPaymentMethod = "lastschrift" | "ueberweisung" | "karte" | "paypal" | "sonstiges";
export const CONTRACT_PAYMENT_METHODS: readonly ContractPaymentMethod[] = [
  "lastschrift",
  "ueberweisung",
  "karte",
  "paypal",
  "sonstiges",
];

/** `cancelled` = notice given, still running until its end; `ended` = over; `archived` = hidden. */
export type ContractStatus = "active" | "cancelled" | "ended" | "archived";
export const CONTRACT_STATUSES: readonly ContractStatus[] = ["active", "cancelled", "ended", "archived"];

export interface ContractRecord {
  id: string;
  entityId: string;
  name: string;
  /** As written on bank statements or the contract. */
  counterparty: string | null;
  /** DMS correspondent: `paperless:<id>` or a built-in correspondent id. */
  counterpartyRef: string | null;
  contractNumber: string | null;
  /** The account it is paid from (unified account key). */
  accountKey: string | null;
  /** The owner's own word, not a tax category. */
  category: string | null;
  /** EUR, positive. */
  amount: number | null;
  cycle: ContractCycle | null;
  /** EUR a payment may differ from `amount` and still be the expected one. */
  amountTolerance: number | null;
  /** YYYY-MM-DD; also the anchor of the expected payment dates. */
  startDate: string | null;
  initialTermMonths: number | null;
  /** Months each renewal adds; null = renews indefinitely (cancellable at any time with notice). */
  renewalMonths: number | null;
  noticeValue: number | null;
  noticeUnit: NoticeUnit | null;
  autoRenewal: boolean;
  /** YYYY-MM-DD, set once the end is known (cancelled or fixed-term). */
  endDate: string | null;
  paymentMethod: ContractPaymentMethod | null;
  /** SEPA creditor identifier of the direct-debit mandate. */
  creditorId: string | null;
  mandateReference: string | null;
  counterpartyIban: string | null;
  /** Extra text a booking's counterparty/purpose must contain to match. */
  matchText: string | null;
  status: ContractStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create (no `id`, or an unknown one) or update: only the given fields change; `null` clears one. */
export type ContractInput = { id?: string; entityId?: string; name?: string } & Partial<
  Omit<ContractRecord, "id" | "entityId" | "name" | "createdAt" | "updatedAt">
>;

/** `linked` = the booking belongs to the contract; `rejected` = not offered again as a candidate. */
export type ContractTxStatus = "linked" | "rejected";

export interface ContractTransactionRecord {
  contractId: string;
  txId: string;
  status: ContractTxStatus;
  decidedAt: string;
  decidedBy: string | null;
}

export type ContractDocumentRole = "contract" | "invoice" | "notice" | "confirmation" | "other";
export const CONTRACT_DOCUMENT_ROLES: readonly ContractDocumentRole[] = [
  "contract",
  "invoice",
  "notice",
  "confirmation",
  "other",
];

export interface ContractDocumentRecord {
  contractId: string;
  documentRef: string;
  role: ContractDocumentRole;
  linkedAt: string;
}
