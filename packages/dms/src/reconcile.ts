/**
 * Store ↔ document reconciliation read-path: list a period's invoice documents and build the
 * gap report (store coverage vs. linked DMS documents). Pure reads — the reconcile **write**
 * batch (which writes the qonto_* bank-match fields back to Paperless) stays in the CLI and
 * imports `fetchInvoiceDocsInPeriod` from here.
 */

import {
    listDocuments,
    getCustomFieldValue,
    fetchAllPagesParallel,
    type Document,
    type PaperlessConfig,
} from '@steuererklaerung/paperless';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import type { PaperlessFieldConfig, StoreReconciliationStatus } from './types.ts';

/**
 * Drop documents carrying any of the `excludeTagIds` — Paperless tags that mark a document as
 * out of business scope (e.g. the per-person "* Privat" tags for privately-paid purchases). Such
 * receipts are typed as invoices in the shared Paperless, so without this filter they clutter the
 * business Beleg-Eingang / reconciliation forever (they have no business bank line to link to).
 * Pure + config-driven (the ids live in the sync config) so it stays testable and deployment-agnostic.
 */
export function excludeTaggedDocs(docs: Document[], excludeTagIds: number[] | undefined): Document[] {
    if (!excludeTagIds || excludeTagIds.length === 0) return docs;
    const exclude = new Set(excludeTagIds);
    return docs.filter((d) => !(d.tags ?? []).some((t) => exclude.has(t)));
}

/** Transactions that legitimately have no receipt (transfers, fees, owner draws…). */
export function isNoReceiptNeeded(t: UnifiedTransaction): boolean {
    const hay = `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''} ${t.type ?? ''}`.toLowerCase();
    const needles = [
        'privatentnahme',
        'privateinlage',
        'rueckueberweisung',
        'rücküberweisung',
        'restguthaben',
        'uebertrag',
        'übertrag',
        'aufladung',
        'qonto',
        'olinda',
        'gebühr',
        'gebuehr',
        'entgelt',
        'kontoführung',
        'kontofuehrung',
        'zinsen',
        'umbuchung',
        'eigenübertrag',
        'eigenuebertrag',
    ];
    return needles.some((n) => hay.includes(n));
}

/**
 * Fetch Paperless invoice documents whose payment date (qonto_settled_at) or, failing that,
 * invoice_date / created falls in the period. Shared by the gap report and the batch reconciler.
 */
export async function fetchInvoiceDocsInPeriod(
    config: PaperlessFieldConfig,
    range: { from: string; to: string },
    cfg?: PaperlessConfig,
): Promise<Document[]> {
    const cf = config.custom_field_ids;
    const { from, to } = range;
    const typeIds = [config.document_type_ids.incoming_invoice, config.document_type_ids.outgoing_invoice].filter(
        (id) => id > 0,
    );
    const docDate = (d: Document): string | undefined => {
        const settled = getCustomFieldValue(d, cf.qonto_settled_at) as string | undefined;
        const invoice = getCustomFieldValue(d, cf.invoice_date) as string | undefined;
        return (settled ?? invoice ?? d.created)?.slice(0, 10);
    };
    const inPeriod = (d: Document): boolean => {
        const date = docDate(d);
        return date != null && date >= from && date <= to;
    };

    // Fetch both document types concurrently, each with parallel pagination (page 1 → count → the
    // rest in a bounded batch), then keep the period's docs. Stable `id` ordering so a document added
    // mid-fetch only appends (never shifts earlier pages); dedupe by id for the rare repeat.
    const perType = await Promise.all(
        typeIds.map((typeId) =>
            fetchAllPagesParallel((page, pageSize) =>
                listDocuments({ document_type_id: typeId, page, page_size: pageSize, ordering: 'id' }, cfg),
            ),
        ),
    );
    const seen = new Set<number>();
    const docs: Document[] = [];
    for (const found of perType) {
        for (const d of found) {
            if (seen.has(d.id) || !inPeriod(d)) continue;
            seen.add(d.id);
            docs.push(d);
        }
    }
    // Private receipts ("* Privat"-tagged) are out of business scope — never show them in the
    // Beleg-Eingang / reconciliation, even though they are typed as incoming invoices in Paperless.
    return excludeTaggedDocs(docs, config.exclude_tag_ids);
}

/**
 * Build the gap report PURELY from store transactions + already-resolved DMS documents (their
 * linked tx ids) — no Paperless fetch. The web cache uses this so a year-build (and an
 * after-write rebuild) does NOT issue a second outbound fetch; it works for any DMS back-end.
 */
export function reconciliationFromDocs(
    storeTxs: UnifiedTransaction[],
    docs: Array<{ linkedTxIds: string[] }>,
    range: { from: string; to: string },
): StoreReconciliationStatus {
    const matchedStoreIds = new Set(docs.flatMap((d) => d.linkedTxIds));
    const matched = storeTxs.filter((t) => matchedStoreIds.has(t.id));
    const unmatched = storeTxs.filter((t) => !matchedStoreIds.has(t.id));
    const missing = unmatched.filter((t) => !isNoReceiptNeeded(t));
    const withMatch = docs.filter((d) => d.linkedTxIds.length > 0).length;
    return {
        period: { from: range.from, to: range.to },
        store: {
            total: storeTxs.length,
            matched_to_document: matched.length,
            no_receipt_needed: unmatched.length - missing.length,
            receipt_missing: missing.length,
            unmatched_examples: missing.slice(0, 20).map((t) => ({
                id: t.id,
                bookingDate: t.bookingDate,
                amount: t.amount,
                counterparty: t.counterparty,
                reference: t.reference,
            })),
        },
        paperless: {
            total: docs.length,
            with_store_match: withMatch,
            without_store_match: docs.length - withMatch,
            without_store_match_ids: [],
        },
    };
}
