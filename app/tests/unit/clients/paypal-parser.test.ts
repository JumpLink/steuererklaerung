import { describe, it, expect } from '@gjsify/unit';
import { parseCsv, paypalRowsToTransactions } from '../../../src/core/clients/paypal/parser.ts';

// A minimal 3-row PayPal export for one bank-funded payment: the merchant payment,
// its internal cart line, and the "Bankgutschrift" funding row that carries the
// bank reference (the number the bank stores in its PP.1555.PP purpose).
const CSV = `﻿"Datum","Name","Typ","Währung","Brutto","Transaktionscode","Zugehöriger Transaktionscode","Bankreferenz","Artikelbezeichnung","Betreff","Hinweis"
"02.01.2025","DeepSeek","PayPal Express-Zahlung","USD","-10,60","11A111111A111111A","","","AI, comma in, name","",""
"02.01.2025","DeepSeek","Warenkorbartikel","USD","10,00","11A111111A111111A","","","","",""
"02.01.2025","","Bankgutschrift auf PayPal-Konto","EUR","10,68","22B222222B222222B","11A111111A111111A","1234567890123","","",""`;

export default async () => {
    await describe('PayPal CSV parser', async () => {
        await it('parses quoted fields (BOM, embedded comma) into header-keyed rows', async () => {
            const rows = parseCsv(CSV);
            expect(rows).toHaveLength(3);
            expect(rows[0]['Name']).toBe('DeepSeek');
            expect(rows[0]['Artikelbezeichnung']).toBe('AI, comma in, name');
            expect(rows[2]['Bankreferenz']).toBe('1234567890123');
        });

        await it('emits one merchant payment and links the bank reference from the funding row', async () => {
            const txs = paypalRowsToTransactions(parseCsv(CSV));
            expect(txs).toHaveLength(1); // cart line + bank-credit row are skipped as mechanics
            const t = txs[0];
            expect(t.source).toBe('paypal');
            expect(t.counterparty).toBe('DeepSeek');
            expect(t.amount).toBe(-10.6);
            expect(t.currency).toBe('USD');
            expect(t.bookingDate).toBe('2025-01-02');
            // the match key: the bank reference linked from the Bankgutschrift row
            expect(t.reference).toBe('1234567890123');
        });
    });
};
