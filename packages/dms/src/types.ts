/**
 * DMS (document-management) provider abstraction.
 *
 * The review UI and the EÜR receipt-join must work **independently of where the
 * receipt files live** — a self-hosted Paperless-ngx instance OR the built-in,
 * dependency-free DMS (the default, and the future native-GNOME-app target). Both
 * back-ends implement {@link DmsProvider} and yield the back-end-agnostic
 * {@link DmsDocument}; everything above (data cache, routes, the cards view) speaks
 * only this shape.
 *
 * Scope: this abstraction targets the **review + built-in-DMS** surface (list a
 * period's receipts, search, fetch a file, link to a transaction). The Paperless
 * write/AI "power flows" (extract, classify, push-to-*, setup) stay Paperless-specific.
 */

/** The fields a Dokumentregel can fill on a receipt. */
export type DmsRuleField = 'correspondent' | 'documentType' | 'category' | 'direction';

/**
 * WHICH Dokumentregel filled WHICH fields of a receipt (built-in DMS). `id` is stable (the rule's
 * pattern, lowercased), `label` is what a person reads after „via Regel". A field leaves `fields`
 * the moment someone edits it by hand — what is still listed is exactly what the rule is
 * responsible for, which is what the AI must not overwrite and what „Zurücknehmen" clears.
 */
export interface DmsRuleOrigin {
    id: string;
    label: string;
    fields: DmsRuleField[];
}

/**
 * Where a receipt came from, when it did not come from the person's own hand (built-in DMS). Today
 * only a mail: the sender's address (or name) and the message date — NEVER the subject or the body.
 */
export interface DmsOrigin {
    kind: 'mail';
    /** Sender as the From header gave it: a display name with address, or the bare address. */
    from: string;
    /** Message date, YYYY-MM-DD. */
    date: string;
}

/** A receipt/invoice document, normalized across back-ends. */
export interface DmsDocument {
    /** Provider-scoped id (Paperless: the numeric doc id as a string; built-in: a uuid). */
    id: string;
    dms: 'builtin' | 'paperless';
    title: string | null;
    correspondent: string | null;
    documentType: string | null;
    direction: 'incoming' | 'outgoing' | null;
    /** Document date (YYYY-MM-DD): the payment/invoice date the period filter uses. */
    created: string | null;
    /** When the document entered the DMS (YYYY-MM-DD). */
    added: string | null;
    tags: string[];
    invoiceNumber: string | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
    /** Linked store-transaction ids — already comma-split, empties removed. */
    linkedTxIds: string[];
    mimeType: string | null;
    pageCount: number | null;
    /** Full text, supplied by the AI (Vision) in one pass — see src/dms/extract.ts. */
    ocrText: string | null;
    /** Union deliberately left open for a future external OCR provider. */
    ocrSource: 'ai' | 'paperless' | null;
    /** KI-Hinweis: the AI's short German rationale/uncertainty note (Paperless `ai_note` custom
     *  field). null for the built-in DMS or when unset. Owner-facing, Paperless-authored text. */
    aiNote: string | null;
    /**
     * §14 UStG classification of the invoice file: an E-Rechnung (structured data set per EN 16931)
     * or a sonstige Rechnung. null when never classified. Set without AI, from the file itself.
     */
    invoiceKind?: 'e-rechnung' | 'sonstige-rechnung' | null;
    /** One German sentence saying why {@link invoiceKind} is what it is. */
    invoiceKindReason?: string | null;
    /** Booking category (SKR03 label, as the EÜR spells it). Built-in DMS only; Paperless keeps it as a custom field. */
    category?: string | null;
    /** Which Dokumentregel filled which field — built-in DMS only; null/absent = no rule involved. */
    ruleOrigin?: DmsRuleOrigin | null;
    /** Where the file came from besides an upload (a mail); built-in DMS only, null/absent = hand-added. */
    origin?: DmsOrigin | null;
}

/** The raw bytes of a document file plus its MIME type. */
export interface DmsFile {
    bytes: Uint8Array;
    mimeType: string;
}

/**
 * A document-management back-end. Read methods are mandatory (they feed the review
 * UI + the EÜR join); write methods are optional and only the built-in DMS implements
 * them in this slice.
 */
export interface DmsProvider {
    readonly kind: 'builtin' | 'paperless';
    /** All receipt/invoice documents whose date falls in the period. */
    list(range: { from: string; to: string }): Promise<DmsDocument[]>;
    /** One document by id, or null if it does not exist. */
    get(id: string): Promise<DmsDocument | null>;
    /** The original file bytes + MIME, or null if unavailable. */
    getFile(id: string): Promise<DmsFile | null>;
    /** A small preview image, if the back-end can produce one. */
    getThumbnail?(id: string): Promise<DmsFile | null>;

    // --- optional write surface (built-in DMS only, later increments) ---
    /** Store a new file and return its document record. `created` defaults to today; pass it
     * to land a not-yet-analyzed upload in the year the user is viewing. */
    store?(input: {
        bytes: Uint8Array;
        filename: string;
        mimeType?: string;
        created?: string;
        origin?: DmsOrigin;
    }): Promise<DmsDocument>;
    /** Merge AI-extracted metadata (incl. ocrText) into a document. */
    setMetadata?(id: string, meta: Partial<DmsDocument>): Promise<void>;
    /** Link a document to a store transaction. */
    link?(id: string, txId: string): Promise<void>;
    /** Remove one document ⇄ transaction link (the inverse of {@link link}) — powers Undo. */
    unlink?(id: string, txId: string): Promise<void>;
}

/**
 * Minimal structural view of the sync config the Paperless read-path needs — only the
 * custom-field and document-type ids it reads. The CLI's full `SyncConfig` is structurally
 * assignable to this, so the package stays free of the CLI's config module.
 */
export interface PaperlessFieldConfig {
    custom_field_ids: {
        qonto_settled_at: number;
        invoice_date: number;
        invoice_number: number;
        qonto_transaction_id: number;
        total_net: number;
        total_gross: number;
        tax_amount: number;
        /** Free-form AI annotation (KI-Hinweis). */
        ai_note: number;
        /** Paperless string field holding the invoice classification ("<kind>|<reason>"); 0/absent = not configured. */
        invoice_kind?: number;
    };
    document_type_ids: {
        incoming_invoice: number;
        outgoing_invoice: number;
    };
    /**
     * Paperless tag IDs whose documents are out of business scope (e.g. the per-person "* Privat"
     * tags on privately-paid purchases). Documents bearing any of these are excluded from the DMS
     * list — Beleg-Eingang, document browser and reconciliation. Optional (default: exclude nothing).
     */
    exclude_tag_ids?: number[];
}

/** Reconciliation gap report over a period: store coverage vs. linked DMS documents. */
export interface StoreReconciliationStatus {
    period: { from: string; to: string };
    accountKey?: string;
    store: {
        total: number;
        matched_to_document: number;
        no_receipt_needed: number;
        receipt_missing: number;
        unmatched_examples: Array<{
            id: string;
            bookingDate: string;
            amount: number;
            counterparty?: string;
            reference?: string;
        }>;
    };
    paperless: {
        total: number;
        with_store_match: number;
        without_store_match: number;
        without_store_match_ids: number[];
    };
}
