/**
 * Per-contact open receivables — the sum of OPEN (unpaid / overdue) outgoing-invoice totals grouped
 * by the customer contact they belong to. Drives the "N € offen" badge on the Kontakte list.
 *
 * DEPENDENCY-FREE on purpose (like {@link ./status.ts}): imported by the Vite web client AND the
 * native GJS app, so it must not pull in node:/GJS/store/Qonto code. It's a PURE join — the caller
 * loads the invoices (outbound) + contacts (store) and passes lightweight refs in.
 */

import { normalizeInvoiceStatus } from './status.ts';
import type { OutgoingInvoiceSummary } from './provider.ts';

/** The minimum a contact must expose to be matched to its invoices (no store dependency). */
export interface ContactRef {
    id: string;
    /** Resolved display name (store `contactDisplayName`) — the name-match fallback. */
    displayName: string;
    /** The contact's linked Qonto client id (`links[qonto].externalId`), if any — the primary match. */
    qontoClientId?: string | null;
}

/**
 * Map contactId → Σ open invoice total. An invoice is matched to a contact primarily by its Qonto
 * `clientId` (contact link), falling back to a case-insensitive `customerName` ↔ display-name match
 * (covers the self-provider, whose invoices carry no client id). Unmatched invoices are skipped.
 */
export function openReceivablesByContact(
    contacts: ContactRef[],
    invoices: OutgoingInvoiceSummary[],
): Map<string, number> {
    const byClientId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const c of contacts) {
        if (c.qontoClientId) byClientId.set(c.qontoClientId, c.id);
        const dn = c.displayName.trim().toLowerCase();
        if (dn) byName.set(dn, c.id);
    }

    const out = new Map<string, number>();
    for (const inv of invoices) {
        if (inv.total == null) continue;
        if (normalizeInvoiceStatus(inv.status) !== 'open') continue;
        const contactId =
            (inv.clientId ? byClientId.get(inv.clientId) : undefined) ??
            (inv.customerName ? byName.get(inv.customerName.trim().toLowerCase()) : undefined);
        if (!contactId) continue;
        out.set(contactId, (out.get(contactId) ?? 0) + inv.total);
    }
    return out;
}
