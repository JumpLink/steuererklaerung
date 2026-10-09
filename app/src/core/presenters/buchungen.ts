/**
 * Buchungen presenter — the ONE receipt-join + view-enrichment for a period's classified bookings.
 *
 * The web review cache (presenters/year-snapshot.ts → `/api/transactions`) and the native Buchungen view both
 * join each EÜR detail row to its linked DMS receipt and enrich it with account labels / internal-
 * transfer pairing / PayPal source / raw bank fields. This module owns that join — {@link ReceiptInfo},
 * {@link buildDocByTx}, {@link enrichRows} — so the two surfaces can't drift (before, the desktop
 * `data/transactions-enriched.ts` carried a literal copy of it). It also owns the app-facing load
 * functions the desktop view used inline: the classified business list and the raw `privat` cash list.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on GJS
 * in every frontend.
 */

import type { EuerTxDetailRow } from '../elster/euer-transactions.ts';
import type { DmsDocument } from '@steuererklaerung/dms';
import { accountLabel, enrichViewRows, type TxViewExtras } from '../lib/tx-view.ts';
import { searchTransactions, searchAccountKeys } from '../actions/transactions.ts';
import { round2 } from '../lib/money.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

/** The linked receipt surfaced on a booking row + in its detail. */
export interface ReceiptInfo {
    docId: number;
    title: string | null;
    invoiceNumber: string | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
}

/** A booking row with its receipt + view extras — the shape both the web `TxRow` and the native list use. */
export type EnrichedTxRow = EuerTxDetailRow & { receipt: ReceiptInfo | null } & TxViewExtras;

/** Just the headline figures the KPI row needs (a superset of what raw + aggregate can both supply). */
export interface TxTotals {
    incomeNet: number;
    /** Positive magnitude (shown signed by the view). */
    expenseNet: number;
    profit: number;
}

export interface EnrichedTxData {
    rows: EnrichedTxRow[];
    totals: TxTotals;
    /** True when the rows carry the EÜR classification + receipts (a business entity); false for a
     *  raw `privat` list (no Vorsteuer/Beleg concept → the view hides the "Ohne Beleg" chip/badge). */
    classified: boolean;
}

/** Map each linked tx id → its receipt. DMS-agnostic: the provider already resolved the link ids and
 * the monetary fields, so this is a pure fan-out over `DmsDocument.linkedTxIds`. */
export function buildDocByTx(docs: DmsDocument[]): Map<string, ReceiptInfo> {
    const docByTx = new Map<string, ReceiptInfo>();
    for (const doc of docs) {
        if (!doc.linkedTxIds.length) continue;
        const info: ReceiptInfo = {
            docId: Number(doc.id),
            title: doc.title,
            invoiceNumber: doc.invoiceNumber,
            net: doc.net,
            gross: doc.gross,
            vat: doc.vat,
        };
        for (const id of doc.linkedTxIds) docByTx.set(id, info);
    }
    return docByTx;
}

/** Attach each row's linked receipt (by tx id) — used for both the laufende + §24 rows. */
export function joinReceipts<T extends { id: string }>(
    rows: T[],
    docByTx: Map<string, ReceiptInfo>,
): (T & { receipt: ReceiptInfo | null })[] {
    return rows.map((r) => ({ ...r, receipt: docByTx.get(r.id) ?? null }));
}

/** Join the receipts, then apply the display enrichment (account labels / transfer pairing / PayPal /
 * raw bank fields) — the exact pipeline the web year-cache and the native list share. */
export function enrichRows<T extends EuerTxDetailRow>(
    rows: T[],
    docByTx: Map<string, ReceiptInfo>,
    opts: Parameters<typeof enrichViewRows>[1] = {},
): Array<T & { receipt: ReceiptInfo | null } & TxViewExtras> {
    return enrichViewRows(joinReceipts(rows, docByTx), opts);
}

/** Load + enrich one BUSINESS entity-year's bookings (async; shares the session's aggregate + docs
 * caches, so an already-open entity opens Buchungen without a fresh fetch). Newest first. */
export async function loadEnrichedTransactions(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<EnrichedTxData> {
    const [agg, documents] = await Promise.all([session.aggregate(entity, year), session.documents(entity, year)]);
    const docByTx = buildDocByTx(documents.docs);
    const rawById = new Map(
        searchAccountKeys(entity.accountKeys, { from: `${year}-01-01`, to: `${year}-12-31` }).map((t) => [t.id, t]),
    );
    const rows = enrichRows(agg.detail ?? [], docByTx, {
        labels: session.elster(entity)?.account_labels,
        paypalTxs: searchTransactions({ source: 'paypal' }).transactions,
        rawById,
    });
    // Newest first — the most useful order for a review list.
    rows.sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : a.bookingDate > b.bookingDate ? -1 : 0));
    const t = agg.totals;
    return { rows, totals: { incomeNet: t.incomeNet, expenseNet: t.expenseNet, profit: t.profit }, classified: true };
}

/**
 * Load a `privat` entity-year's bookings from the RAW store (synchronous, no outbound) — deliberately
 * WITHOUT the EÜR classification: a private person has no Vorsteuer/Beleg concept, so applying the
 * business SKR03 rules (and stripping a phantom 19 % VAT) would be wrong. Each row carries `vat: 0`
 * (→ never "ohne Beleg") and an empty category, and the totals are a plain cash income/expense/saldo.
 */
export function loadRawTransactions(entity: EntityModel, year: number): EnrichedTxData {
    const txs = searchAccountKeys(entity.accountKeys, { from: `${year}-01-01`, to: `${year}-12-31` });
    txs.sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : a.bookingDate > b.bookingDate ? -1 : 0));

    let income = 0;
    let expense = 0;
    const rows: EnrichedTxRow[] = txs.map((t) => {
        if (t.amount >= 0) income += t.amount;
        else expense += Math.abs(t.amount);
        return {
            id: t.id,
            accountKey: t.accountKey,
            bookingDate: t.bookingDate,
            counterparty: t.counterparty,
            purpose: t.purpose,
            amount: t.amount,
            kind: t.amount >= 0 ? 'income' : 'expense',
            source: 'unclassified',
            category: '',
            kz: '',
            net: t.amount,
            vat: 0,
            gross: t.amount,
            receipt: null,
            account: accountLabel(t.accountKey),
            raw: {
                source: t.source,
                valueDate: t.valueDate,
                currency: t.currency,
                counterpartyIban: t.counterpartyIban,
                reference: t.reference,
                type: t.type,
                iban: t.iban,
                qontoCategory: t.category,
            },
        };
    });
    return {
        rows,
        totals: { incomeNet: round2(income), expenseNet: round2(expense), profit: round2(income - expense) },
        classified: false,
    };
}
