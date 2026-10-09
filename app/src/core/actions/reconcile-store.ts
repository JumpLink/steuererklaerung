/**
 * Store-based reconciliation: link Paperless invoice documents to bank
 * transactions in the local unified store (camt:/fints:/qonto:).
 *
 * This mirrors the live-Qonto reconciliation in mcp/tools/cross-system.ts but
 * reads the *local* store, so it works for closed accounts (e.g. a dissolved
 * company) whose history was imported from CAMT exports and is no longer
 * reachable via the Qonto API.
 *
 * It deliberately writes the same `qonto_*` "bank match" custom fields
 * (qonto_transaction_id, qonto_transaction_amount, qonto_settled_at, …) so the
 * existing USt-VA / EÜR aggregation keeps working unchanged — the only
 * difference is the source of those values.
 */

import {
    getDocument,
    updateDocument,
    getCorrespondent,
    type Document,
    getCustomFieldValue,
    parseMonetaryValue,
    mergeCustomFields,
    hasSyncField,
} from '@steuererklaerung/paperless';
import { searchTransactions } from './transactions.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    findStoreMatches,
    pickBestMatch,
    type DocMatchCriteria,
    type InvoiceDirection,
} from '../lib/transactions/reconcile.ts';
import { fetchInvoiceDocsInPeriod, isNoReceiptNeeded, type StoreReconciliationStatus } from '@steuererklaerung/dms';
import { getLogger } from '../lib/logger.ts';
import { shiftDate } from '@steuererklaerung/shared';
import type { SyncConfig } from '../config/index.ts';

const log = getLogger('reconcile-store');

// ---------------------------------------------------------------------------
// Criteria extraction
// ---------------------------------------------------------------------------

function directionOf(doc: Document, config: SyncConfig): InvoiceDirection | null {
    const t = doc.document_type ?? null;
    if (t != null && t === config.document_type_ids.incoming_invoice) return 'incoming';
    if (t != null && t === config.document_type_ids.outgoing_invoice) return 'outgoing';
    return null;
}

/** Gross amount of an invoice document, from total_gross or total_net + tax_amount. */
function grossOf(doc: Document, config: SyncConfig): { amount: number; currency: string } | null {
    const cf = config.custom_field_ids;
    const gross = parseMonetaryValue(getCustomFieldValue(doc, cf.total_gross));
    if (gross) return { amount: Math.abs(gross.amount), currency: gross.currency };
    const net = parseMonetaryValue(getCustomFieldValue(doc, cf.total_net));
    if (net) {
        const tax = parseMonetaryValue(getCustomFieldValue(doc, cf.tax_amount));
        return { amount: Math.abs(net.amount) + Math.abs(tax?.amount ?? 0), currency: net.currency };
    }
    return null;
}

function dateField(doc: Document, fieldId: number): string | undefined {
    const raw = getCustomFieldValue(doc, fieldId);
    if (raw == null) return undefined;
    const s = String(raw).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

async function correspondentName(doc: Document): Promise<string | undefined> {
    if (!doc.correspondent) return undefined;
    try {
        const c = await getCorrespondent(doc.correspondent);
        return c.name;
    } catch {
        return undefined;
    }
}

async function buildCriteria(
    doc: Document,
    config: SyncConfig,
    direction: InvoiceDirection,
): Promise<DocMatchCriteria | null> {
    const cf = config.custom_field_ids;
    const gross = grossOf(doc, config);
    if (!gross) return null;
    const invoiceNumberRaw = getCustomFieldValue(doc, cf.invoice_number);
    return {
        grossAmount: gross.amount,
        currency: gross.currency,
        direction,
        invoiceDate: dateField(doc, cf.invoice_date),
        dueDate: dateField(doc, cf.due_date),
        counterpartyName: await correspondentName(doc),
        invoiceNumber: invoiceNumberRaw != null ? String(invoiceNumberRaw) : undefined,
        foreignCurrency: gross.currency.toUpperCase() !== 'EUR',
    };
}

// ---------------------------------------------------------------------------
// Writing the bank-match fields
// ---------------------------------------------------------------------------

/**
 * Paperless string custom fields are capped at 128 characters — a longer value makes the whole
 * `custom_fields` PATCH fail with HTTP 400. Bank purposes (e.g. long "AMZN Mktp DE*… " references)
 * routinely exceed this, so string enrichment values are truncated to keep the write valid.
 */
export const PAPERLESS_STRING_MAX = 128;

export function bankMatchEntries(tx: UnifiedTransaction, config: SyncConfig): Array<{ field: number; value: unknown }> {
    const cf = config.custom_field_ids;
    const entries: Array<{ field: number; value: unknown }> = [];
    const push = (field: number, value: unknown) => {
        if (field <= 0 || value == null || value === '') return;
        const capped =
            typeof value === 'string' && value.length > PAPERLESS_STRING_MAX
                ? value.slice(0, PAPERLESS_STRING_MAX)
                : value;
        entries.push({ field, value: capped });
    };
    // `qonto_transaction_id` carries the unified store id (camt content hash etc.).
    push(cf.qonto_transaction_id, tx.id);
    push(cf.qonto_transaction_amount, tx.amount); // float field — signed number
    push(cf.qonto_currency, tx.currency);
    push(cf.qonto_settled_at, tx.bookingDate);
    push(cf.qonto_label, tx.counterparty);
    push(cf.qonto_reference, tx.reference ?? tx.purpose);
    return entries;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileDocOptions {
    /** Use this exact store transaction id instead of auto-matching. */
    storeTransactionId?: string;
    /** Restrict the store search to one account (accountKey from transactions_summary). */
    accountKey?: string;
    maxDayGap?: number;
    amountTolerance?: number;
    /** Re-match even if the document already has a qonto_transaction_id. */
    force?: boolean;
    dryRun?: boolean;
    /** Store transaction ids already claimed by another document — excluded from auto-match. */
    excludeTransactionIds?: Set<string>;
}

export interface ReconcileCandidate {
    transactionId: string;
    accountKey: string;
    bookingDate: string;
    amount: number;
    currency: string;
    counterparty?: string;
    score: number;
    dayGap: number | null;
    amountDiff: number;
    reasons: string[];
}

export interface ReconcileDocResult {
    documentId: number;
    direction: InvoiceDirection | null;
    grossAmount: number | null;
    matched: boolean;
    confident: boolean;
    alreadyMatched: boolean;
    written: boolean;
    transactionId?: string;
    writtenFields: string[];
    candidates: ReconcileCandidate[];
    message: string;
}

function toCandidate(c: ReturnType<typeof findStoreMatches>[number]): ReconcileCandidate {
    const t = c.transaction;
    return {
        transactionId: t.id,
        accountKey: t.accountKey,
        bookingDate: t.bookingDate,
        amount: t.amount,
        currency: t.currency,
        counterparty: t.counterparty,
        score: c.score,
        dayGap: c.dayGap,
        amountDiff: c.amountDiff,
        reasons: c.reasons,
    };
}

// ---------------------------------------------------------------------------
// Reconcile one document
// ---------------------------------------------------------------------------

export async function reconcileDocumentToStore(
    config: SyncConfig,
    documentId: number,
    options: ReconcileDocOptions = {},
): Promise<ReconcileDocResult> {
    const cf = config.custom_field_ids;
    const doc = await getDocument(documentId);
    const direction = directionOf(doc, config);

    const base: ReconcileDocResult = {
        documentId,
        direction,
        grossAmount: null,
        matched: false,
        confident: false,
        alreadyMatched: hasSyncField(doc, cf.qonto_transaction_id),
        written: false,
        writtenFields: [],
        candidates: [],
        message: '',
    };

    if (!direction) {
        return { ...base, message: 'Document is not an incoming/outgoing invoice type — skipped.' };
    }
    if (base.alreadyMatched && !options.force && !options.storeTransactionId) {
        return {
            ...base,
            message: `Document already has qonto_transaction_id (${getCustomFieldValue(doc, cf.qonto_transaction_id)}). Use force to re-match.`,
        };
    }

    const criteria = await buildCriteria(doc, config, direction);
    if (!criteria) {
        return { ...base, message: 'Document has no total_gross / total_net amount — run invoice extraction first.' };
    }
    base.grossAmount = criteria.grossAmount;

    const maxDayGap = options.maxDayGap ?? 60;

    // Narrow the store search to a window around the document dates.
    const dates = [criteria.invoiceDate, criteria.dueDate].filter((d): d is string => !!d).sort();
    const from = dates.length ? shiftDate(dates[0], -maxDayGap) : undefined;
    const to = dates.length ? shiftDate(dates[dates.length - 1], maxDayGap) : undefined;
    const pool = searchTransactions({ accountKey: options.accountKey, from, to }).transactions.filter(
        (t) => !options.excludeTransactionIds?.has(t.id),
    );

    // Select the transaction: explicit id, or best auto-match.
    let chosen: UnifiedTransaction | undefined;
    let confident = false;
    let candidates: ReconcileCandidate[] = [];

    if (options.storeTransactionId) {
        chosen = searchTransactions({ accountKey: options.accountKey }).transactions.find(
            (t) => t.id === options.storeTransactionId,
        );
        if (!chosen) {
            return { ...base, message: `Store transaction ${options.storeTransactionId} not found.` };
        }
        confident = true;
    } else {
        const ranked = findStoreMatches(criteria, pool, {
            maxDayGap,
            amountTolerance: options.amountTolerance,
        });
        candidates = ranked.slice(0, 5).map(toCandidate);
        const best = pickBestMatch(ranked);
        if (!best.match) {
            return { ...base, candidates, message: 'No store transaction matched (amount/direction/date).' };
        }
        chosen = best.match.transaction;
        confident = best.confident;
        if (!confident) {
            return {
                ...base,
                candidates,
                transactionId: chosen.id,
                matched: true,
                message: `Ambiguous: ${candidates.length} candidates of similar score. Pass an explicit store_transaction_id.`,
            };
        }
    }

    const entries = bankMatchEntries(chosen, config);
    const writtenFields = entries.map((e) => fieldName(e.field, config));

    if (!options.dryRun) {
        const merged = mergeCustomFields(doc.custom_fields ?? [], entries);
        await updateDocument(documentId, { custom_fields: merged });
    }

    return {
        ...base,
        matched: true,
        confident,
        written: !options.dryRun,
        transactionId: chosen.id,
        writtenFields,
        candidates: candidates.length
            ? candidates
            : [toCandidate({ transaction: chosen, score: 100, amountDiff: 0, dayGap: null, reasons: ['explicit'] })],
        message: options.dryRun
            ? `[dry-run] Would link document ${documentId} → ${chosen.id} (${chosen.bookingDate}, ${chosen.amount} ${chosen.currency}).`
            : `Linked document ${documentId} → store transaction ${chosen.id}.`,
    };
}

/** Human-readable name for a custom field id (best effort, for change summaries). */
function fieldName(fieldId: number, config: SyncConfig): string {
    const cf = config.custom_field_ids;
    const entry = Object.entries(cf).find(([, id]) => id === fieldId);
    return entry ? entry[0] : `#${fieldId}`;
}

// ---------------------------------------------------------------------------
// Reconciliation status (gap report) over a period
// ---------------------------------------------------------------------------
export interface ReconcileBatchResult {
    period: { from: string; to: string };
    processed: number;
    linked: number;
    ambiguous: number;
    unmatched: number;
    skipped: number;
    errors: number;
    results: ReconcileDocResult[];
}

/**
 * Reconcile every (unmatched) invoice document in the period against the store.
 * Only writes confident, unambiguous matches; ambiguous/unmatched docs are
 * reported for human review.
 */
export async function reconcileStoreBatch(
    config: SyncConfig,
    range: { from: string; to: string },
    options: ReconcileDocOptions & { limit?: number } = {},
): Promise<ReconcileBatchResult> {
    const cf = config.custom_field_ids;
    const docs = await fetchInvoiceDocsInPeriod(config, range);

    // A store transaction backs at most one document: pre-claim the transactions
    // already linked to a matched document, then claim each new confident match —
    // so two same-amount invoices can't both grab the same payment.
    const used = new Set<string>();
    for (const d of docs) {
        if (!hasSyncField(d, cf.qonto_transaction_id)) continue;
        for (const id of String(getCustomFieldValue(d, cf.qonto_transaction_id) ?? '')
            .split(',')
            .map((s) => s.trim())) {
            if (id) used.add(id);
        }
    }

    const candidates = (options.force ? docs : docs.filter((d) => !hasSyncField(d, cf.qonto_transaction_id)))
        // Process chronologically so early invoices claim early payments (greedy assignment).
        .slice()
        .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
    const limited = typeof options.limit === 'number' ? candidates.slice(0, options.limit) : candidates;

    const results: ReconcileDocResult[] = [];
    let linked = 0;
    let ambiguous = 0;
    let unmatched = 0;
    let skipped = 0;
    let errors = 0;
    for (const doc of limited) {
        let r: ReconcileDocResult;
        try {
            r = await reconcileDocumentToStore(config, doc.id, { ...options, excludeTransactionIds: used });
        } catch (e) {
            // One bad document (e.g. an orphaned custom-field value Paperless rejects on
            // write) must not abort the whole batch — record and continue.
            errors += 1;
            log.error(`Reconcile failed for document ${doc.id}: ${e instanceof Error ? e.message : e}`);
            results.push({
                documentId: doc.id,
                direction: null,
                grossAmount: null,
                matched: false,
                confident: false,
                alreadyMatched: false,
                written: false,
                writtenFields: [],
                candidates: [],
                message: `error: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
        }
        results.push(r);
        // Claim the chosen transaction so no later document can match it too.
        if (r.confident && r.transactionId) used.add(r.transactionId);
        if (r.written || (options.dryRun && r.confident && r.matched)) linked += 1;
        else if (r.matched && !r.confident) ambiguous += 1;
        else if (!r.matched && r.direction) unmatched += 1;
        else skipped += 1;
    }
    return { period: range, processed: limited.length, linked, ambiguous, unmatched, skipped, errors, results };
}
export async function storeReconciliationStatus(
    config: SyncConfig,
    range: { from: string; to: string },
    options: { accountKey?: string } = {},
): Promise<StoreReconciliationStatus> {
    const cf = config.custom_field_ids;
    const { from, to } = range;

    const storeTxs = searchTransactions({ accountKey: options.accountKey, from, to }).transactions;

    const docs = await fetchInvoiceDocsInPeriod(config, range);

    const docsWithMatch = docs.filter((d) => hasSyncField(d, cf.qonto_transaction_id));
    const matchedStoreIds = new Set(
        docsWithMatch
            .map((d) =>
                String(getCustomFieldValue(d, cf.qonto_transaction_id) ?? '')
                    .split(',')
                    .map((s) => s.trim()),
            )
            .flat()
            .filter(Boolean),
    );

    const storeMatched = storeTxs.filter((t) => matchedStoreIds.has(t.id));
    const storeUnmatched = storeTxs.filter((t) => !matchedStoreIds.has(t.id));
    const storeNoReceipt = storeUnmatched.filter(isNoReceiptNeeded);
    const storeMissing = storeUnmatched.filter((t) => !isNoReceiptNeeded(t));

    return {
        period: { from, to },
        accountKey: options.accountKey,
        store: {
            total: storeTxs.length,
            matched_to_document: storeMatched.length,
            no_receipt_needed: storeNoReceipt.length,
            receipt_missing: storeMissing.length,
            unmatched_examples: storeMissing.slice(0, 20).map((t) => ({
                id: t.id,
                bookingDate: t.bookingDate,
                amount: t.amount,
                counterparty: t.counterparty,
                reference: t.reference,
            })),
        },
        paperless: {
            total: docs.length,
            with_store_match: docsWithMatch.length,
            without_store_match: docs.length - docsWithMatch.length,
            without_store_match_ids: docs.filter((d) => !hasSyncField(d, cf.qonto_transaction_id)).map((d) => d.id),
        },
    };
}
