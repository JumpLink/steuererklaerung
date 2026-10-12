/**
 * Paperless-ngx as a {@link DmsProvider}. Wraps the existing Paperless client and the
 * period-listing logic in actions/reconcile-store.ts, mapping each Paperless `Document`
 * (+ its custom fields) to the back-end-agnostic {@link DmsDocument}.
 *
 * Read-only here: the EÜR receipt-join and the review cards consume `DmsDocument`; the
 * Paperless write/AI flows keep using the client directly. Credentials currently come
 * from the global env (`PAPERLESS_BASE_URL`/`PAPERLESS_API_TOKEN`) inside the client —
 * per-entity credentials are threaded in a later increment.
 */

import type { PaperlessFieldConfig } from './types.ts';
import {
    getDocument,
    updateDocument,
    downloadDocument,
    downloadThumbnail,
    type Document,
    listCorrespondents,
    listDocumentTypes,
    listTags,
    createCorrespondent,
    createDocumentType,
    createTag,
    fetchAllPages,
    resolvePaperlessConfig,
    type PaperlessConfig,
    type PaperlessCreds,
    type UpdateDocumentPayload,
    getCustomFieldValue,
    getStringField,
    mergeCustomFields,
    parseMonetaryValue,
    formatMonetaryValue,
    listDocuments,
    fetchAllPagesParallel,
} from '@steuererklaerung/paperless';
import { fetchInvoiceDocsInPeriod } from './reconcile.ts';
import type { DmsProvider, DmsDocument, DmsFile, DmsVocabularyEntry, DmsVocabularyKind } from './types.ts';
import { findVocabularyEntry } from './vocabulary.ts';

interface VocabMaps {
    correspondent: Map<number, string>;
    documentType: Map<number, string>;
    tag: Map<number, string>;
}

/** Document date used by the period filter: payment date, else invoice date, else created. */
function docDate(doc: Document, config: PaperlessFieldConfig): string | null {
    const cf = config.custom_field_ids;
    const settled = getCustomFieldValue(doc, cf.qonto_settled_at) as string | undefined;
    const invoice = getCustomFieldValue(doc, cf.invoice_date) as string | undefined;
    return (settled ?? invoice ?? doc.created)?.slice(0, 10) ?? null;
}

function directionOf(doc: Document, config: PaperlessFieldConfig): 'incoming' | 'outgoing' | null {
    const t = doc.document_type;
    if (t != null && t === config.document_type_ids.incoming_invoice) return 'incoming';
    if (t != null && t === config.document_type_ids.outgoing_invoice) return 'outgoing';
    return null;
}

function moneyOf(doc: Document, fieldId: number): number | null {
    return parseMonetaryValue(getCustomFieldValue(doc, fieldId))?.amount ?? null;
}

/**
 * The classification custom field holds "<kind>|<reason>" in one string (Paperless has no
 * structured field type that fits); anything else reads as not classified.
 */
function invoiceKindOf(
    doc: Document,
    config: PaperlessFieldConfig,
): Pick<DmsDocument, 'invoiceKind' | 'invoiceKindReason'> {
    const id = config.custom_field_ids.invoice_kind ?? 0;
    const raw = id > 0 ? getStringField(doc, id) : '';
    const [kind, ...reason] = raw.split('|');
    if (kind !== 'e-rechnung' && kind !== 'sonstige-rechnung') return { invoiceKind: null, invoiceKindReason: null };
    return { invoiceKind: kind, invoiceKindReason: reason.join('|') || null };
}

/** Paperless stores the select option id; the DMS-agnostic shape carries the label. */
function paymentStatusOf(doc: Document, config: PaperlessFieldConfig): string | null {
    const id = config.custom_field_ids.payment_status ?? 0;
    const raw = id > 0 ? getStringField(doc, id) : '';
    if (!raw) return null;
    for (const [label, optionId] of Object.entries(config.select_field_options?.payment_status ?? {})) {
        if (optionId === raw) return label;
    }
    return raw;
}

/** Map a Paperless document to the DMS-agnostic shape. `names` resolves correspondent/type/tag ids → names. */
function toDmsDocument(doc: Document, config: PaperlessFieldConfig, names?: VocabMaps): DmsDocument {
    const cf = config.custom_field_ids;
    const invNo = getCustomFieldValue(doc, cf.invoice_number);
    const linkedRaw = getCustomFieldValue(doc, cf.qonto_transaction_id);
    const linkedTxIds =
        linkedRaw == null
            ? []
            : String(linkedRaw)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
    return {
        id: String(doc.id),
        dms: 'paperless',
        title: doc.title,
        correspondent: doc.correspondent != null ? (names?.correspondent.get(doc.correspondent) ?? null) : null,
        documentType: doc.document_type != null ? (names?.documentType.get(doc.document_type) ?? null) : null,
        direction: directionOf(doc, config),
        created: docDate(doc, config),
        added: doc.added?.slice(0, 10) ?? null,
        tags: (doc.tags ?? []).map((t) => names?.tag.get(t)).filter((t): t is string => t != null),
        invoiceNumber: invNo != null ? String(invNo) : null,
        net: moneyOf(doc, cf.total_net),
        gross: moneyOf(doc, cf.total_gross),
        vat: moneyOf(doc, cf.tax_amount),
        linkedTxIds,
        mimeType: doc.mime_type ?? null,
        pageCount: doc.page_count ?? null,
        ocrText: null,
        ocrSource: null,
        aiNote: getStringField(doc, cf.ai_note) || null,
        ...invoiceKindOf(doc, config),
        paymentStatus: paymentStatusOf(doc, config),
        dueDate: getStringField(doc, cf.due_date ?? 0).slice(0, 10) || null,
        amountToPay: moneyOf(doc, cf.amount_to_pay ?? 0),
    };
}

export class PaperlessDmsProvider implements DmsProvider {
    readonly kind = 'paperless' as const;
    /** Resolved per-entity config, or undefined to use the global env credentials. */
    private readonly cfg: PaperlessConfig | undefined;
    /** Lazily-fetched id → name maps (documents only carry ids). Dropped when an entry is created. */
    private vocabCache: Partial<Record<DmsVocabularyKind, Map<number, string>>> = {};

    constructor(
        private readonly config: PaperlessFieldConfig,
        creds?: PaperlessCreds,
    ) {
        this.cfg = creds && (creds.url || creds.token) ? resolvePaperlessConfig(creds).config : undefined;
    }

    /** The server's own list for one kind, cached per provider instance. */
    private async vocabMap(kind: DmsVocabularyKind): Promise<Map<number, string>> {
        const hit = this.vocabCache[kind];
        if (hit) return hit;
        const lister = {
            correspondent: listCorrespondents,
            documentType: listDocumentTypes,
            tag: listTags,
        }[kind];
        const items = await fetchAllPages((page, pageSize) => lister({ page, page_size: pageSize }, this.cfg));
        const map = new Map(items.map((i) => [i.id, i.name] as [number, string]));
        this.vocabCache[kind] = map;
        return map;
    }

    /** Best-effort names for mapping documents: a failed lookup leaves names unresolved. */
    private async names(): Promise<VocabMaps> {
        const safe = async (k: DmsVocabularyKind) => {
            try {
                return await this.vocabMap(k);
            } catch {
                return new Map<number, string>();
            }
        };
        const [correspondent, documentType, tag] = await Promise.all([
            safe('correspondent'),
            safe('documentType'),
            safe('tag'),
        ]);
        return { correspondent, documentType, tag };
    }

    async listVocabulary(kind: DmsVocabularyKind): Promise<DmsVocabularyEntry[]> {
        return [...(await this.vocabMap(kind))].map(([id, name]) => ({ id: String(id), name }));
    }

    async createVocabularyEntry(kind: DmsVocabularyKind, name: string): Promise<DmsVocabularyEntry> {
        const create = { correspondent: createCorrespondent, documentType: createDocumentType, tag: createTag }[kind];
        const made = await create({ name }, this.cfg);
        delete this.vocabCache[kind];
        return { id: String(made.id), name: made.name };
    }

    async directionTypes(): Promise<{ incoming: string | null; outgoing: string | null }> {
        const types = await this.vocabMap('documentType');
        const ids = this.config.document_type_ids;
        return {
            incoming: ids.incoming_invoice > 0 ? (types.get(ids.incoming_invoice) ?? null) : null,
            outgoing: ids.outgoing_invoice > 0 ? (types.get(ids.outgoing_invoice) ?? null) : null,
        };
    }

    /** Name or id → Paperless id; an unknown reference is an error (never auto-created here). */
    private async idOf(kind: DmsVocabularyKind, ref: string): Promise<number> {
        const entry = findVocabularyEntry(await this.listVocabulary(kind), ref);
        if (!entry) throw new Error(`"${ref}" ist in Paperless nicht vorhanden (${kind}).`);
        return Number(entry.id);
    }

    async list(range: { from: string; to: string }): Promise<DmsDocument[]> {
        const [docs, names] = await Promise.all([
            fetchInvoiceDocsInPeriod(this.config, range, this.cfg),
            this.names(),
        ]);
        return docs.map((d) => toDmsDocument(d, this.config, names));
    }

    async get(id: string): Promise<DmsDocument | null> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) return null;
        try {
            const [doc, names] = await Promise.all([getDocument(numId, this.cfg), this.names()]);
            return toDmsDocument(doc, this.config, names);
        } catch {
            return null;
        }
    }

    async getFile(id: string): Promise<DmsFile | null> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) return null;
        try {
            const doc = await getDocument(numId, this.cfg);
            const bytes = await downloadDocument(numId, { original: true }, this.cfg);
            return { bytes, mimeType: doc.mime_type ?? 'application/octet-stream' };
        } catch {
            return null;
        }
    }

    /** Paperless renders a WebP thumbnail for every document (incl. PDFs) on consume. */
    async getThumbnail(id: string): Promise<DmsFile | null> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) return null;
        try {
            const bytes = await downloadThumbnail(numId, this.cfg);
            return { bytes, mimeType: 'image/webp' };
        } catch {
            return null;
        }
    }

    /** Documents carrying the configured inbox tag (`tag_ids.inbox`); empty when it is not configured. */
    async listInbox(): Promise<DmsDocument[]> {
        const inbox = this.config.tag_ids?.inbox ?? 0;
        if (inbox <= 0) return [];
        const [docs, names] = await Promise.all([
            fetchAllPagesParallel((page, pageSize) =>
                listDocuments({ tag_ids: [inbox], page, page_size: pageSize, ordering: 'id' }, this.cfg),
            ),
            this.names(),
        ]);
        return docs.map((d) => toDmsDocument(d, this.config, names));
    }

    async getText(id: string): Promise<string | null> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) return null;
        try {
            return (await getDocument(numId, this.cfg)).content ?? null;
        } catch {
            return null;
        }
    }

    /** Swap the inbox tag for the reviewed tag (the reviewed tag is skipped when not configured). */
    async markReviewed(id: string): Promise<void> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) throw new Error(`Ungültige Dokument-ID: ${id}`);
        const { inbox = 0, ai_reviewed: reviewed = 0 } = this.config.tag_ids ?? {};
        const doc = await getDocument(numId, this.cfg);
        const tags = doc.tags.filter((t) => t !== inbox);
        if (reviewed > 0 && !tags.includes(reviewed)) tags.push(reviewed);
        await updateDocument(numId, { tags }, this.cfg);
    }

    /**
     * Write the fields Paperless can take from a {@link DmsDocument} patch: title, document date,
     * correspondent, document type, direction (= the invoice type), tags (full replacement, by name or id),
     * invoice number, the money fields, KI-Hinweis and the payment triage. Fields whose custom
     * field is not configured are skipped silently; an unknown payment-status label is an error
     * (writing a raw label into a select field would store garbage).
     */
    async setMetadata(id: string, meta: Partial<DmsDocument>): Promise<void> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) throw new Error(`Ungültige Dokument-ID: ${id}`);
        const cf = this.config.custom_field_ids;
        const updates: Array<{ field: number; value: unknown }> = [];
        const put = (field: number | undefined, value: unknown) => {
            if (field && field > 0 && value !== undefined) updates.push({ field, value });
        };
        const money = (v: number | null | undefined) =>
            v === undefined ? undefined : v === null ? null : formatMonetaryValue(v, 'EUR');
        put(cf.invoice_number, meta.invoiceNumber);
        put(cf.total_net, money(meta.net));
        put(cf.total_gross, money(meta.gross));
        put(cf.tax_amount, money(meta.vat));
        put(cf.ai_note, meta.aiNote);
        put(cf.due_date, meta.dueDate);
        put(cf.amount_to_pay, money(meta.amountToPay));
        if (meta.paymentStatus !== undefined) {
            if (meta.paymentStatus === null) put(cf.payment_status, null);
            else {
                const optionId = this.config.select_field_options?.payment_status?.[meta.paymentStatus];
                if (!optionId)
                    throw new Error(`Zahlungsstatus "${meta.paymentStatus}" ist in Paperless nicht eingerichtet.`);
                put(cf.payment_status, optionId);
            }
        }
        const payload: UpdateDocumentPayload = {};
        if (meta.title != null) payload.title = meta.title;
        if (meta.created != null) payload.created = meta.created;
        // undefined = unchanged, null = clear
        if (meta.correspondent !== undefined)
            payload.correspondent = meta.correspondent === null ? null : await this.idOf('correspondent', meta.correspondent);
        // Direction is modelled as the invoice document type (document_type_ids), as everywhere else.
        if (meta.direction != null) {
            const typeId =
                meta.direction === 'incoming'
                    ? this.config.document_type_ids.incoming_invoice
                    : this.config.document_type_ids.outgoing_invoice;
            if (!typeId || typeId <= 0)
                throw new Error(`Richtung "${meta.direction}": document_type_ids ist in Paperless nicht eingerichtet.`);
            payload.document_type = typeId;
        }
        if (meta.documentType != null) {
            const typeId = await this.idOf('documentType', meta.documentType);
            if (payload.document_type != null && payload.document_type !== typeId)
                throw new Error('Dokumenttyp und Richtung widersprechen sich (die Richtung ist der Rechnungstyp).');
            payload.document_type = typeId;
        }
        if (meta.tags !== undefined)
            payload.tags = await Promise.all(meta.tags.map((t) => this.idOf('tag', t)));
        if (updates.length > 0) {
            const doc = await getDocument(numId, this.cfg);
            payload.custom_fields = mergeCustomFields(doc.custom_fields ?? [], updates);
        }
        if (Object.keys(payload).length > 0) await updateDocument(numId, payload, this.cfg);
    }

    /**
     * Link a document to a store transaction by appending the id to the `qonto_transaction_id`
     * custom field — the SAME field the reconciliation reads (→ {@link DmsDocument.linkedTxIds}), so
     * the gap report and "Offene Belege" stay consistent. Idempotent (a re-link is a no-op) and
     * Sammelrechnung-safe (the field is a comma-separated list). Deliberately writes ONLY the link
     * field: the automated reconciler (reconcileDocumentToStore) fills the extra bank-match
     * enrichment fields; the manual link keeps its Paperless footprint to the link itself.
     */
    async link(id: string, txId: string): Promise<void> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) throw new Error(`Ungültige Dokument-ID: ${id}`);
        const field = this.config.custom_field_ids.qonto_transaction_id;
        if (!field || field <= 0) throw new Error('Custom-Feld qonto_transaction_id ist nicht konfiguriert.');
        const doc = await getDocument(numId, this.cfg);
        const linked = String(getCustomFieldValue(doc, field) ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (linked.includes(txId)) return; // already linked → idempotent no-op
        const value = [...linked, txId].join(',');
        const merged = mergeCustomFields(doc.custom_fields ?? [], [{ field, value }]);
        await updateDocument(numId, { custom_fields: merged }, this.cfg);
    }

    /** Remove one txId from the `qonto_transaction_id` comma list — the inverse of {@link link}. */
    async unlink(id: string, txId: string): Promise<void> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) throw new Error(`Ungültige Dokument-ID: ${id}`);
        const field = this.config.custom_field_ids.qonto_transaction_id;
        if (!field || field <= 0) throw new Error('Custom-Feld qonto_transaction_id ist nicht konfiguriert.');
        const doc = await getDocument(numId, this.cfg);
        const linked = String(getCustomFieldValue(doc, field) ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (!linked.includes(txId)) return; // not linked → idempotent no-op
        const value = linked.filter((t) => t !== txId).join(',');
        const merged = mergeCustomFields(doc.custom_fields ?? [], [{ field, value }]);
        await updateDocument(numId, { custom_fields: merged }, this.cfg);
    }
}
