/**
 * Rechnungen presenter — the outgoing-invoice READ/DERIVE seam shared by the desktop Rechnungen view
 * and the web invoice/recurring routes: the reminder dashboard, the issued-invoice list, the entity's
 * back-end capabilities, one invoice's detail/PDF/XRechnung bytes, the payment candidates, and the
 * customer picker (the `isCustomer` filter, {@link selectCustomers}).
 *
 * Reads only — the write actions (draft / finalize / mark-paid / cancel / delete) stay in
 * `core/actions/outgoing-invoices.ts` and are called directly by each surface with its own transport
 * (the web wraps the outbound ones in polled jobs). This presenter never mutates.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on GJS
 * in every frontend. Entity-scoped by `entityId` (a string), not the desktop's AppEntity.
 */

import { listOutgoingInvoices, recurringDashboard } from '../actions/recurring-invoices.ts';
import {
    getInvoiceCapabilities,
    getOutgoingInvoice,
    getOutgoingInvoicePdf,
    getOutgoingInvoiceXml,
} from '../actions/outgoing-invoices.ts';
import { findPaymentCandidates, type PaymentCandidate } from '../actions/invoice-payments.ts';
import {
    entscheideDoppelzahlung,
    listDoppelzahlungVerdacht,
    listOffeneRueckzahlungen,
    listRueckzahlungKandidaten,
    type DoppelzahlungVerdachtDetail,
    type OffeneRueckzahlung,
    type RueckzahlungKandidat,
} from '../actions/invoices/doppelzahlung.ts';
import { listEntityContacts } from '../actions/contacts.ts';
import type { Contact } from '@steuererklaerung/store';
import { invoicingBlock } from '../invoices/backend-gate.ts';
import { displayInvoiceStatus, normalizeInvoiceStatus } from '../invoices/status.ts';
import type { RecurringDueEntry } from '../invoices/recurring.ts';
import type {
    InvoiceCapabilities,
    OutgoingInvoiceDetail,
    OutgoingInvoiceFile,
    OutgoingInvoiceSummary,
} from '../invoices/provider.ts';

export type { RecurringDueEntry } from '../invoices/recurring.ts';
export type {
    CreateInvoiceInput,
    InvoiceCapabilities,
    OutgoingInvoiceDetail,
    OutgoingInvoiceDraft,
    OutgoingInvoiceFile,
    OutgoingInvoiceSummary,
} from '../invoices/provider.ts';
export { entscheideDoppelzahlung };
export type { DoppelzahlungVerdachtDetail, OffeneRueckzahlung, RueckzahlungKandidat };
export type { DoppelzahlungEntscheidung } from '../actions/invoices/doppelzahlung.ts';
export type { PaymentCandidate } from '../actions/invoice-payments.ts';
export type { Contact } from '@steuererklaerung/store';

/** The recurring-invoice reminders for an entity (overdue · due-soon · upcoming), synchronous. */
export function loadRecurring(
    entityId: string,
    today: string = new Date().toISOString().slice(0, 10),
): RecurringDueEntry[] {
    return recurringDashboard({ entityId, today });
}

/**
 * Why the entity cannot bill through Qonto (no `qonto:` account), as a German sentence for a notice
 * page — or null when invoicing works. Check before listing; the actions throw the same text.
 */
export function loadInvoicingBlock(entityId: string): string | null {
    return invoicingBlock(entityId);
}

/**
 * The invoices a tax-year view shows. Paid and cancelled invoices belong to the year they were
 * issued in; everything still unpaid (draft, open, overdue) is shown whatever its year, because a
 * receivable does not stop being one on 1 January — and the Offen/Überfällig tiles stay in step
 * with the list. A paid/cancelled invoice without any date is kept rather than silently dropped.
 */
export function selectInvoicesForYear(
    list: OutgoingInvoiceSummary[],
    year: number,
    today: string,
): OutgoingInvoiceSummary[] {
    return list.filter((inv) => {
        const status = displayInvoiceStatus(inv.status, inv.dueDate, today);
        if (status !== 'paid' && status !== 'cancelled') return true;
        const date = inv.issueDate ?? inv.dueDate;
        return !date || date.startsWith(`${year}-`);
    });
}

/** The issued invoices from the entity's invoicing back-end (async; outbound, e.g. Qonto). */
export async function loadOutgoingInvoices(entityId: string, status?: string): Promise<OutgoingInvoiceSummary[]> {
    return listOutgoingInvoices({ entityId, status });
}

/** The entity's invoicing back-end capabilities (sync, local) — gates the UI actions. */
export function loadCapabilities(entityId: string): InvoiceCapabilities {
    return getInvoiceCapabilities(entityId).capabilities;
}

/** Full detail for one invoice (self back-end). */
export async function loadInvoiceDetail(entityId: string, id: string): Promise<OutgoingInvoiceDetail | null> {
    return getOutgoingInvoice(entityId, id);
}

/** The invoice PDF (rendered bytes for self, hosted URL for Qonto). */
export async function loadInvoicePdf(entityId: string, id: string): Promise<OutgoingInvoiceFile | null> {
    return getOutgoingInvoicePdf(entityId, id);
}

/** The XRechnung XML bytes (self only). */
export async function loadInvoiceXml(entityId: string, id: string): Promise<OutgoingInvoiceFile | null> {
    return getOutgoingInvoiceXml(entityId, id);
}

/** Candidate bank transactions that likely settled an open invoice. */
export async function loadPaymentCandidates(entityId: string, id: string): Promise<PaymentCandidate[]> {
    return findPaymentCandidates(entityId, id);
}

/** The entity's customers (contact master, isCustomer) — the invoice recipient picker. */
export function loadCustomers(entityId: string): Contact[] {
    return selectCustomers(listEntityContacts(entityId));
}

/** The pure isCustomer projection over a contact list — the derive the customer picker shares. */
export function selectCustomers(contacts: Contact[]): Contact[] {
    return contacts.filter((c) => c.isCustomer);
}

/** What is open about double payments on ONE invoice: suspected credits and recorded cases awaiting a refund. */
export interface InvoiceDoppelzahlung {
    verdacht: DoppelzahlungVerdachtDetail[];
    rueckzahlungOffen: OffeneRueckzahlung[];
}

/** Double-payment state of one invoice. Fail-soft: a hint must never break the detail dialog. */
export async function loadInvoiceDoppelzahlung(entityId: string, invoiceId: string): Promise<InvoiceDoppelzahlung> {
    let verdacht: DoppelzahlungVerdachtDetail[] = [];
    let rueckzahlungOffen: OffeneRueckzahlung[] = [];
    try {
        verdacht = (await listDoppelzahlungVerdacht(entityId)).filter((v) => v.rechnungId === invoiceId);
    } catch {
        /* back-end or store unreadable — no suspicion shown */
    }
    try {
        rueckzahlungOffen = listOffeneRueckzahlungen(entityId).filter((r) => r.rechnungId === invoiceId);
    } catch {
        /* same */
    }
    return { verdacht, rueckzahlungOffen };
}

/** Open invoices of the entity (except `exceptId`) — the "belongs to another invoice" picker. */
export async function loadOpenInvoicesForPicker(entityId: string, exceptId: string): Promise<OutgoingInvoiceSummary[]> {
    const list = await listOutgoingInvoices({ entityId });
    return list.filter((i) => i.id !== exceptId && normalizeInvoiceStatus(i.status) === 'open');
}

/** Debits to pick a refund from, the surplus amount first. */
export function loadRueckzahlungKandidaten(entityId: string, amount: number): RueckzahlungKandidat[] {
    return listRueckzahlungKandidaten(entityId, amount);
}
