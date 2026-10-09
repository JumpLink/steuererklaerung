import { describe, it, expect } from '@gjsify/unit';
import { apportionDocAcrossTransactions } from '../../../src/core/elster/euer-transactions.ts';
import type { TxDocInfo } from '../../../src/core/elster/euer-transactions.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

/**
 * One invoice, several payments — the amount must be SPLIT, not repeated.
 *
 * A supplier's collective invoice is often settled in more than one card charge, and
 * `qonto_transaction_id` then names every booking. The mapping used to give each of them the
 * document's full net and VAT, so the expense was counted once per payment.
 *
 * The fixture is the live case that exposed it: INWX invoice 2025111419, 19,82 € net / 23,58 €
 * gross for three domain renewals, paid as 9,30 € and 14,28 €. The EÜR booked 39,64 € — in a
 * declaration that goes to the Finanzamt.
 */

function tx(id: string, amount: number): UnifiedTransaction {
    return {
        id,
        source: 'qonto',
        accountKey: 'qonto:test',
        bookingDate: '2025-12-22',
        valueDate: '2025-12-22',
        amount,
        currency: 'EUR',
        counterparty: 'WWW.INWX.DE',
    } as UnifiedTransaction;
}

const INVOICE: TxDocInfo = {
    documentId: 2680,
    category: '4955 Domains',
    netEur: 19.82,
    vatEur: 3.76,
    currency: 'EUR',
};

export default async () => {
    await describe('apportionDocAcrossTransactions', async () => {
        await it('splits one invoice across the two payments that settled it', async () => {
            const txs = [tx('a', -9.3), tx('b', -14.28)];
            const out = apportionDocAcrossTransactions(INVOICE, ['a', 'b'], txs);
            const net = out.map(([, i]) => i.netEur ?? 0);
            const vat = out.map(([, i]) => i.vatEur ?? 0);

            // The parts add up to the invoice — that is the whole point.
            expect(Math.round((net[0] + net[1]) * 100) / 100).toBe(19.82);
            expect(Math.round((vat[0] + vat[1]) * 100) / 100).toBe(3.76);
            // …and each part follows its payment's share (9,30 of 23,58 ≈ 39 %).
            expect(net[0]).toBe(7.82);
            expect(net[1]).toBe(12);
        });

        await it('does NOT hand the full amount to every transaction', async () => {
            // The discriminator: the old behaviour returned 19,82 twice, summing to 39,64.
            const txs = [tx('a', -9.3), tx('b', -14.28)];
            const out = apportionDocAcrossTransactions(INVOICE, ['a', 'b'], txs);
            expect(out.every(([, i]) => i.netEur === 19.82)).toBe(false);
            const sum = out.reduce((s, [, i]) => s + (i.netEur ?? 0), 0);
            expect(Math.round(sum * 100) / 100).not.toBe(39.64);
        });

        await it('leaves the single-transaction case byte-identical', async () => {
            // The overwhelming majority of documents back exactly one booking; that path must
            // return the very same object, or every existing figure would shift.
            const out = apportionDocAcrossTransactions(INVOICE, ['a'], [tx('a', -23.58)]);
            expect(out.length).toBe(1);
            expect(out[0][1]).toBe(INVOICE);
        });

        await it('splits evenly when an amount is unknown', async () => {
            // A tx id that is not in the period's transactions carries no weight; an even split
            // is a defensible approximation, a multiplied amount never is.
            const out = apportionDocAcrossTransactions(INVOICE, ['a', 'unbekannt'], [tx('a', -9.3)]);
            const sum = out.reduce((s, [, i]) => s + (i.netEur ?? 0), 0);
            expect(Math.round(sum * 100) / 100).toBe(19.82);
            expect(out[0][1].netEur).toBe(9.91);
        });

        await it('keeps a document without amounts intact', async () => {
            // Nothing to split: the category still has to reach both bookings.
            const bare: TxDocInfo = { documentId: 1, category: '4955 Domains', currency: 'EUR' };
            const out = apportionDocAcrossTransactions(bare, ['a', 'b'], [tx('a', -1), tx('b', -1)]);
            expect(out.length).toBe(2);
            expect(out.every(([, i]) => i.category === '4955 Domains')).toBe(true);
            expect(out.every(([, i]) => i.netEur === undefined)).toBe(true);
        });

        await it('makes the parts sum exactly, even when the split does not divide evenly', async () => {
            // Three equal payments of a 10,00 € net / 11,90 € gross invoice: 3,33 + 3,33 + 3,34,
            // not 9,99. The payments must COVER the invoice — the fixture used to use 1,00 € each,
            // three payments that could never have settled 11,90 €, and the cap added later
            // rightly reduced the document to what they paid. An impossible fixture proves
            // nothing about the rounding it was written for.
            const inv: TxDocInfo = { documentId: 9, category: 'x', netEur: 10, vatEur: 1.9, currency: 'EUR' };
            const txs = [tx('a', -4), tx('b', -4), tx('c', -4)];
            const out = apportionDocAcrossTransactions(inv, ['a', 'b', 'c'], txs);
            const sum = out.reduce((s, [, i]) => s + (i.netEur ?? 0), 0);
            expect(Math.round(sum * 100) / 100).toBe(10);
        });
    });

    /**
     * The other half of the same question: a document may be BIGGER than the bookings it names.
     *
     * The live case: the December Qonto invoice over 1,46 € bundles all three account fees
     * (0,03 + 0,41 + 1,02), but names only the 0,41 booking. That booking took the whole 1,46 €
     * while the other two were classified by rule with their own amounts — 2,51 € of expense for
     * 1,46 € of fees, in an Anlage EÜR about to go to the Finanzamt.
     */
    await describe('a document larger than its bookings', async () => {
        const qonto: TxDocInfo = {
            documentId: 2617,
            category: '4970 Nebenkosten Geldverkehr',
            netEur: 1.46,
            vatEur: 0,
            currency: 'EUR',
        };

        await it('is capped at what that booking actually paid', async () => {
            const out = apportionDocAcrossTransactions(qonto, ['fee'], [tx('fee', -0.41)]);
            expect(out.length).toBe(1);
            expect(out[0][1].netEur).toBe(0.41);
            expect(out[0][1].vatEur).toBe(0);
        });

        await it('does NOT book the full invoice — the discriminator', async () => {
            // The old behaviour returned 1,46; together with the two rule-booked fees that made
            // 2,51 € where 1,46 € was paid.
            const out = apportionDocAcrossTransactions(qonto, ['fee'], [tx('fee', -0.41)]);
            expect(out[0][1].netEur).not.toBe(1.46);
        });

        await it('splits net and VAT so they still add up to the payment', async () => {
            const inv: TxDocInfo = { documentId: 5, category: 'x', netEur: 100, vatEur: 19, currency: 'EUR' };
            const out = apportionDocAcrossTransactions(inv, ['p'], [tx('p', -59.5)]);
            const net = out[0][1].netEur ?? 0;
            const vat = out[0][1].vatEur ?? 0;
            expect(Math.round((net + vat) * 100) / 100).toBe(59.5);
            expect(net).toBe(50);
        });

        await it('leaves a document SMALLER than its payment alone', async () => {
            // One payment settling several invoices is normal — capping upward would invent
            // expense that no document backs.
            const small: TxDocInfo = { documentId: 6, category: 'x', netEur: 10, vatEur: 1.9, currency: 'EUR' };
            const out = apportionDocAcrossTransactions(small, ['p'], [tx('p', -100)]);
            expect(out[0][1]).toBe(small);
        });

        await it('does not cap when a linked booking is missing', async () => {
            // An unknown booking would make the payments look too small and shrink a correct
            // document. Better untouched than wrongly reduced.
            const out = apportionDocAcrossTransactions(qonto, ['fee', 'unbekannt'], [tx('fee', -0.41)]);
            const sum = out.reduce((s, [, i]) => s + (i.netEur ?? 0), 0);
            expect(Math.round(sum * 100) / 100).toBe(1.46);
        });

        await it('leaves a foreign-currency document alone', async () => {
            // netEur is absent for a USD invoice; there is nothing to compare, so nothing to cap.
            const usd: TxDocInfo = { documentId: 7, category: 'x', currency: 'USD' };
            const out = apportionDocAcrossTransactions(usd, ['p'], [tx('p', -5)]);
            expect(out[0][1]).toBe(usd);
        });

        await it('caps before splitting when both apply', async () => {
            const inv: TxDocInfo = { documentId: 8, category: 'x', netEur: 100, vatEur: 0, currency: 'EUR' };
            const out = apportionDocAcrossTransactions(inv, ['a', 'b'], [tx('a', -10), tx('b', -30)]);
            const sum = out.reduce((s, [, i]) => s + (i.netEur ?? 0), 0);
            expect(Math.round(sum * 100) / 100).toBe(40);
        });
    });
};
