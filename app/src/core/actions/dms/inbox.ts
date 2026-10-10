/**
 * Backend-agnostic inbox workflow over a {@link DmsProvider}: list the inbox, read a document,
 * propose metadata (dry run), apply it with the KI-Hinweis, set the payment status.
 *
 * The functions take the provider, not an entity, so Paperless and the built-in DMS run through the
 * same code and tests can pass a fake. Entity → provider resolution lives in the MCP/CLI frontends
 * (`resolveEntityDms`). The LLM is the CALLER (an agent): propose validates and diffs its proposal
 * against the document, it does not call a model itself.
 */

import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';
import { PAYMENT_STATUS_OPTIONS } from '../../lib/select-field-constants.ts';
import { buildAiNoteRationale } from '../paperless/review-metadata.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest document text handed to an agent in one call. */
export const MAX_TEXT_CHARS = 6000;

/** What an agent may change about a document. Absent = leave as is. */
export interface MetadataProposal {
    title?: string;
    correspondent?: string;
    documentType?: string;
    direction?: 'incoming' | 'outgoing';
    /** Document date, YYYY-MM-DD. */
    created?: string;
    invoiceNumber?: string;
    net?: number;
    gross?: number;
    vat?: number;
}

export type ProposalField = keyof MetadataProposal;

export interface MetadataChange {
    field: ProposalField;
    from: unknown;
    to: unknown;
}

export interface MetadataPreview {
    documentId: string;
    changes: MetadataChange[];
    /** The KI-Hinweis that apply would write (one German line, < 200 chars). */
    aiNote: string;
    /** Fields the back-end cannot write through the DMS interface. */
    notWritable: ProposalField[];
}

/** Compact, list-friendly view of a document. */
export function summarizeDmsDocument(doc: DmsDocument) {
    return {
        id: doc.id,
        dms: doc.dms,
        title: doc.title,
        correspondent: doc.correspondent,
        documentType: doc.documentType,
        direction: doc.direction,
        created: doc.created,
        added: doc.added,
        invoiceNumber: doc.invoiceNumber,
        gross: doc.gross,
        paymentStatus: doc.paymentStatus ?? null,
        dueDate: doc.dueDate ?? null,
        linkedTransactions: doc.linkedTxIds.length,
        aiNote: doc.aiNote,
    };
}

/** Paperless cannot resolve names to ids through the DMS interface; these stay with paperless_update_document. */
const PAPERLESS_NOT_WRITABLE: readonly ProposalField[] = ['correspondent', 'documentType', 'direction'];

export async function listInbox(provider: DmsProvider) {
    if (!provider.listInbox) throw new Error('Dieses DMS kennt keinen Eingang.');
    const docs = await provider.listInbox();
    return { dms: provider.kind, count: docs.length, documents: docs.map(summarizeDmsDocument) };
}

export async function getDocumentWithText(provider: DmsProvider, id: string) {
    const doc = await provider.get(id);
    if (!doc) throw new Error(`Dokument ${id} nicht gefunden.`);
    const text = provider.getText ? await provider.getText(id) : doc.ocrText;
    const truncated = text != null && text.length > MAX_TEXT_CHARS;
    return {
        ...summarizeDmsDocument(doc),
        net: doc.net,
        vat: doc.vat,
        amountToPay: doc.amountToPay ?? null,
        tags: doc.tags,
        linkedTxIds: doc.linkedTxIds,
        text: text == null ? null : text.slice(0, MAX_TEXT_CHARS),
        textTruncated: truncated,
    };
}

function validateProposal(p: MetadataProposal): void {
    if (p.created !== undefined && !DATE_RE.test(p.created)) throw new Error('created muss YYYY-MM-DD sein.');
    if (p.title !== undefined && p.title.trim() === '') throw new Error('title darf nicht leer sein.');
}

/** Turn a proposal into the patch: only fields that actually differ from the document. */
function diff(doc: DmsDocument, p: MetadataProposal): MetadataChange[] {
    const changes: MetadataChange[] = [];
    const keys = Object.keys(p) as ProposalField[];
    for (const field of keys) {
        const to = p[field];
        if (to === undefined) continue;
        const from = doc[field];
        if (from !== to) changes.push({ field, from, to });
    }
    return changes;
}

/**
 * Dry run: what would change, and the KI-Hinweis that would be written. Writes nothing.
 * `model` is the provenance stamped into the note.
 */
export async function proposeMetadata(
    provider: DmsProvider,
    id: string,
    proposal: MetadataProposal,
    options: { model: string; today?: string },
): Promise<MetadataPreview> {
    validateProposal(proposal);
    const doc = await provider.get(id);
    if (!doc) throw new Error(`Dokument ${id} nicht gefunden.`);
    const changes = diff(doc, proposal);
    const notWritable =
        provider.kind === 'paperless'
            ? changes.map((c) => c.field).filter((f) => PAPERLESS_NOT_WRITABLE.includes(f))
            : [];
    const aiNote = buildAiNoteRationale({
        date: options.today ?? new Date().toISOString().slice(0, 10),
        model: options.model,
        correspondentName: proposal.correspondent ?? doc.correspondent,
        documentTypeName: proposal.documentType ?? doc.documentType,
    });
    return { documentId: id, changes, aiNote, notWritable };
}

/**
 * Write a proposal plus the KI-Hinweis, and take the document out of the inbox. Re-computes the
 * diff first, so an applied proposal is exactly what a dry run of the same input shows.
 */
export async function applyMetadata(
    provider: DmsProvider,
    id: string,
    proposal: MetadataProposal,
    options: { model: string; today?: string; markReviewed?: boolean },
) {
    if (!provider.setMetadata) throw new Error('Dieses DMS unterstützt das Schreiben von Metadaten nicht.');
    const preview = await proposeMetadata(provider, id, proposal, options);
    const skip = new Set<ProposalField>(preview.notWritable);
    const patch: Partial<DmsDocument> = { aiNote: preview.aiNote };
    for (const c of preview.changes) {
        if (!skip.has(c.field)) (patch as Record<string, unknown>)[c.field] = c.to;
    }
    await provider.setMetadata(id, patch);
    const markReviewed = options.markReviewed !== false && provider.markReviewed != null;
    if (markReviewed) await provider.markReviewed!(id);
    return {
        documentId: id,
        applied: preview.changes.filter((c) => !skip.has(c.field)).map((c) => c.field),
        notWritable: preview.notWritable,
        aiNote: preview.aiNote,
        markedReviewed: markReviewed,
    };
}

export interface PaymentUpdate {
    status: (typeof PAYMENT_STATUS_OPTIONS)[number];
    dueDate?: string;
    amountToPay?: number;
    /** Optional replacement for the KI-Hinweis (one line, < 200 chars). */
    aiNote?: string;
}

export async function setPaymentStatus(provider: DmsProvider, id: string, update: PaymentUpdate) {
    if (!provider.setMetadata) throw new Error('Dieses DMS unterstützt das Schreiben von Metadaten nicht.');
    if (!(PAYMENT_STATUS_OPTIONS as readonly string[]).includes(update.status))
        throw new Error(
            `Unbekannter Zahlungsstatus „${update.status}". Erlaubt: ${PAYMENT_STATUS_OPTIONS.join(', ')}.`,
        );
    if (update.dueDate !== undefined && !DATE_RE.test(update.dueDate)) throw new Error('dueDate muss YYYY-MM-DD sein.');
    if (!(await provider.get(id))) throw new Error(`Dokument ${id} nicht gefunden.`);
    const patch: Partial<DmsDocument> = { paymentStatus: update.status };
    if (update.dueDate !== undefined) patch.dueDate = update.dueDate;
    if (update.amountToPay !== undefined) patch.amountToPay = update.amountToPay;
    if (update.aiNote !== undefined) patch.aiNote = update.aiNote.slice(0, 199);
    await provider.setMetadata(id, patch);
    return { documentId: id, paymentStatus: update.status };
}
