/**
 * PayPal "Aktivitätsbericht" CSV importer.
 *
 * PayPal is a payment intermediary, not a bank account: each bank-funded PayPal
 * payment shows up on the *bank* as a single "PP.1555.PP/<bankref>" SEPA direct
 * debit, while PayPal itself records the real merchant. We import the PayPal
 * payments as a separate searchable `paypal:` source and carry the bank reference
 * (the 13-digit number the bank stores in the purpose) so each payment can be
 * matched back to its bank booking — turning an opaque "PP.1555.PP/<bankref>"
 * into "DeepSeek, AI service, 10.60 USD".
 *
 * Pure functions (string in → transactions out) so they are unit-testable; the
 * thin file-reading wrapper lives at the bottom.
 */

import { readFileSync } from 'node:fs';
import type { UnifiedTransaction } from '@steuererklaerung/store';

/** PayPal row types that are mechanics, not a distinct merchant payment — skipped. */
const MECHANIC_TYPES = new Set([
    'Warenkorbartikel',
    'Allgemeine Währungsumrechnung',
    'Bankgutschrift auf PayPal-Konto',
    'Bankabbuchung von PayPal-Konto',
    'Auszahlung auf das Bankkonto',
]);

/** Parse RFC-4180-ish CSV (quoted fields, embedded commas/quotes, BOM) into header-keyed rows. */
export function parseCsv(content: string): Array<Record<string, string>> {
    const text = content.replace(/^﻿/, '');
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
        return obj;
    });
}

/** German amount "−1.234,56" → -1234.56 (thousands dot stripped, decimal comma → point). */
function parseAmount(s: string): number {
    const n = Number.parseFloat((s || '').replace(/\./g, '').replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/** German date "02.01.2025" → "2025-01-02". */
function parseDate(s: string): string {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((s || '').trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**
 * Turn parsed PayPal rows into unified transactions (source `paypal`).
 * Two passes: (1) map each transaction code to the bank reference of its funding
 * "Bankgutschrift" row; (2) emit one transaction per real merchant payment,
 * attaching that bank reference so it links to the bank's PP.1555.PP debit.
 */
export function paypalRowsToTransactions(
    rows: Array<Record<string, string>>,
    accountKey = 'paypal:hauptkonto',
): UnifiedTransaction[] {
    const codeToBankRef = new Map<string, string>();
    for (const r of rows) {
        const bankRef = r['Bankreferenz'];
        if (!bankRef) continue;
        const own = r['Transaktionscode'];
        const related = r['Zugehöriger Transaktionscode'];
        if (related) codeToBankRef.set(related, bankRef);
        if (own && !codeToBankRef.has(own)) codeToBankRef.set(own, bankRef);
    }

    const out: UnifiedTransaction[] = [];
    for (const r of rows) {
        const name = r['Name'];
        const type = r['Typ'];
        const amount = parseAmount(r['Brutto']);
        if (!name || amount === 0 || MECHANIC_TYPES.has(type)) continue;

        const code = r['Transaktionscode'] || '';
        const bookingDate = parseDate(r['Datum']);
        if (!bookingDate) continue;
        const bankRef = (code && codeToBankRef.get(code)) || r['Bankreferenz'] || undefined;
        // Include the recipient e-mail: for a spend it is the merchant's address and
        // often carries the brand (e.g. "<brand>_<city>@<brand>.com") even when the
        // legal "Name" is opaque (a foreign-language company name), so keyword rules match.
        const item = [r['Artikelbezeichnung'], r['Betreff'], r['Hinweis'], r['Empfänger E-Mail-Adresse']]
            .map((s) => (s || '').trim())
            .filter(Boolean);

        out.push({
            id: code ? `paypal_${code}` : `paypal_${bookingDate}_${Math.round(amount * 100)}`,
            source: 'paypal',
            accountKey,
            bookingDate,
            valueDate: bookingDate,
            amount,
            currency: r['Währung'] || 'EUR',
            counterparty: name,
            purpose: item.join(' · ') || type || undefined,
            // The bank reference (also in the bank's PP.1555.PP purpose) is the match key.
            reference: bankRef,
            type: type || undefined,
        });
    }
    return out;
}

/** Read + parse a PayPal activity CSV export into unified `paypal:` transactions. */
export function parsePaypalCsv(inputPath: string, accountKey = 'paypal:hauptkonto'): UnifiedTransaction[] {
    return paypalRowsToTransactions(parseCsv(readFileSync(inputPath, 'utf8')), accountKey);
}
