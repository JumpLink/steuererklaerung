/**
 * Matching logic: Qonto attachment + transaction side vs Paperless documents.
 * 1. Prefer match by Qonto custom fields (qonto_transaction_id + qonto_attachment_id); if all fields match → skip, else → needsUpdate.
 * 2. Else match by filename (normalized) and optional date proximity.
 */

import type { Attachment } from '../../clients/qonto/types.ts';
import { type Document, getCustomFieldValue, getStringField } from '@steuererklaerung/paperless';
import type { Transaction } from '../../clients/qonto/types.ts';
import { DEFAULTS } from '../../constants.ts';
import { toDateOnly as toDateOnlyHelper } from '@steuererklaerung/shared';

/** Config slice needed for Qonto-ID matching and needsUpdate check. */
export interface SyncConfigMatchSlice {
    custom_field_ids: {
        qonto_transaction_id: number;
        qonto_attachment_id: number;
        qonto_transaction_amount: number;
        qonto_settled_at: number;
        qonto_currency: number;
        qonto_label: number;
    };
}

export interface MatchCandidate {
    id: number;
    title: string | null;
    original_file_name: string | null;
    created: string | null;
    document_type: number | null;
    reason?: string;
    /** True when document was matched by Qonto IDs but transaction amount/date differ from stored values. */
    needsUpdate?: boolean;
    /** True when document was matched by filename only; Qonto metadata can be written to link it. */
    needsLink?: boolean;
}

/**
 * Find a document in the pool that has the given Qonto transaction and attachment IDs.
 * If found, compare amount and settled_at to current transaction to set needsUpdate.
 */
function findDocumentByQontoIds(
    pool: Document[],
    transactionId: string,
    attachmentId: string,
    tx: Transaction,
    config: SyncConfigMatchSlice,
): { doc: Document; needsUpdate: boolean } | null {
    const {
        qonto_transaction_id: fieldTxId,
        qonto_attachment_id: fieldAttId,
        qonto_transaction_amount: fieldAmount,
        qonto_settled_at: fieldDate,
        qonto_currency: fieldCurrency,
    } = config.custom_field_ids;
    if (!fieldTxId || !fieldAttId) return null;

    for (const doc of pool) {
        const docTxId = getCustomFieldValue(doc, fieldTxId);
        const docAttId = getCustomFieldValue(doc, fieldAttId);
        // For Sammelrechnungen: match by attachment_id alone (multiple transactions share the same attachment).
        // For regular invoices: match by both transaction_id AND attachment_id.
        const txMatches = docTxId === transactionId;
        const attMatches = docAttId === attachmentId;
        if (!attMatches) continue;
        if (!txMatches && !attMatches) continue;

        let needsUpdate = false;
        if (fieldAmount) {
            const expectedAmount =
                tx.side === 'debit' ? -Math.abs(tx.amount_cents) / 100 : Math.abs(tx.amount_cents) / 100;
            const docAmount = Number(getCustomFieldValue(doc, fieldAmount));
            if (Number.isNaN(docAmount) || Math.abs(docAmount - expectedAmount) >= 0.005) needsUpdate = true;
        }
        if (fieldDate && !needsUpdate) {
            const expectedDate = toDateOnlyHelper(tx.settled_at ?? tx.emitted_at);
            const docDate = getCustomFieldValue(doc, fieldDate);
            const docDateStr = typeof docDate === 'string' ? docDate.slice(0, 10) : undefined;
            if (expectedDate && docDateStr !== expectedDate) needsUpdate = true;
        }
        if (fieldCurrency && !needsUpdate) {
            const docCurrency = getStringField(doc, fieldCurrency);
            const expectedCurrency = (tx.currency || 'EUR').trim();
            if (docCurrency !== expectedCurrency) needsUpdate = true;
        }
        // Check if new fields (label, reference, vat_amount) are missing and should be backfilled
        const { qonto_label: fieldLabel } = config.custom_field_ids;
        if (fieldLabel && !needsUpdate && tx.label) {
            const docLabel = getStringField(doc, fieldLabel);
            if (!docLabel) needsUpdate = true;
        }
        return { doc, needsUpdate };
    }
    return null;
}

export interface AttachmentMatchResult {
    attachment_id: string;
    file_name: string | null | undefined;
    file_size: number | undefined;
    file_content_type: string | null | undefined;
    matched: boolean;
    candidates: MatchCandidate[];
}

const DATE_DAYS_TOLERANCE = DEFAULTS.DATE_TOLERANCE_DAYS;

/**
 * Normalize filename for comparison: lowercase, trim, optional strip suffix like " (1)".
 */
export function normalizeFileName(name: string | null | undefined): string {
    if (name == null || name === '') return '';
    let s = name.trim().toLowerCase();
    const idx = s.lastIndexOf('.');
    const base = idx >= 0 ? s.slice(0, idx) : s;
    const ext = idx >= 0 ? s.slice(idx) : '';
    const withoutSuffix = base.replace(/\s*\(\d+\)\s*$/, '').trim();
    return withoutSuffix + ext || s;
}

/**
 * Check if transaction date and document date are within tolerance (days).
 */
function datesWithinTolerance(
    txDate: string | null,
    docDate: string | null,
    days: number = DATE_DAYS_TOLERANCE,
): boolean {
    if (txDate == null || docDate == null) return true;
    const a = new Date(txDate).getTime();
    const b = new Date(docDate).getTime();
    const diffMs = days * 24 * 60 * 60 * 1000;
    return Math.abs(a - b) <= diffMs;
}

/**
 * Select documents for the given transaction side.
 * credit (incoming) → outgoing_invoice docs; debit (outgoing) → incoming_invoice docs.
 */
export function documentsForSide(
    side: 'credit' | 'debit',
    docsByType: { incoming_invoice: Document[]; outgoing_invoice: Document[] },
): Document[] {
    return side === 'credit' ? docsByType.outgoing_invoice : docsByType.incoming_invoice;
}

/**
 * Find Paperless document candidates for a Qonto attachment.
 * Pool is already filtered by transaction side → document type.
 */
export function findCandidates(attachment: Attachment, transaction: Transaction, pool: Document[]): MatchCandidate[] {
    const normQonto = normalizeFileName(attachment.file_name);
    if (!normQonto) {
        return [];
    }
    const txDate = toDateOnlyHelper(transaction.settled_at ?? transaction.emitted_at);
    const candidates: MatchCandidate[] = [];

    for (const doc of pool) {
        const normDoc = normalizeFileName(doc.original_file_name);
        const dateOk = datesWithinTolerance(txDate, doc.created ?? doc.added ?? null);
        const candidate: MatchCandidate = {
            id: doc.id,
            title: doc.title,
            original_file_name: doc.original_file_name,
            created: doc.created ?? doc.added ?? null,
            document_type: doc.document_type,
        };

        if (normDoc === normQonto) {
            // Exact filename match — strong signal, include regardless of date proximity
            candidates.push({ ...candidate, reason: dateOk ? 'filename_exact' : 'filename_exact_no_date' });
        } else if (normDoc.includes(normQonto) || normQonto.includes(normDoc)) {
            // Partial filename match — weaker signal
            candidates.push({ ...candidate, reason: dateOk ? 'filename_fuzzy' : 'filename_fuzzy_no_date' });
        }
    }

    return candidates;
}

/**
 * Build match result for one attachment. If config is provided, first tries match by Qonto IDs.
 */
export function matchAttachment(
    attachment: Attachment,
    transaction: Transaction,
    pool: Document[],
    config?: SyncConfigMatchSlice | null,
): AttachmentMatchResult {
    if (config) {
        const byQonto = findDocumentByQontoIds(pool, transaction.id, attachment.id, transaction, config);
        if (byQonto) {
            const { doc, needsUpdate } = byQonto;
            return {
                attachment_id: attachment.id,
                file_name: attachment.file_name,
                file_size: attachment.file_size,
                file_content_type: attachment.file_content_type,
                matched: true,
                candidates: [
                    {
                        id: doc.id,
                        title: doc.title,
                        original_file_name: doc.original_file_name,
                        created: doc.created ?? doc.added ?? null,
                        document_type: doc.document_type,
                        reason: 'qonto_ids',
                        needsUpdate,
                    },
                ],
            };
        }
    }
    const candidates = findCandidates(attachment, transaction, pool);
    const candidatesWithLink = candidates.map((c) => ({ ...c, needsLink: true }));
    return {
        attachment_id: attachment.id,
        file_name: attachment.file_name,
        file_size: attachment.file_size,
        file_content_type: attachment.file_content_type,
        matched: candidatesWithLink.length > 0,
        candidates: candidatesWithLink,
    };
}
