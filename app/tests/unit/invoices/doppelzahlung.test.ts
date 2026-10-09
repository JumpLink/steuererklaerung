import { describe, it, expect } from '@gjsify/unit';
import {
    detectDoppelzahlungen,
    type DoppelzahlungCredit,
    type DoppelzahlungInvoice,
} from '../../../src/core/invoices/doppelzahlung.ts';
import { markAlsDoppelzahlung, parseEntscheidung } from '../../../src/core/actions/invoices/doppelzahlung.ts';

// Invented data only: fake customers, round amounts, fake ids.
const inv = (over: Partial<DoppelzahlungInvoice>): DoppelzahlungInvoice => ({
    id: 'inv-1',
    number: 'RE-2026-0001',
    customer: 'Kunde A',
    gross: 1000,
    issueDate: '2026-03-01',
    paidTxId: null,
    status: 'open',
    ...over,
});
const cr = (over: Partial<DoppelzahlungCredit>): DoppelzahlungCredit => ({
    id: 'tx-1',
    bookingDate: '2026-03-10',
    amount: 1000,
    counterparty: 'Kunde A',
    purpose: 'Rechnung RE-2026-0001',
    ...over,
});

export default async () => {
    await describe('detectDoppelzahlungen', async () => {
        await it('zweiter_eingang: a credit quoting the number of an invoice already paid by another tx', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' })];
            const credits = [cr({}), cr({ id: 'tx-2', bookingDate: '2026-03-20' })];
            const v = detectDoppelzahlungen(invoices, credits);
            expect(v.length).toBe(1);
            expect(v[0].art).toBe('zweiter_eingang');
            expect(v[0].rechnungId).toBe('inv-1');
            expect(v[0].rechnungNummer).toBe('RE-2026-0001');
            expect(v[0].kunde).toBe('Kunde A');
            expect(v[0].txIds).toStrictEqual(['tx-2']);
            expect(v[0].zuViel).toBe(1000);
        });

        await it('zweiter_eingang: same payer and amount as the paying tx, no number, booked later', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' })];
            const credits = [cr({}), cr({ id: 'tx-2', bookingDate: '2026-04-02', purpose: 'Überweisung' })];
            const v = detectDoppelzahlungen(invoices, credits);
            expect(v.length).toBe(1);
            expect(v[0].art).toBe('zweiter_eingang');
            expect(v[0].txIds).toStrictEqual(['tx-2']);
            expect(v[0].zuViel).toBe(1000);
        });

        await it('does not flag a same-amount repeat when the customer has an open invoice with that gross', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' }), inv({ id: 'inv-2', number: 'RE-2026-0002' })];
            const credits = [cr({}), cr({ id: 'tx-2', bookingDate: '2026-04-02', purpose: 'Überweisung' })];
            expect(detectDoppelzahlungen(invoices, credits)).toStrictEqual([]);
        });

        await it('does not flag a repeat booked before the paying tx or by another payer', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' })];
            const earlier = cr({ id: 'tx-0', bookingDate: '2026-03-01', purpose: 'Überweisung' });
            const other = cr({
                id: 'tx-2',
                bookingDate: '2026-04-02',
                counterparty: 'Kunde B',
                purpose: 'Überweisung',
            });
            expect(detectDoppelzahlungen(invoices, [earlier, cr({}), other])).toStrictEqual([]);
        });

        await it('ueberzahlung: credits for one invoice sum to more than its gross', async () => {
            const credits = [cr({ amount: 1500 })];
            const v = detectDoppelzahlungen([inv({})], credits);
            expect(v.length).toBe(1);
            expect(v[0].art).toBe('ueberzahlung');
            expect(v[0].zuViel).toBe(500);
            expect(v[0].txIds).toStrictEqual(['tx-1']);
        });

        await it('teilweise: a single credit above the gross is only partly surplus', async () => {
            const v = detectDoppelzahlungen([inv({})], [cr({ amount: 1200 })]);
            expect(v[0].zuViel).toBe(200);
            expect(v[0].teilweise).toBe(true);
        });

        await it('not teilweise: a second receipt that is wholly surplus', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' })];
            const v = detectDoppelzahlungen(invoices, [cr({}), cr({ id: 'tx-2', bookingDate: '2026-03-20' })]);
            expect(v[0].teilweise).toBe(false);
        });

        await it('markAlsDoppelzahlung refuses a partly surplus credit before writing anything', async () => {
            const suspicion = { zuViel: 200, txs: [{ id: 'tx-1', amount: 1200 }] };
            expect(() => markAlsDoppelzahlung('e', 'tx-1', { suspicion, path: '/nonexistent.json' })).toThrow(
                /Nur ein Teil ist zu viel/,
            );
        });

        await it('ueberzahlung: two payments on an open invoice together exceed the gross', async () => {
            const credits = [cr({ amount: 800 }), cr({ id: 'tx-2', amount: 800, bookingDate: '2026-03-12' })];
            const v = detectDoppelzahlungen([inv({})], credits);
            expect(v.length).toBe(1);
            expect(v[0].art).toBe('ueberzahlung');
            expect(v[0].zuViel).toBe(600);
            expect(v[0].txIds).toStrictEqual(['tx-1', 'tx-2']);
        });

        await it('ignores Anzahlung + Restzahlung and partial payments that stay within the gross', async () => {
            const credits = [cr({ amount: 400 }), cr({ id: 'tx-2', amount: 600, bookingDate: '2026-03-20' })];
            expect(detectDoppelzahlungen([inv({})], credits)).toStrictEqual([]);
            const paid = inv({ status: 'paid', paidTxId: 'tx-1' });
            expect(detectDoppelzahlungen([paid], credits)).toStrictEqual([]);
        });

        await it('tolerates one cent', async () => {
            expect(detectDoppelzahlungen([inv({})], [cr({ amount: 1000.01 })])).toStrictEqual([]);
            expect(detectDoppelzahlungen([inv({})], [cr({ amount: 1000.02 })]).length).toBe(1);
        });

        await it('ignores txs the owner already decided', async () => {
            const invoices = [inv({ status: 'paid', paidTxId: 'tx-1' })];
            const credits = [cr({}), cr({ id: 'tx-2', bookingDate: '2026-03-20' })];
            expect(detectDoppelzahlungen(invoices, credits, { ignoreTxIds: new Set(['tx-2']) })).toStrictEqual([]);
        });

        await it("never treats another invoice's paying tx as a suspect", async () => {
            const invoices = [
                inv({ status: 'paid', paidTxId: 'tx-1' }),
                inv({ id: 'inv-2', number: 'RE-2026-0002', status: 'paid', paidTxId: 'tx-2' }),
            ];
            // tx-2 quotes both numbers but settles inv-2; it must not count against inv-1.
            const credits = [cr({}), cr({ id: 'tx-2', purpose: 'RE-2026-0002', bookingDate: '2026-03-12' })];
            expect(detectDoppelzahlungen(invoices, credits)).toStrictEqual([]);
        });

        await it('ignores a combined payment naming several invoices and drafts / cancelled invoices', async () => {
            const invoices = [
                inv({}),
                inv({ id: 'inv-2', number: 'RE-2026-0002' }),
                inv({ id: 'inv-3', number: 'RE-2026-0003', status: 'draft' }),
            ];
            const combined = cr({ amount: 5000, purpose: 'RE-2026-0001 und RE-2026-0002' });
            expect(detectDoppelzahlungen(invoices, [combined])).toStrictEqual([]);
            const onDraft = cr({ id: 'tx-9', amount: 9000, purpose: 'RE-2026-0003' });
            expect(detectDoppelzahlungen(invoices, [onDraft])).toStrictEqual([]);
        });
    });

    await describe('parseEntscheidung', async () => {
        await it('accepts exactly one decision', async () => {
            expect(parseEntscheidung({ inOrdnung: true })).toStrictEqual({ art: 'in_ordnung' });
            expect(parseEntscheidung({ andereRechnung: 'inv-2' })).toStrictEqual({
                art: 'andere_rechnung',
                rechnungId: 'inv-2',
            });
            expect(parseEntscheidung({ rueckzahlung: 'tx-9' })).toStrictEqual({
                art: 'rueckzahlung',
                refundTxId: 'tx-9',
            });
        });
        await it('accepts an external refund date as the one decision', async () => {
            expect(parseEntscheidung({ rueckzahlungExtern: '2026-05-01' })).toStrictEqual({
                art: 'rueckzahlung_extern',
                datum: '2026-05-01',
            });
            expect(() => parseEntscheidung({ rueckzahlungExtern: '2026-05-01', inOrdnung: true })).toThrow();
        });
        await it('rejects none and several', async () => {
            expect(() => parseEntscheidung({})).toThrow();
            expect(() => parseEntscheidung({ inOrdnung: true, rueckzahlung: 'tx-9' })).toThrow();
        });
    });
};
