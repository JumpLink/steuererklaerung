/**
 * Per-transaction bookkeeping decision types (schema v6, the `classifications` table).
 *
 * A `ClassificationRecord` is the persisted, owner-facing decision for ONE transaction, keyed by the
 * unified transaction id (the same id the EÜR/explain path uses). It is the system-of-record for a
 * manual reclassification (`source='manual'`), the owner's Begründung (`note`), the acceptance of an
 * AI rationale (`aiNote` / `aiNoteAccepted`) and who decided (`decidedBy`). Rows stay `status='open'`
 * until the owner decides; the EÜR aggregate only honours a MANUAL decision that carries a category.
 */

/** Verification state of a classification. Rows start `open` and become `confirmed` once decided. */
export type ClassificationStatus = "open" | "suggested" | "confirmed";

/** Who/what produced the classification. `manual` = an explicit owner decision (wins over rules). */
export type ClassificationDecisionSource = "manual" | "rule" | "document";

/** One persisted per-transaction decision. */
export interface ClassificationRecord {
  /** The unified transaction id (Qonto id / camt_/fints_ hash) — the classifications PK. */
  transactionId: string;
  /** SKR03 category label to book the tx under (a manual override wins over document + rule). */
  category: string | null;
  /** Optional explicit net/VAT (usually derived by the aggregate; kept for a future manual split). */
  net: number | null;
  vat: number | null;
  status: ClassificationStatus;
  /** `manual` for owner overrides; `rule`/`document` reserved for a persisted pipeline decision. */
  source: string | null;
  /** Paperless document id backing the decision, if any. */
  documentId: number | null;
  /** Owner Begründung ("warum habe ich das so gebucht") — surfaced in the Herleitung. */
  note: string | null;
  /** The AI rationale text (kept for accept/override provenance). */
  aiNote: string | null;
  /** Whether the owner accepted the AI rationale (null = never touched). */
  aiNoteAccepted: boolean | null;
  /** ISO timestamp of the decision. */
  decidedAt: string | null;
  /** Who decided (a human id / 'cli' / 'mcp' / a model id). */
  decidedBy: string | null;
}

/**
 * Upsert payload for {@link setClassification}. Omitted fields are PRESERVED on an existing row
 * (merge, like the filings repo); pass `null` to clear one. `decidedAt` is always set from the
 * caller's `at` timestamp, so it is not part of the input.
 */
export interface ClassificationInput {
  category?: string | null;
  net?: number | null;
  vat?: number | null;
  status?: ClassificationStatus;
  source?: string | null;
  documentId?: number | null;
  note?: string | null;
  aiNote?: string | null;
  aiNoteAccepted?: boolean | null;
  decidedBy?: string | null;
}

/** One entry of the append-only decision log (a `classification.*` row of `audit_log`). */
export interface DecisionLogEntry {
  id: number;
  /** ISO timestamp. */
  at: string;
  /** e.g. `classification.set` | `classification.remove`. */
  action: string;
  /** The transaction the decision was about (parsed from the row detail). */
  transactionId: string | null;
  /** The parsed change detail (shape depends on the action). */
  detail: unknown;
}
