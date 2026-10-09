/**
 * Rechnung ↔ Projekt (schema v25, the `invoice_projects` table): a direct decision which project an
 * outgoing invoice belongs to. It wins over the link derived from billed hours.
 */

export interface InvoiceProjectRecord {
  entityId: string;
  /** The back-end invoice id (self: local id, Qonto: the remote id) — a soft ref, no FK. */
  invoiceId: string;
  projectId: string;
  decidedAt: string;
  decidedBy: string | null;
}
