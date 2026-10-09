/**
 * Mail history of outgoing invoices on the SQLite `invoice_mails` table (schema v17).
 *
 * One row per send attempt, a failed one included with its cause. Metadata only: no body, no
 * attachment, no credential. `invoiceId` is the back-end id of the invoice (a Qonto client invoice
 * has no row in `invoices`, so there is no foreign key). The caller passes `at`, like the other repos.
 */

import type { LedgerDatabase } from '../ledger/db.ts';

export type InvoiceMailResult = 'sent' | 'failed';

export interface InvoiceMailRecord {
    id: number;
    entityId: string;
    invoiceId: string;
    invoiceNumber: string | null;
    at: string;
    from: string;
    to: string[];
    subject: string;
    messageId: string | null;
    result: InvoiceMailResult;
    error: string | null;
}

export type InvoiceMailInput = Omit<InvoiceMailRecord, 'id'>;

interface MailRow {
    id: number;
    entity_id: string;
    invoice_id: string;
    invoice_number: string | null;
    at: string;
    from_address: string;
    recipients: string;
    subject: string;
    message_id: string | null;
    result: string;
    error: string | null;
}

function rowToRecord(row: MailRow): InvoiceMailRecord {
    let to: string[] = [];
    try {
        const parsed: unknown = JSON.parse(row.recipients);
        if (Array.isArray(parsed)) to = parsed.map(String);
    } catch {
        // A damaged row still lists as an attempt, just without recipients.
    }
    return {
        id: row.id,
        entityId: row.entity_id,
        invoiceId: row.invoice_id,
        invoiceNumber: row.invoice_number,
        at: row.at,
        from: row.from_address,
        to,
        subject: row.subject,
        messageId: row.message_id,
        result: row.result === 'sent' ? 'sent' : 'failed',
        error: row.error,
    };
}

/** Append one send attempt; returns its row id. */
export function recordInvoiceMail(db: LedgerDatabase, input: InvoiceMailInput): number {
    const res = db
        .prepare(
            `INSERT INTO invoice_mails (entity_id, invoice_id, invoice_number, at, from_address, recipients, subject, message_id, result, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.entityId,
            input.invoiceId,
            input.invoiceNumber,
            input.at,
            input.from,
            JSON.stringify(input.to),
            input.subject,
            input.messageId,
            input.result,
            input.error,
        );
    return Number(res.lastInsertRowid);
}

/** The attempts for one invoice, newest first. */
export function listInvoiceMails(db: LedgerDatabase, entityId: string, invoiceId: string): InvoiceMailRecord[] {
    const rows = db
        .prepare(`SELECT * FROM invoice_mails WHERE entity_id = ? AND invoice_id = ? ORDER BY at DESC, id DESC`)
        .all(entityId, invoiceId) as unknown as MailRow[];
    return rows.map(rowToRecord);
}

/** Every attempt of an entity, newest first (for the list badges: one query, grouped by the caller). */
export function listEntityInvoiceMails(db: LedgerDatabase, entityId: string): InvoiceMailRecord[] {
    const rows = db
        .prepare(`SELECT * FROM invoice_mails WHERE entity_id = ? ORDER BY at DESC, id DESC`)
        .all(entityId) as unknown as MailRow[];
    return rows.map(rowToRecord);
}
