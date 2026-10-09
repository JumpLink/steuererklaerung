/**
 * Storing a receipt — the shared action behind every "Beleg hinzufügen" surface.
 *
 * The rules here are not transport details, and that is why they live in the core rather than in a
 * Hono handler: which file types may be stored at all, what date an un-analysed upload lands on,
 * and how big a file is allowed to be. Each one has a reason that outlives whichever frontend asked:
 *
 *   - **The type allowlist is a security boundary.** The web UI serves stored receipts back INLINE,
 *     so an `image/svg+xml` or a `text/html` "receipt" would run script in the app's own origin.
 *     Blocking that at the storage door rather than at the serving door means the native app cannot
 *     quietly write a file the web UI would then refuse to show — or worse, show.
 *   - **The date is deliberate.** A freshly uploaded receipt has no extracted invoice date yet, so
 *     it is stamped into the YEAR the user is looking at; otherwise it vanishes out of the view it
 *     was just added to. The real date overwrites it once the document is analysed or edited.
 *
 * Extracted from `frontends/web/document-routes.ts`, which held the only copy. The native app now
 * calls the same function, so a receipt added there is the same receipt the web UI would have made.
 */

import {
    analyzeDocument,
    extractPdfText,
    type AnalyzeResult,
    type DmsDocument,
    type DmsOrigin,
    type DmsProvider,
} from '@steuererklaerung/dms';
import { getLogger } from '../lib/logger.ts';
import { eInvoiceToReceiptMetadata, readEInvoice } from '../invoices/e-rechnung/index.ts';
import { behalteRegelFelder, type DokumentRegel } from '../dokumentregeln/regeln.ts';
import { applyDokumentRegeln, loadDokumentRegeln } from './dokumentregeln.ts';

const log = getLogger('documents');

/**
 * Content types that may be stored — the ones a browser cannot execute script from.
 *
 * Deliberately an allowlist, not a blocklist of dangerous types: the set of things a browser will
 * happily run is open-ended, and a receipt is realistically a PDF or a photo.
 */
const ALLOWED_TYPES = new Set([
    'application/pdf',
    'application/xml',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

const EXT_TO_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    xml: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};

/** The file patterns a picker should offer, derived from the same allowlist. */
export const RECEIPT_PATTERNS = ['*.pdf', '*.xml', '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif'];

/** Human list of the accepted formats, for an error message or a dialog subtitle. */
export const RECEIPT_FORMATS_LABEL = 'PDF, XML (E-Rechnung), PNG, JPEG, WebP oder GIF';

/**
 * Resolve an upload's effective content type: the declared MIME if it is allowed, else the
 * extension. `null` means "not storable" — the caller must refuse rather than guess.
 */
export function effectiveReceiptType(mime: string | undefined, filename: string | undefined): string | null {
    const declared = (mime ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase()
        .replace(/^text\/xml$/, 'application/xml');
    if (ALLOWED_TYPES.has(declared)) return declared;
    const ext = /\.([a-zA-Z0-9]+)$/.exec(filename ?? '')?.[1]?.toLowerCase();
    return ext && EXT_TO_MIME[ext] ? EXT_TO_MIME[ext] : null;
}

/**
 * Largest receipt we accept, in bytes.
 *
 * The web transport carried a base64 cap (~22 MB of encoded text); the real limit is about the file,
 * so it belongs here in bytes and the transport can derive its own from it. A scanned multi-page
 * invoice is comfortably under this; anything far above it is a scan setting, not a receipt.
 */
export const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;

export interface StoreReceiptInput {
    bytes: Uint8Array;
    filename: string;
    /** Declared MIME, when the caller has one. Falls back to the extension. */
    mimeType?: string;
    /** The year the user is currently looking at, so a new upload does not fall out of view. */
    viewYear?: number;
    /** Link the stored document to this transaction straight away. */
    linkTxId?: string;
    /** Today's date (YYYY-MM-DD); injectable so the date rule is testable. */
    today?: string;
    /** The entity whose Dokumentregeln apply to the new receipt (built-in DMS). */
    entityId?: string;
    /** Rules to apply instead of the entity's stored ones — the seam tests use. */
    rules?: readonly DokumentRegel[];
    /** Where the file came from, when not from the person's own hand (a mail); stored with the receipt. */
    origin?: DmsOrigin;
    /** The document date to start from instead of {@link uploadDate} — a mail's date, until the file says better. */
    created?: string;
}

/**
 * The date an un-analysed upload gets.
 *
 * Today, unless the user is looking at a different year — then the last day of that year, so the
 * receipt appears in the list they added it to instead of silently landing in a year they are not
 * looking at. The AI (or a manual edit) replaces it with the real invoice date later.
 */
export function uploadDate(viewYear: number | undefined, today: string): string {
    if (!viewYear || Number(today.slice(0, 4)) === viewYear) return today;
    return `${viewYear}-12-31`;
}

/**
 * Store a receipt in the given DMS, optionally linking it to a transaction.
 *
 * Throws with a message written for a human on every refusal — the provider cannot store, the type
 * is not allowed, the file is too large. Callers surface the message as-is.
 */
export async function storeReceipt(provider: DmsProvider, input: StoreReceiptInput): Promise<DmsDocument> {
    if (!provider.store) {
        throw new Error(
            'Diese Belegquelle kann keine Dateien aufnehmen. Belege für Paperless-ngx werden dort hochgeladen.',
        );
    }
    const type = effectiveReceiptType(input.mimeType, input.filename);
    if (!type) throw new Error(`Nicht unterstützter Dateityp — erlaubt sind ${RECEIPT_FORMATS_LABEL}.`);
    if (input.bytes.length > MAX_RECEIPT_BYTES) {
        const mb = Math.round(MAX_RECEIPT_BYTES / (1024 * 1024));
        throw new Error(`Datei zu groß (max. ${mb} MB).`);
    }

    const today = input.today ?? new Date().toISOString().slice(0, 10);
    const doc = await provider.store({
        bytes: input.bytes,
        filename: input.filename,
        mimeType: type, // the validated, allowlisted type — never the caller's claim
        created: input.created ?? uploadDate(input.viewYear, today),
        ...(input.origin ? { origin: input.origin } : {}),
    });

    // A failing link does NOT undo the store — the receipt is already safe, and deleting it again
    // would lose a file the user just handed us. But it is not swallowed either: a GoBD refusal on
    // a locked period is exactly the thing the user must hear about. So the error carries the fact
    // that the document exists, and names it, so they can link it by hand.
    if (input.linkTxId && provider.link) {
        try {
            await provider.link(doc.id, input.linkTxId);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Beleg „${input.filename}" wurde gespeichert, aber nicht mit der Buchung verknüpft: ${reason}`,
            );
        }
    }
    const classified = await classifyStoredReceipt(provider, doc, input.bytes);
    // Dokumentregeln (Idee 11) come after the file's own data (an e-invoice states its sender) and
    // before any AI step, which only fills what is still open.
    const rules = input.rules ?? (input.entityId ? loadDokumentRegeln(input.entityId) : []);
    return applyRulesBestEffort(provider, classified, input.bytes, type, rules);
}

async function applyRulesBestEffort(
    provider: DmsProvider,
    doc: DmsDocument,
    bytes: Uint8Array,
    mimeType: string,
    rules: readonly DokumentRegel[],
): Promise<DmsDocument> {
    if (rules.length === 0) return doc;
    try {
        const text = mimeType === 'application/pdf' ? extractPdfText(bytes) : null;
        return await applyDokumentRegeln(provider, doc, rules, text);
    } catch (err) {
        log.warn(`Dokumentregeln failed for ${doc.id}: ${err instanceof Error ? err.message : err}`);
        return doc;
    }
}

/**
 * Let the AI read a receipt — but only fill what no Dokumentregel set. The fields still listed in
 * the receipt's rule origin are held back from the model's answer.
 */
export async function analyzeReceipt(provider: DmsProvider, id: string): Promise<AnalyzeResult> {
    const doc = await provider.get(id);
    return analyzeDocument(provider, id, { keep: doc?.ruleOrigin?.fields ?? [] });
}

/**
 * Read the stored file as an e-invoice and record what it says — without AI. A hybrid PDF
 * (ZUGFeRD / Factur-X) fills correspondent, number, date and amounts from its XML; any other file
 * only gets the §14 UStG classification ("sonstige Rechnung" for a PDF without data set).
 *
 * Best effort by design: the receipt is already safe in the DMS, so a failure here is logged and
 * the plain document returned — the manual form and the AI path still work on it.
 */
export async function classifyStoredReceipt(
    provider: DmsProvider,
    doc: DmsDocument,
    bytes: Uint8Array,
): Promise<DmsDocument> {
    if (!provider.setMetadata) return doc;
    try {
        const reading = readEInvoice(bytes, { pdfText: extractPdfText });
        const patch: Partial<DmsDocument> = {
            invoiceKind: reading.classification.kind,
            invoiceKindReason: reading.classification.reason,
        };
        if (reading.invoice) {
            const meta = eInvoiceToReceiptMetadata(reading.invoice);
            // Only what the data set states; a missing value must not blank what is there.
            for (const key of ['title', 'correspondent', 'invoiceNumber', 'created', 'net', 'vat', 'gross'] as const) {
                if (meta[key] != null) (patch as Record<string, unknown>)[key] = meta[key];
            }
        }
        await provider.setMetadata(doc.id, patch);
        return (await provider.get(doc.id)) ?? doc;
    } catch (err) {
        log.warn(`E-invoice reading failed for ${doc.id}: ${err instanceof Error ? err.message : err}`);
        return doc;
    }
}

// ── Editing a receipt's metadata by hand ────────────────────────────────────────────────────────

/**
 * The fields a human fills in when no AI extracted them.
 *
 * `undefined` means "leave as it is"; `null` means "clear it". Without that distinction a dialog
 * that shows a subset of the fields would silently wipe every field it does not show.
 */
export interface ReceiptMetadataInput {
    title?: string | null;
    correspondent?: string | null;
    invoiceNumber?: string | null;
    /** Document date (YYYY-MM-DD) — the date the period filter and the EÜR use. */
    created?: string | null;
    direction?: 'incoming' | 'outgoing' | null;
    documentType?: string | null;
    /** Booking category (SKR03 label). */
    category?: string | null;
    net?: number | null;
    vat?: number | null;
    gross?: number | null;
}

/** German VAT rates, for the derive helper and a rate picker. */
export const VAT_RATES = [0, 0.07, 0.19] as const;

/** Round to cents the way money has to be rounded before it is compared. */
function cents(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Fill in whichever of net / VAT / gross is missing, when two of them are known.
 *
 * This is the part a human should not have to do. `rate` lets a single figure be completed: gross
 * plus 19 % yields the other two, which is how a receipt is actually read — the gross is the number
 * printed largest.
 *
 * Returns the input unchanged when it cannot be completed; it never guesses from one figure alone
 * without a rate.
 */
export function deriveAmounts(
    amounts: { net?: number | null; vat?: number | null; gross?: number | null },
    rate?: number,
): { net: number | null; vat: number | null; gross: number | null } {
    const net = amounts.net ?? null;
    const vat = amounts.vat ?? null;
    const gross = amounts.gross ?? null;

    if (net != null && vat != null && gross == null) return { net, vat, gross: cents(net + vat) };
    if (net != null && gross != null && vat == null) return { net, vat: cents(gross - net), gross };
    if (vat != null && gross != null && net == null) return { net: cents(gross - vat), vat, gross };

    if (rate != null && rate >= 0) {
        if (gross != null && net == null && vat == null) {
            const derivedNet = cents(gross / (1 + rate));
            return { net: derivedNet, vat: cents(gross - derivedNet), gross };
        }
        if (net != null && gross == null && vat == null) {
            const derivedVat = cents(net * rate);
            return { net, vat: derivedVat, gross: cents(net + derivedVat) };
        }
    }
    return { net, vat, gross };
}

/**
 * Problems that must be shown BEFORE writing, each phrased for the person who typed it.
 *
 * The arithmetic check is the load-bearing one: a receipt whose net and VAT do not add up to its
 * gross feeds a wrong Vorsteuer figure into the USt-Voranmeldung, and nothing downstream will
 * notice. Two cents of tolerance, because a real invoice rounds per line and the sum can legitimately
 * miss the product by a cent.
 */
export function validateReceiptMetadata(input: ReceiptMetadataInput): string[] {
    const problems: string[] = [];

    if (input.created != null && input.created !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.created)) {
        problems.push('Datum muss im Format JJJJ-MM-TT stehen.');
    }
    for (const [label, value] of [
        ['Netto', input.net],
        ['USt', input.vat],
        ['Brutto', input.gross],
    ] as const) {
        if (value != null && !Number.isFinite(value)) problems.push(`${label} ist keine Zahl.`);
    }

    const { net, vat, gross } = input;
    if (net != null && vat != null && gross != null && Number.isFinite(net + vat + gross)) {
        if (Math.abs(cents(net + vat) - cents(gross)) > 0.02) {
            problems.push(
                `Netto + USt (${cents(net + vat).toFixed(2)}) passt nicht zum Brutto (${cents(gross).toFixed(2)}).`,
            );
        }
    }
    return problems;
}

/**
 * Write hand-entered metadata onto a document.
 *
 * The same `setMetadata` the AI review path uses, so a receipt corrected by hand is indistinguishable
 * from one the model got right — which is the point: the app has to be fully usable with the AI
 * switched off, not merely degraded.
 */
export async function updateReceiptMetadata(
    provider: DmsProvider,
    id: string,
    input: ReceiptMetadataInput,
): Promise<void> {
    if (!provider.setMetadata) {
        throw new Error('Diese Belegquelle kann Metadaten nicht ändern.');
    }
    const problems = validateReceiptMetadata(input);
    if (problems.length > 0) throw new Error(problems.join('\n'));

    // Only the keys the caller actually supplied — `undefined` must not reach the provider as a
    // clear, or a dialog showing four fields would blank the other four.
    const patch: Partial<DmsDocument> = {};
    for (const key of [
        'title',
        'correspondent',
        'invoiceNumber',
        'created',
        'direction',
        'documentType',
        'category',
        'net',
        'vat',
        'gross',
    ] as const) {
        if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
    }
    // A hand edit wins over a rule: a field the person changed leaves the rule's origin, so the AI
    // and „Zurücknehmen" no longer treat it as the rule's.
    const before = await provider.get(id);
    if (before?.ruleOrigin) {
        patch.ruleOrigin = behalteRegelFelder(
            before.ruleOrigin,
            {
                correspondent: before.correspondent,
                documentType: before.documentType,
                category: before.category ?? null,
                direction: before.direction,
            },
            {
                correspondent: input.correspondent,
                documentType: input.documentType,
                category: input.category,
                direction: input.direction,
            },
        );
    }
    await provider.setMetadata(id, patch);
}
