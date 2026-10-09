/**
 * Amazon "Bestellungen" CSV importer (Amazon Business item export).
 *
 * Like the Qonto export, this restores what the bank booking lost: a card charge
 * shows only "AMZN Mktp DE" with no item, while the Amazon export lists every
 * article (title + category) and the payment that settled it. We group rows into
 * payments by (payment date, payment amount) so each maps to one bank charge, and
 * the EÜR folds the items in to classify (a Nintendo game → private, a document
 * scanner → business). Reusable for every future tax year.
 *
 * Pure functions; reuses the RFC-CSV reader from the PayPal parser.
 */

import { readFileSync } from 'node:fs';
import { parseCsv } from '../paypal/parser.ts';

/** One Amazon payment (one bank charge): the settled amount + the articles it paid for. */
export interface AmazonPayment {
    /** Payment date YYYY-MM-DD. */
    date: string;
    /** Positive EUR amount that was charged. */
    amount: number;
    /** "[Category] Title" per article in the payment. */
    items: string[];
}

/** German amount "1.234,56" → 1234.56. */
function amt(s: string | undefined): number | null {
    const n = Number.parseFloat((s ?? '').replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/** Amazon date "25/04/2025" (DD/MM/YYYY) → "2025-04-25". */
function dmyToIso(s: string | undefined): string | undefined {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec((s ?? '').trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/** Group the per-article export rows into payments keyed by (payment date, amount). */
export function amazonRowsToPayments(rows: Array<Record<string, string>>): AmazonPayment[] {
    const map = new Map<string, AmazonPayment>();
    for (const r of rows) {
        const date = dmyToIso(r['Zahlungsdatum']) ?? dmyToIso(r['Bestelldatum']);
        const amount = amt(r['Zahlungsbetrag']) ?? amt(r['Summe inkl. USt']);
        if (!date || !amount) continue;
        const cat = (r['Amazon-interne Produktkategorie'] ?? '').trim();
        const title = (r['Titel'] ?? '').trim();
        const item = (cat ? `[${cat}] ` : '') + title;
        const k = `${date}|${amount.toFixed(2)}`;
        const e = map.get(k);
        if (e) {
            if (item && !e.items.includes(item)) e.items.push(item);
        } else {
            map.set(k, { date, amount, items: item ? [item] : [] });
        }
    }
    return [...map.values()];
}

/** Read + parse an Amazon "Bestellungen" CSV into payments. */
export function parseAmazonOrders(inputPath: string): AmazonPayment[] {
    return amazonRowsToPayments(parseCsv(readFileSync(inputPath, 'utf8')));
}

/** Per-order article categories + titles — used to scope a receipt business/private. */
export interface AmazonOrderInfo {
    categories: string[];
    titles: string[];
}

/** Group the per-article export rows into per-order category + title sets. */
export function amazonRowsToOrderInfo(rows: Array<Record<string, string>>): Map<string, AmazonOrderInfo> {
    const map = new Map<string, AmazonOrderInfo>();
    for (const r of rows) {
        const order = (r['Bestellnummer'] ?? '').trim();
        if (!order) continue;
        const info = map.get(order) ?? { categories: [], titles: [] };
        const cat = (r['Amazon-interne Produktkategorie'] ?? '').trim();
        const title = (r['Titel'] ?? '').trim();
        if (cat && !info.categories.includes(cat)) info.categories.push(cat);
        if (title && !info.titles.includes(title)) info.titles.push(title);
        map.set(order, info);
    }
    return map;
}

/** Map each Amazon order number → its article categories + titles. */
export function parseAmazonOrderInfo(inputPath: string): Map<string, AmazonOrderInfo> {
    return amazonRowsToOrderInfo(parseCsv(readFileSync(inputPath, 'utf8')));
}
