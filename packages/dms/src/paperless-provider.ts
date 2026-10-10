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
import type { DmsProvider, DmsDocument, DmsFile } from './types.ts';

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

/** Map a Paperless document to the DMS-agnostic shape. `corr` resolves the correspondent id → name. */
function toDmsDocument(doc: Document, config: PaperlessFieldConfig, corr?: Map<number, string>): DmsDocument {
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
        correspondent: doc.correspondent != null ? (corr?.get(doc.correspondent) ?? null) : null,
        documentType: null,
        direction: directionOf(doc, config),
        created: docDate(doc, config),
        added: doc.added?.slice(0, 10) ?? null,
        tags: [],
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
    /** Lazily-fetched correspondent id → name map (Paperless documents only carry the id). */
    private corrCache: Map<number, string> | null = null;

    constructor(
        private readonly config: PaperlessFieldConfig,
        creds?: PaperlessCreds,
    ) {
        this.cfg = creds && (creds.url || creds.token) ? resolvePaperlessConfig(creds).config : undefined;
    }

    /** Fetch + cache the correspondent id → name map (best-effort: failure leaves names unresolved). */
    private async correspondentNames(): Promise<Map<number, string>> {
        if (this.corrCache) return this.corrCache;
        const map = new Map<number, string>();
        try {
            for (let page = 1; page <= 100; page++) {
                const resp = await listCorrespondents({ page, page_size: 100 }, this.cfg);
                for (const c of resp.results) map.set(c.id, c.name);
                if (!resp.next || resp.results.length === 0) break;
            }
        } catch {
            // leave names unresolved — the card just shows no correspondent
        }
        this.corrCache = map;
        return map;
    }

    async list(range: { from: string; to: string }): Promise<DmsDocument[]> {
        const [docs, corr] = await Promise.all([
            fetchInvoiceDocsInPeriod(this.config, range, this.cfg),
            this.correspondentNames(),
        ]);
        return docs.map((d) => toDmsDocument(d, this.config, corr));
    }

    async get(id: string): Promise<DmsDocument | null> {
        const numId = Number(id);
        if (!Number.isFinite(numId)) return null;
        try {
            const [doc, corr] = await Promise.all([getDocument(numId, this.cfg), this.correspondentNames()]);
            return toDmsDocument(doc, this.config, corr);
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
        const [docs, corr] = await Promise.all([
            fetchAllPagesParallel((page, pageSize) =>
                listDocuments({ tag_ids: [inbox], page, page_size: pageSize, ordering: 'id' }, this.cfg),
            ),
            this.correspondentNames(),
        ]);
        return docs.map((d) => toDmsDocument(d, this.config, corr));
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
