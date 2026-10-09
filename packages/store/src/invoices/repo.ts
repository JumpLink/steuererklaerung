/**
 * Outgoing-invoice data access on the SQLite `invoices` / `invoice_items` / `invoice_sequences`
 * / `invoice_events` tables (schema v4). The store is the system of record for the self provider.
 *
 * GoBD immutability lives HERE, not in SQL triggers (gjsify's sqlite splitter can't carry the
 * internal semicolons a trigger body needs). The contract:
 *  - drafts are freely editable/deletable; a finalized (open/paid/cancelled) invoice is frozen;
 *  - finalize assigns the fortlaufende Nummer, snapshots recipient+issuer, freezes totals;
 *  - the only correction is a storno counter-invoice (never an edit);
 *  - archive refs are written once (archive-once);
 *  - every mutation appends an invoice_events row inside the same transaction;
 *  - finalize/markPaid/storno refuse to touch a GoBD-locked period.
 *
 * Every mutation takes an `at` ISO timestamp from the caller (like periods.ts / contacts/repo.ts)
 * so the layer stays pure/testable.
 */

import { type LedgerDatabase, withTransaction } from '../ledger/db.ts';
import { ledgerEntityForWorkspaceEntity } from '../ledger/entities.ts';
import { getPeriodStatus } from '../ledger/periods.ts';
import { allocateInvoiceNumber, DEFAULT_NUMBER_PREFIX } from './numbering.ts';
import { computeInvoiceTotals, computeItemTotals } from './totals.ts';
import type {
    InvoiceDraftInput,
    InvoiceIssuerSnapshot,
    InvoiceRecipient,
    StoredInvoice,
    StoredInvoiceItem,
} from './types.ts';

interface InvoiceRow {
    id: string;
    entity_id: string;
    kind: string;
    status: string;
    number: string | null;
    contact_id: string | null;
    recipient_json: string | null;
    issuer_json: string | null;
    issue_date: string | null;
    due_date: string | null;
    performance_start: string | null;
    performance_end: string | null;
    currency: string;
    iban: string | null;
    buyer_reference: string | null;
    header: string | null;
    footer: string | null;
    terms: string | null;
    total_net: number | null;
    total_vat: number | null;
    total_gross: number | null;
    storno_of_id: string | null;
    paid_at: string | null;
    paid_tx_id: string | null;
    dms: string | null;
    pdf_document_id: string | null;
    xml_document_id: string | null;
    finalized_at: string | null;
    created_at: string;
    updated_at: string;
    created_by: string | null;
}

interface ItemRow {
    position: number;
    title: string;
    description: string | null;
    quantity: number;
    unit: string | null;
    unit_price_net: number;
    vat_rate: number;
    net: number;
    vat: number;
    gross: number;
}

function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function itemRowToItem(r: ItemRow): StoredInvoiceItem {
    return {
        title: r.title,
        description: r.description,
        quantity: r.quantity,
        unit: r.unit,
        unitPriceNet: r.unit_price_net,
        vatRate: r.vat_rate,
        net: r.net,
        vat: r.vat,
        gross: r.gross,
    };
}

function rowToInvoice(db: LedgerDatabase, row: InvoiceRow): StoredInvoice {
    const itemRows = db
        .prepare(
            `SELECT position, title, description, quantity, unit, unit_price_net, vat_rate, net, vat, gross
             FROM invoice_items WHERE invoice_id = ? ORDER BY position`,
        )
        .all(row.id) as unknown as ItemRow[];
    const items = itemRows.map(itemRowToItem);
    // Totals: frozen columns once finalized; recomputed live from items while a draft.
    const totals =
        row.total_gross != null
            ? {
                  net: row.total_net ?? 0,
                  vat: row.total_vat ?? 0,
                  gross: row.total_gross,
                  byRate: computeInvoiceTotals(items).byRate,
              }
            : computeInvoiceTotals(items);
    // A cancelled invoice points back to the storno that cancelled it (reverse of storno_of_id).
    const cancelledBy = db
        .prepare(`SELECT id FROM invoices WHERE storno_of_id = ?`)
        .get(row.id) as { id: string } | undefined;
    return {
        id: row.id,
        entityId: row.entity_id,
        kind: row.kind as StoredInvoice['kind'],
        status: row.status as StoredInvoice['status'],
        number: row.number,
        contactId: row.contact_id,
        recipient: parseJson<InvoiceRecipient>(row.recipient_json),
        issuer: parseJson<InvoiceIssuerSnapshot>(row.issuer_json),
        issueDate: row.issue_date,
        dueDate: row.due_date,
        performanceStart: row.performance_start,
        performanceEnd: row.performance_end,
        currency: row.currency,
        iban: row.iban,
        buyerReference: row.buyer_reference,
        header: row.header,
        footer: row.footer,
        terms: row.terms,
        items,
        totals,
        stornoOfId: row.storno_of_id,
        cancelledById: cancelledBy?.id ?? null,
        paidAt: row.paid_at,
        paidTxId: row.paid_tx_id,
        archive: { dms: row.dms, pdfDocumentId: row.pdf_document_id, xmlDocumentId: row.xml_document_id },
        finalizedAt: row.finalized_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
    };
}

/** One invoice by id (with items), or null. */
export function getInvoice(db: LedgerDatabase, id: string): StoredInvoice | null {
    const row = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as unknown as InvoiceRow | undefined;
    return row ? rowToInvoice(db, row) : null;
}

/** All invoices for an entity (newest first), optionally filtered by status or issue year. */
export function listInvoices(
    db: LedgerDatabase,
    entityId: string,
    opts: { status?: string; year?: number } = {},
): StoredInvoice[] {
    const clauses = ['entity_id = ?'];
    const params: string[] = [entityId];
    if (opts.status) {
        clauses.push('status = ?');
        params.push(opts.status);
    }
    if (opts.year != null) {
        clauses.push('substr(issue_date, 1, 4) = ?');
        params.push(String(opts.year));
    }
    const rows = db
        .prepare(
            `SELECT * FROM invoices WHERE ${clauses.join(' AND ')}
             ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC`,
        )
        .all(...params) as unknown as InvoiceRow[];
    return rows.map((r) => rowToInvoice(db, r));
}

function appendEvent(
    db: LedgerDatabase,
    invoiceId: string,
    action: string,
    at: string,
    detail?: Record<string, unknown>,
): void {
    db.prepare(`INSERT INTO invoice_events(invoice_id, at, action, actor, detail) VALUES(?, ?, ?, ?, ?)`).run(
        invoiceId,
        at,
        action,
        null,
        detail ? JSON.stringify(detail) : null,
    );
}

function replaceItems(db: LedgerDatabase, invoiceId: string, items: StoredInvoiceItem[]): void {
    db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(invoiceId);
    const stmt = db.prepare(
        `INSERT INTO invoice_items
           (invoice_id, position, title, description, quantity, unit, unit_price_net, vat_rate, net, vat, gross)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((it, i) => {
        stmt.run(
            invoiceId,
            i + 1,
            it.title,
            it.description ?? null,
            it.quantity,
            it.unit ?? null,
            it.unitPriceNet,
            it.vatRate,
            it.net,
            it.vat,
            it.gross,
        );
    });
}

/** The list of read-only statuses; anything but 'draft' is frozen (GoBD). */
function assertDraft(inv: StoredInvoice, verb: string): void {
    if (inv.status !== 'draft') {
        throw new Error(
            `Rechnung ${inv.number ?? inv.id} ist ${inv.status} und kann nicht ${verb} werden (GoBD: nur Entwürfe sind änderbar).`,
        );
    }
}

/** Refuse the mutation when the invoice's issue year is a GoBD-locked period. */
function assertPeriodOpen(db: LedgerDatabase, entityId: string, issueDate: string | null): void {
    if (!issueDate) return;
    const ledgerEntity = ledgerEntityForWorkspaceEntity(entityId);
    const year = Number(issueDate.slice(0, 4));
    if (ledgerEntity && Number.isFinite(year) && getPeriodStatus(db, ledgerEntity, year) === 'locked') {
        throw new Error(`Zeitraum ${year} ist festgeschrieben (GoBD) — keine Rechnungsänderung möglich.`);
    }
}

/** Insert a new DRAFT invoice (unnumbered). Items get their per-line totals computed. */
export function createInvoiceDraft(db: LedgerDatabase, input: InvoiceDraftInput, at: string): StoredInvoice {
    const id = input.id ?? `si_${crypto.randomUUID()}`;
    const items = input.items.map(computeItemTotals);
    withTransaction(db, () => {
        db.prepare(
            `INSERT INTO invoices
               (id, entity_id, kind, status, contact_id, recipient_json, issue_date, due_date,
                performance_start, performance_end, currency, iban, buyer_reference, header, footer, terms,
                created_at, updated_at)
             VALUES(?, ?, 'invoice', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id,
            input.entityId,
            input.contactId ?? null,
            input.recipient ? JSON.stringify(input.recipient) : null,
            input.issueDate ?? null,
            input.dueDate ?? null,
            input.performanceStart ?? null,
            input.performanceEnd ?? null,
            input.currency ?? 'EUR',
            input.iban ?? null,
            input.buyerReference ?? null,
            input.header ?? null,
            input.footer ?? null,
            input.terms ?? null,
            at,
            at,
        );
        replaceItems(db, id, items);
        appendEvent(db, id, 'created', at);
    });
    return getInvoice(db, id) as StoredInvoice;
}

/** Update a DRAFT invoice's editable fields + items (throws unless still a draft). */
export function updateInvoiceDraft(db: LedgerDatabase, id: string, input: InvoiceDraftInput, at: string): StoredInvoice {
    const existing = getInvoice(db, id);
    if (!existing) throw new Error(`Rechnung ${id} nicht gefunden.`);
    assertDraft(existing, 'bearbeitet');
    const items = input.items.map(computeItemTotals);
    withTransaction(db, () => {
        db.prepare(
            `UPDATE invoices SET
               contact_id = ?, recipient_json = ?, issue_date = ?, due_date = ?,
               performance_start = ?, performance_end = ?, currency = ?, iban = ?, buyer_reference = ?,
               header = ?, footer = ?, terms = ?, updated_at = ?
             WHERE id = ?`,
        ).run(
            input.contactId ?? null,
            input.recipient ? JSON.stringify(input.recipient) : null,
            input.issueDate ?? null,
            input.dueDate ?? null,
            input.performanceStart ?? null,
            input.performanceEnd ?? null,
            input.currency ?? existing.currency,
            input.iban ?? null,
            input.buyerReference ?? null,
            input.header ?? null,
            input.footer ?? null,
            input.terms ?? null,
            at,
            id,
        );
        replaceItems(db, id, items);
        appendEvent(db, id, 'updated', at);
    });
    return getInvoice(db, id) as StoredInvoice;
}

/** Physically delete a DRAFT invoice (throws unless still a draft). Items + events go too. */
export function deleteInvoiceDraft(db: LedgerDatabase, id: string, _at: string): void {
    const existing = getInvoice(db, id);
    if (!existing) return;
    assertDraft(existing, 'gelöscht');
    // An unnumbered draft leaves no legal footprint, so its event trail is discarded too.
    // invoice_events has no ON DELETE CASCADE (audit rows must never vanish behind a finalized
    // invoice's back), so we clear them explicitly here inside the same transaction.
    withTransaction(db, () => {
        db.prepare(`DELETE FROM invoice_events WHERE invoice_id = ?`).run(id);
        db.prepare(`DELETE FROM invoices WHERE id = ?`).run(id);
    });
}

/** Context for finalizing: the resolved §14 issuer + recipient snapshots and the number prefix. */
export interface FinalizeContext {
    issuer: InvoiceIssuerSnapshot;
    recipient: InvoiceRecipient;
    /** Number-range prefix, e.g. "RE-" (defaults to DEFAULT_NUMBER_PREFIX). */
    prefix?: string;
    at: string;
}

/**
 * Finalize a DRAFT (draft → open): validate §14/§19, snapshot issuer+recipient, allocate the
 * fortlaufende Nummer, freeze totals. After this the invoice is immutable. `validate` is the
 * caller's job (validateInvoiceForFinalize) — this asserts the invariants it can't: draft state,
 * an open period, and issuer identity presence (a last-line guard).
 */
export function finalizeInvoice(db: LedgerDatabase, id: string, ctx: FinalizeContext): StoredInvoice {
    const existing = getInvoice(db, id);
    if (!existing) throw new Error(`Rechnung ${id} nicht gefunden.`);
    assertDraft(existing, 'festgeschrieben');
    if (!ctx.issuer.taxNumber?.trim() && !ctx.issuer.vatId?.trim()) {
        throw new Error('Aussteller: Steuernummer oder USt-IdNr. ist erforderlich (§14 UStG).');
    }
    assertPeriodOpen(db, existing.entityId, existing.issueDate);
    const prefix = ctx.prefix?.trim() || DEFAULT_NUMBER_PREFIX;
    const year = Number((existing.issueDate ?? ctx.at).slice(0, 4));
    const totals = computeInvoiceTotals(existing.items);
    withTransaction(db, () => {
        // The number is allocated INSIDE the tx, but the UPDATE is guarded by `status = 'draft'`:
        // if a concurrent finalize already flipped the row (TOCTOU — the pre-tx assertDraft read
        // takes no lock), this changes 0 rows and we roll back, undoing the sequence increment so
        // no gap and no second number for the same invoice (GoBD).
        const number = allocateInvoiceNumber(db, existing.entityId, prefix, year);
        const res = db
            .prepare(
                `UPDATE invoices SET
                   status = 'open', number = ?, issuer_json = ?, recipient_json = ?,
                   total_net = ?, total_vat = ?, total_gross = ?, finalized_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'draft'`,
            )
            .run(
                number,
                JSON.stringify(ctx.issuer),
                JSON.stringify(ctx.recipient),
                totals.net,
                totals.vat,
                totals.gross,
                ctx.at,
                ctx.at,
                id,
            );
        if (Number(res.changes) === 0) {
            throw new Error('Rechnung wurde zwischenzeitlich geändert — vermutlich bereits festgeschrieben.');
        }
        appendEvent(db, id, 'finalized', ctx.at, { number });
    });
    return getInvoice(db, id) as StoredInvoice;
}

/** Mark an OPEN invoice paid (open → paid), optionally linking the settling transaction. */
export function markInvoicePaid(
    db: LedgerDatabase,
    id: string,
    opts: { txId?: string | null; paidAt: string },
    at: string,
): StoredInvoice {
    const existing = getInvoice(db, id);
    if (!existing) throw new Error(`Rechnung ${id} nicht gefunden.`);
    if (existing.status !== 'open') {
        throw new Error(`Rechnung ${existing.number ?? id} ist ${existing.status}, nicht offen — kann nicht als bezahlt markiert werden.`);
    }
    assertPeriodOpen(db, existing.entityId, existing.issueDate);
    withTransaction(db, () => {
        // Guarded by `status = 'open'` so a concurrent markPaid/storno can't double-transition.
        const res = db
            .prepare(`UPDATE invoices SET status = 'paid', paid_at = ?, paid_tx_id = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
            .run(opts.paidAt, opts.txId ?? null, at, id);
        if (Number(res.changes) === 0) {
            throw new Error('Rechnung wurde zwischenzeitlich geändert — nicht mehr offen.');
        }
        appendEvent(db, id, 'paid', at, { paidAt: opts.paidAt, txId: opts.txId ?? null });
    });
    return getInvoice(db, id) as StoredInvoice;
}

/**
 * Cancel a finalized invoice by issuing a storno (Stornorechnung): a negated counter-invoice with
 * its own consecutive number, created finalized in the SAME transaction; the original moves to
 * 'cancelled'. Refuses if the original is a draft/already cancelled or already has a storno.
 */
export function createStornoInvoice(
    db: LedgerDatabase,
    originalId: string,
    ctx: FinalizeContext & { reason?: string },
): { storno: StoredInvoice; original: StoredInvoice } {
    const original = getInvoice(db, originalId);
    if (!original) throw new Error(`Rechnung ${originalId} nicht gefunden.`);
    if (original.kind !== 'invoice') throw new Error('Eine Stornorechnung kann nicht storniert werden.');
    if (original.status !== 'open' && original.status !== 'paid') {
        throw new Error(`Rechnung ${original.number ?? originalId} ist ${original.status} und kann nicht storniert werden.`);
    }
    if (original.cancelledById) throw new Error('Für diese Rechnung existiert bereits eine Stornorechnung.');
    assertPeriodOpen(db, original.entityId, original.issueDate);
    const prefix = ctx.prefix?.trim() || DEFAULT_NUMBER_PREFIX;
    const year = Number(ctx.at.slice(0, 4));
    const stornoId = `si_${crypto.randomUUID()}`;
    // Negate every line so net/vat/gross flip sign; totals follow.
    const negatedItems: StoredInvoiceItem[] = original.items.map((it) => ({
        ...it,
        quantity: -it.quantity,
        net: -it.net,
        vat: -it.vat,
        gross: -it.gross,
    }));
    // Negate the FROZEN original totals rather than recompute from negated quantities — Math.round
    // is half-toward-+∞, so round(-x) ≠ -round(x) on a .5 boundary and a recompute would not exactly
    // reverse the original. A storno must be the exact inverse of what it cancels.
    const totals = {
        net: -original.totals.net,
        vat: -original.totals.vat,
        gross: -original.totals.gross,
    };
    withTransaction(db, () => {
        // Cancel the original FIRST, guarded by its finalized status: if a concurrent storno already
        // cancelled it (or it was paid→? changed), this changes 0 rows → rollback (no second storno,
        // no wasted number). Then insert the storno.
        const cancelRes = db
            .prepare(`UPDATE invoices SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('open', 'paid')`)
            .run(ctx.at, originalId);
        if (Number(cancelRes.changes) === 0) {
            throw new Error('Rechnung wurde zwischenzeitlich geändert — sie ist nicht mehr stornierbar.');
        }
        const number = allocateInvoiceNumber(db, original.entityId, prefix, year);
        db.prepare(
            `INSERT INTO invoices
               (id, entity_id, kind, status, number, contact_id, recipient_json, issuer_json,
                issue_date, due_date, performance_start, performance_end, currency, iban, buyer_reference,
                header, footer, terms, total_net, total_vat, total_gross, storno_of_id, finalized_at,
                created_at, updated_at)
             VALUES(?, ?, 'storno', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            stornoId,
            original.entityId,
            number,
            original.contactId,
            original.recipient ? JSON.stringify(original.recipient) : null,
            JSON.stringify(ctx.issuer),
            ctx.at.slice(0, 10),
            null,
            original.performanceStart,
            original.performanceEnd,
            original.currency,
            original.iban,
            original.buyerReference,
            original.header,
            `Stornorechnung zu Rechnung ${original.number ?? original.id}.${ctx.reason ? ` Grund: ${ctx.reason}` : ''}`,
            original.terms,
            totals.net,
            totals.vat,
            totals.gross,
            originalId,
            ctx.at,
            ctx.at,
            ctx.at,
        );
        replaceItems(db, stornoId, negatedItems);
        appendEvent(db, stornoId, 'finalized', ctx.at, { number, stornoOf: originalId });
        // Original already set to 'cancelled' at the top of the tx (guarded); just record the event.
        appendEvent(db, originalId, 'cancelled', ctx.at, { stornoId, number });
    });
    return { storno: getInvoice(db, stornoId) as StoredInvoice, original: getInvoice(db, originalId) as StoredInvoice };
}

/**
 * Record the archived PDF/XML document refs on a finalized invoice — the ONLY post-finalize
 * write. Archive-once: refuses to overwrite refs that are already set (a re-render must reuse
 * the stored artefacts, keeping the content-addressed archive tamper-evident).
 */
export function setArchivedDocuments(
    db: LedgerDatabase,
    id: string,
    refs: { dms: string; pdfDocumentId?: string; xmlDocumentId?: string },
    at: string,
): StoredInvoice {
    const existing = getInvoice(db, id);
    if (!existing) throw new Error(`Rechnung ${id} nicht gefunden.`);
    if (existing.status === 'draft') throw new Error('Ein Entwurf wird nicht archiviert (erst festschreiben).');
    if (existing.archive.pdfDocumentId && refs.pdfDocumentId && existing.archive.pdfDocumentId !== refs.pdfDocumentId) {
        throw new Error('Archiv-PDF ist bereits gesetzt und darf nicht überschrieben werden (archive-once).');
    }
    if (existing.archive.xmlDocumentId && refs.xmlDocumentId && existing.archive.xmlDocumentId !== refs.xmlDocumentId) {
        throw new Error('Archiv-XML ist bereits gesetzt und darf nicht überschrieben werden (archive-once).');
    }
    withTransaction(db, () => {
        db.prepare(
            `UPDATE invoices SET dms = ?, pdf_document_id = ?, xml_document_id = ?, updated_at = ? WHERE id = ?`,
        ).run(
            refs.dms,
            refs.pdfDocumentId ?? existing.archive.pdfDocumentId,
            refs.xmlDocumentId ?? existing.archive.xmlDocumentId,
            at,
            id,
        );
        appendEvent(db, id, 'archived', at, { dms: refs.dms });
    });
    return getInvoice(db, id) as StoredInvoice;
}

/** The append-only event trail for one invoice (oldest first). */
export function getInvoiceEvents(
    db: LedgerDatabase,
    id: string,
): Array<{ at: string; action: string; detail: Record<string, unknown> | null }> {
    const rows = db
        .prepare(`SELECT at, action, detail FROM invoice_events WHERE invoice_id = ? ORDER BY id`)
        .all(id) as unknown as Array<{ at: string; action: string; detail: string | null }>;
    return rows.map((r) => ({ at: r.at, action: r.action, detail: parseJson<Record<string, unknown>>(r.detail) }));
}
