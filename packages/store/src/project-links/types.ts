/**
 * Projektzuordnung (schema v23, the `booking_projects` table): which project an expense belongs to. A
 * per-booking decision over the unchanged bank transaction, keyed by its unified tx id.
 */

/** `part_no` of the decision that covers the whole booking; a split part n is stored as n ≥ 1. */
export const WHOLE_BOOKING = 0;

export interface ProjectLinkRecord {
  txId: string;
  /** {@link WHOLE_BOOKING}, or the 1-based part of a split booking. */
  partNo: number;
  /** The manifest project; null = decided „kein Projekt" (wins over a project rule). */
  projectId: string | null;
  decidedAt: string;
  decidedBy: string | null;
}
