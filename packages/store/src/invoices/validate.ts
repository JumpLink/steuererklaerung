/**
 * §14 UStG finalize validation. Draft content is checked leniently elsewhere; THESE are the
 * rules that must hold before a number is assigned and the invoice becomes immutable. Pure and
 * German-language (messages surface directly in the CLI/UI). Kleinbetragsrechnungen (§33 UStDV,
 * gross ≤ 250 €) relax the recipient-detail requirements.
 */

import { computeInvoiceTotals, isKleinbetragsrechnung } from './totals.ts';
import type { InvoiceIssuerSnapshot, InvoiceRecipient, StoredInvoice } from './types.ts';

/**
 * Validate an invoice for finalize. Returns human-readable problems (empty = ok). Checks §14
 * mandatory fields, the §19 Kleinunternehmer VAT-consistency, and per-rate computability.
 */
export function validateInvoiceForFinalize(
    invoice: Pick<StoredInvoice, 'issueDate' | 'performanceStart' | 'performanceEnd' | 'items' | 'footer'>,
    issuer: InvoiceIssuerSnapshot,
    recipient: InvoiceRecipient | null,
): string[] {
    const problems: string[] = [];

    // --- Issuer (§14 Abs. 4 Nr. 1 + 2) ---
    if (!issuer.name?.trim()) problems.push('Aussteller: Name fehlt.');
    if (!issuer.address?.trim() || !issuer.city?.trim()) problems.push('Aussteller: Anschrift fehlt.');
    if (!issuer.taxNumber?.trim() && !issuer.vatId?.trim()) {
        problems.push('Aussteller: Steuernummer oder USt-IdNr. ist erforderlich (§14 UStG).');
    }

    // --- Positions (§14 Abs. 4 Nr. 5 + 7) ---
    if (!invoice.items?.length) {
        problems.push('Mindestens eine Rechnungsposition ist erforderlich.');
    } else {
        invoice.items.forEach((it, i) => {
            const n = i + 1;
            if (!it.title?.trim()) problems.push(`Position ${n}: Bezeichnung fehlt.`);
            if (!Number.isFinite(it.quantity) || it.quantity <= 0)
                problems.push(`Position ${n}: ungültige Menge.`);
            if (!Number.isFinite(it.unitPriceNet)) problems.push(`Position ${n}: ungültiger Einzelpreis.`);
            if (!Number.isFinite(it.vatRate) || it.vatRate < 0)
                problems.push(`Position ${n}: ungültiger USt-Satz.`);
        });
    }

    const totals = computeInvoiceTotals(invoice.items ?? []);
    const kleinbetrag = isKleinbetragsrechnung(totals.gross);

    // --- Recipient (§14 Abs. 4 Nr. 1) — relaxed for a Kleinbetragsrechnung (§33 UStDV) ---
    if (!kleinbetrag) {
        if (!recipient?.name?.trim()) problems.push('Empfänger: Name fehlt.');
        if (!recipient?.address?.trim() || !recipient?.city?.trim())
            problems.push('Empfänger: Anschrift fehlt (bei Rechnungen über 250 € erforderlich).');
    }

    // --- Dates (§14 Abs. 4 Nr. 3 + 6) ---
    if (!invoice.issueDate?.trim()) problems.push('Ausstellungsdatum fehlt.');
    if (!invoice.performanceStart?.trim() && !invoice.issueDate?.trim()) {
        problems.push('Leistungsdatum bzw. Leistungszeitraum fehlt.');
    }

    // --- §19 Kleinunternehmer VAT consistency ---
    if (issuer.kleinunternehmer) {
        const hasVat = (invoice.items ?? []).some((it) => (it.vatRate ?? 0) > 0);
        if (hasVat) {
            problems.push(
                'Kleinunternehmer (§19 UStG): Es darf keine Umsatzsteuer ausgewiesen werden — alle Positionen mit 0 %.',
            );
        }
    }

    return problems;
}
