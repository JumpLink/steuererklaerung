/**
 * Sync actions: match Qonto attachments to Paperless documents (read-only).
 */

import { listTransactions, getAttachment } from '../../clients/qonto/index.ts';
import { listDocuments, type Document } from '@steuererklaerung/paperless';
import type { Transaction, Attachment } from '../../clients/qonto/types.ts';
import { getLogger } from '../../lib/logger.ts';
import { fetchAllPages } from '@steuererklaerung/paperless';
import { loadPaperlessConfig } from '../../config/index.ts';

const log = getLogger('sync');
import { documentsForSide, matchAttachment } from './match.ts';
import type { AttachmentMatchResult } from './match.ts';

export interface MatchQontoPaperlessParams {
    bankAccountId?: string;
    iban?: string;
    settled_at_from?: string;
    settled_at_to?: string;
}

export interface TransactionMatchItem {
    transaction_id: string;
    emitted_at: string;
    settled_at: string | null;
    amount_cents: number;
    /** Transaction currency (e.g. EUR). */
    amount_currency: string;
    side: 'credit' | 'debit';
    /** Transaction label / counterparty name (e.g. "DIGITALOCEAN_COM"). */
    label?: string;
    /** SEPA reference / Verwendungszweck. */
    reference?: string | null;
    /** VAT amount from Qonto (in transaction currency). */
    vat_amount?: number | null;
    attachment_ids: string[];
    attachments: AttachmentMatchResult[];
    /**
     * For Sammelrechnungen (collective invoices): all transaction IDs sharing
     * the same attachment, with their amounts in cents.
     * Present only when an attachment is referenced by multiple transactions.
     */
    shared_attachment_transactions?: Array<{ transaction_id: string; amount_cents: number; side: 'credit' | 'debit' }>;
}

export interface MatchQontoPaperlessReport {
    transactions: TransactionMatchItem[];
}

async function loadAllDocumentsByType(documentTypeId: number): Promise<Document[]> {
    return fetchAllPages((page, pageSize) =>
        listDocuments({ page_size: pageSize, page, document_type_id: documentTypeId }),
    );
}

/**
 * Load Qonto transactions that have at least one attachment, with attachment metadata.
 */
async function loadQontoTransactionsWithAttachments(
    params: MatchQontoPaperlessParams,
): Promise<Array<{ transaction: Transaction; attachments: Attachment[] }>> {
    const transactions = await listTransactions({
        bankAccountId: params.bankAccountId,
        iban: params.iban,
        settled_at_from: params.settled_at_from,
        settled_at_to: params.settled_at_to,
    });
    const withAttachments = transactions.filter((t) => t.attachment_ids && t.attachment_ids.length > 0);
    const result: Array<{ transaction: Transaction; attachments: Attachment[] }> = [];
    for (const tx of withAttachments) {
        const attachments: Attachment[] = [];
        for (const aid of tx.attachment_ids ?? []) {
            try {
                const att = await getAttachment(aid);
                attachments.push(att);
            } catch (err) {
                log.warn(`Skipping attachment ${aid}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (attachments.length > 0) {
            result.push({ transaction: tx, attachments });
        }
    }
    return result;
}

/**
 * Match Qonto attachments to Paperless documents (read-only). Uses sync-config for document type IDs.
 */
export async function matchQontoPaperless(params: MatchQontoPaperlessParams): Promise<MatchQontoPaperlessReport> {
    const config = loadPaperlessConfig();
    const { incoming_invoice, outgoing_invoice } = config.document_type_ids;

    const [qontoData, docsIncoming, docsOutgoing] = await Promise.all([
        loadQontoTransactionsWithAttachments(params),
        loadAllDocumentsByType(incoming_invoice),
        loadAllDocumentsByType(outgoing_invoice),
    ]);

    const docsByType = {
        incoming_invoice: docsIncoming,
        outgoing_invoice: docsOutgoing,
    };

    // Build attachment→transactions map to detect Sammelrechnungen (collective invoices)
    const attachmentToTransactions = new Map<
        string,
        Array<{ transaction_id: string; amount_cents: number; side: 'credit' | 'debit' }>
    >();
    for (const { transaction: tx } of qontoData) {
        for (const attId of tx.attachment_ids ?? []) {
            if (!attachmentToTransactions.has(attId)) {
                attachmentToTransactions.set(attId, []);
            }
            attachmentToTransactions.get(attId)!.push({
                transaction_id: tx.id,
                amount_cents: tx.amount_cents,
                side: tx.side,
            });
        }
    }

    const transactions: TransactionMatchItem[] = [];

    for (const { transaction: tx, attachments } of qontoData) {
        const pool = documentsForSide(tx.side, docsByType);
        const attachmentResults: AttachmentMatchResult[] = attachments.map((att) =>
            matchAttachment(att, tx, pool, config),
        );

        // Check if any attachment is shared (Sammelrechnung)
        let sharedAttachmentTransactions: TransactionMatchItem['shared_attachment_transactions'];
        for (const attId of tx.attachment_ids ?? []) {
            const shared = attachmentToTransactions.get(attId);
            if (shared && shared.length > 1) {
                sharedAttachmentTransactions = shared;
                break;
            }
        }

        transactions.push({
            transaction_id: tx.id,
            emitted_at: tx.emitted_at,
            settled_at: tx.settled_at ?? null,
            amount_cents: tx.amount_cents,
            amount_currency: tx.currency || 'EUR',
            side: tx.side,
            label: tx.label,
            reference: tx.reference,
            vat_amount: tx.vat_amount ?? (tx.vat_amount_cents != null ? tx.vat_amount_cents / 100 : null),
            attachment_ids: tx.attachment_ids ?? [],
            attachments: attachmentResults,
            shared_attachment_transactions: sharedAttachmentTransactions,
        });
    }

    return { transactions };
}
