/**
 * Backend-agnostic inbox workflow over a {@link DmsProvider}: list the inbox, read a document,
 * propose metadata (dry run), apply it with the KI-Hinweis, set the payment status.
 *
 * The functions take the provider, not an entity, so Paperless and the built-in DMS run through the
 * same code and tests can pass a fake. Entity → provider resolution lives in the MCP/CLI frontends
 * (`resolveEntityDms`). The LLM is the CALLER (an agent): propose validates and diffs its proposal
 * against the document, it does not call a model itself.
 */

import { findVocabularyEntry } from '@steuererklaerung/dms';
import type { DmsDocument, DmsProvider, DmsVocabularyKind } from '@steuererklaerung/dms';
import { PAYMENT_STATUS_OPTIONS } from '../../lib/select-field-constants.ts';
import { buildAiNoteRationale } from '../paperless/review-metadata.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest document text handed to an agent in one call. */
export const MAX_TEXT_CHARS = 6000;

/** Tags to add to / remove from the document's current ones, by exact name or id. */
export interface TagsProposal {
    add?: string[];
    remove?: string[];
}

/** What an agent may change about a document. Absent = leave as is. */
export interface MetadataProposal {
    title?: string;
    /** Exact name or id from the DMS's own list (dms_list_correspondents). `null` clears it. */
    correspondent?: string | null;
    /** Exact name or id from the DMS's own list (dms_list_document_types). */
    documentType?: string;
    direction?: 'incoming' | 'outgoing';
    tags?: TagsProposal;
    /** Document date, YYYY-MM-DD. */
    created?: string;
    invoiceNumber?: string;
    net?: number;
    gross?: number;
    vat?: number;
    /** Create correspondent / type / tag names the DMS does not know yet. Off = unknown name is an error. */
    create?: boolean;
}

export type ProposalField = Exclude<keyof MetadataProposal, 'create'>;

export interface MetadataChange {
    field: ProposalField;
    from: unknown;
    to: unknown;
}

export interface VocabularyCreation {
    kind: DmsVocabularyKind;
    name: string;
}

export interface MetadataPreview {
    documentId: string;
    changes: MetadataChange[];
    /** The KI-Hinweis that apply would write (one German line, < 200 chars). */
    aiNote: string;
    /** Fields the back-end cannot write through the DMS interface. */
    notWritable: ProposalField[];
    /** List entries apply would create first (only with `create: true`). */
    creates: VocabularyCreation[];
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

export interface InboxFilter {
    /** Only documents added on/after this date or timestamp (ISO, compared as text). */
    addedSince?: string;
    /** Only documents added strictly before this date or timestamp. */
    addedBefore?: string;
    /** Keep at most this many, newest first. */
    limit?: number;
}

/** Newest first. `total` counts what matched the date filter, `count` what is returned after `limit`. */
export async function listInbox(provider: DmsProvider, filter: InboxFilter = {}) {
    if (!provider.listInbox) throw new Error('Dieses DMS kennt keinen Eingang.');
    const all = await provider.listInbox();
    const addedOf = (d: { added: string | null }) => d.added ?? '';
    const matched = all
        .filter(
            (d) =>
                (filter.addedSince === undefined || addedOf(d) >= filter.addedSince) &&
                (filter.addedBefore === undefined || addedOf(d) < filter.addedBefore),
        )
        .sort((a, b) => (addedOf(a) < addedOf(b) ? 1 : addedOf(a) > addedOf(b) ? -1 : 0));
    const docs = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return {
        dms: provider.kind,
        count: docs.length,
        total: matched.length,
        documents: docs.map(summarizeDmsDocument),
    };
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

const KIND_TOOL: Record<DmsVocabularyKind, string> = {
    correspondent: 'dms_list_correspondents',
    documentType: 'dms_list_document_types',
    tag: 'dms_list_tags',
};

/** The vocabulary of one provider, fetched once per call. */
function vocabularyResolver(provider: DmsProvider, create: boolean) {
    const lists = new Map<DmsVocabularyKind, Awaited<ReturnType<NonNullable<DmsProvider['listVocabulary']>>>>();
    const creates: VocabularyCreation[] = [];
    /** Canonical name for a reference; unknown = error, or a pending creation under `create`. */
    async function resolve(kind: DmsVocabularyKind, ref: string): Promise<string> {
        let list = lists.get(kind);
        if (!list) {
            list = await provider.listVocabulary!(kind);
            lists.set(kind, list);
        }
        const hit = findVocabularyEntry(list, ref);
        if (hit) return hit.name;
        const name = ref.trim();
        if (!create || name === '')
            throw new Error(
                `„${ref}" gibt es in diesem DMS nicht (${kind}). Liste: ${KIND_TOOL[kind]}; neu anlegen nur mit create: true.`,
            );
        if (!creates.some((c) => c.kind === kind && c.name === name)) creates.push({ kind, name });
        return name;
    }
    return { resolve, creates };
}

interface Plan {
    doc: DmsDocument;
    changes: MetadataChange[];
    notWritable: ProposalField[];
    creates: VocabularyCreation[];
    /** What setMetadata gets: canonical names, only the fields that differ. */
    patch: Partial<DmsDocument>;
}

/** Validate a proposal against the document and the DMS's lists; nothing is written. */
async function plan(provider: DmsProvider, id: string, p: MetadataProposal): Promise<Plan> {
    validateProposal(p);
    const doc = await provider.get(id);
    if (!doc) throw new Error(`Dokument ${id} nicht gefunden.`);
    const canList = provider.listVocabulary != null;
    const { resolve, creates } = vocabularyResolver(provider, p.create === true);
    const changes: MetadataChange[] = [];
    const notWritable: ProposalField[] = [];
    const patch: Partial<DmsDocument> = {};
    const change = (field: ProposalField, from: unknown, to: unknown) => {
        changes.push({ field, from, to });
    };

    if (p.title !== undefined && p.title !== doc.title) {
        change('title', doc.title, p.title);
        patch.title = p.title;
    }
    if (p.correspondent === null) {
        if (doc.correspondent !== null) {
            change('correspondent', doc.correspondent, null);
            patch.correspondent = null;
        }
    } else if (p.correspondent !== undefined) {
        if (!canList) notWritable.push('correspondent');
        else {
            const name = await resolve('correspondent', p.correspondent);
            if (name !== doc.correspondent) {
                change('correspondent', doc.correspondent, name);
                patch.correspondent = name;
            }
        }
    }

    // Back-ends that model direction as a document type (Paperless) get the type name for it.
    let documentType = p.documentType;
    if (p.direction !== undefined && provider.directionTypes) {
        const typeName = (await provider.directionTypes())[p.direction];
        if (!typeName)
            throw new Error(`Richtung „${p.direction}" ist in diesem DMS nicht als Dokumenttyp eingerichtet.`);
        if (documentType !== undefined && (await resolve('documentType', documentType)) !== typeName)
            throw new Error(
                `Richtung „${p.direction}" ist in diesem DMS der Dokumenttyp „${typeName}", nicht „${documentType}".`,
            );
        documentType = typeName;
    }
    if (documentType !== undefined) {
        if (!canList) notWritable.push('documentType');
        else {
            const name = await resolve('documentType', documentType);
            if (name !== doc.documentType) {
                change('documentType', doc.documentType, name);
                patch.documentType = name;
            }
        }
    }
    if (p.direction !== undefined && p.direction !== doc.direction) {
        change('direction', doc.direction, p.direction);
        patch.direction = p.direction;
    }

    if (p.tags !== undefined) {
        if (!canList) notWritable.push('tags');
        else {
            const add = await Promise.all((p.tags.add ?? []).map((t) => resolve('tag', t)));
            const remove = new Set(await Promise.all((p.tags.remove ?? []).map((t) => resolve('tag', t))));
            const next = doc.tags.filter((t) => !remove.has(t));
            for (const t of add) if (!next.includes(t)) next.push(t);
            if (next.length !== doc.tags.length || next.some((t, i) => t !== doc.tags[i])) {
                change('tags', doc.tags, next);
                patch.tags = next;
            }
        }
    }

    for (const field of ['created', 'net', 'gross', 'vat', 'invoiceNumber'] as const) {
        const to = p[field];
        if (to !== undefined && to !== doc[field]) {
            change(field, doc[field], to);
            (patch as Record<string, unknown>)[field] = to;
        }
    }
    return { doc, changes, notWritable, creates, patch };
}

/**
 * Dry run: what would change, which list entries would be created, and the KI-Hinweis that would
 * be written. Unknown correspondent / type / tag names are an error unless `create: true`. Writes
 * nothing. `model` is the provenance stamped into the note.
 */
export async function proposeMetadata(
    provider: DmsProvider,
    id: string,
    proposal: MetadataProposal,
    options: { model: string; today?: string },
): Promise<MetadataPreview> {
    const { doc, changes, notWritable, creates } = await plan(provider, id, proposal);
    const aiNote = buildAiNoteRationale({
        date: options.today ?? new Date().toISOString().slice(0, 10),
        model: options.model,
        correspondentName:
            (changes.find((c) => c.field === 'correspondent')?.to as string | undefined) ?? doc.correspondent,
        documentTypeName:
            (changes.find((c) => c.field === 'documentType')?.to as string | undefined) ?? doc.documentType,
    });
    return { documentId: id, changes, aiNote, notWritable, creates };
}

/**
 * Write a proposal plus the KI-Hinweis. Re-computes the plan first, so an applied proposal is
 * exactly what a dry run of the same input shows. The document leaves the inbox only when every
 * proposed field was written: a field the back-end cannot take keeps it there for a person.
 */
export async function applyMetadata(
    provider: DmsProvider,
    id: string,
    proposal: MetadataProposal,
    options: { model: string; today?: string; markReviewed?: boolean },
) {
    if (!provider.setMetadata) throw new Error('Dieses DMS unterstützt das Schreiben von Metadaten nicht.');
    const preview = await proposeMetadata(provider, id, proposal, options);
    const { patch } = await plan(provider, id, proposal);
    for (const c of preview.creates) {
        if (!provider.createVocabularyEntry) throw new Error('Dieses DMS kann keine Einträge anlegen.');
        await provider.createVocabularyEntry(c.kind, c.name);
    }
    await provider.setMetadata(id, { ...patch, aiNote: preview.aiNote });
    const complete = preview.notWritable.length === 0;
    const markReviewed = options.markReviewed !== false && complete && provider.markReviewed != null;
    if (markReviewed) await provider.markReviewed!(id);
    return {
        documentId: id,
        applied: preview.changes.map((c) => c.field),
        notWritable: preview.notWritable,
        created: preview.creates,
        aiNote: preview.aiNote,
        markedReviewed: markReviewed,
    };
}

/** The DMS's own list of document types, correspondents or tags. */
export async function listVocabulary(provider: DmsProvider, kind: DmsVocabularyKind) {
    if (!provider.listVocabulary) throw new Error('Dieses DMS kennt keine Listen.');
    const entries = (await provider.listVocabulary(kind)).sort((a, b) => a.name.localeCompare(b.name));
    return { dms: provider.kind, kind, count: entries.length, entries };
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
