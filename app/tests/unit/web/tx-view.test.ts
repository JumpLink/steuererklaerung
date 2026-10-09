import { describe, it, expect } from '@gjsify/unit';
import { enrichViewRows, accountLabel } from '../../../src/core/lib/tx-view.ts';
import type { EuerTxDetailRow } from '../../../src/core/elster/euer-transactions.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

function row(over: Partial<EuerTxDetailRow>): EuerTxDetailRow {
    return {
        id: 'r',
        accountKey: 'camt:DE15',
        bookingDate: '2025-09-02',
        amount: -10,
        kind: 'expense',
        source: 'rule',
        category: 'X',
        kz: '',
        net: 10,
        vat: 0,
        gross: 10,
        ...over,
    };
}

export default async () => {
    await describe('accountLabel', async () => {
        await it('uses the config label, else falls back to source + IBAN tail', async () => {
            expect(accountLabel('camt:DE89370400440532013000', { 'camt:DE89370400440532013000': 'Hauptkonto' })).toBe(
                'Hauptkonto',
            );
            expect(accountLabel('camt:DE89370400440532013000')).toBe('camt …3000');
        });
    });

    await describe('enrichViewRows', async () => {
        await it('pairs the two legs of an internal transfer across two accounts', async () => {
            const rows = [
                row({
                    id: 'a',
                    accountKey: 'camt:DE15',
                    amount: -200,
                    category: '1360 Interne Überweisung',
                    kind: 'neutral',
                }),
                row({
                    id: 'b',
                    accountKey: 'camt:DE31',
                    amount: 200,
                    category: '1360 Interne Überweisung',
                    kind: 'neutral',
                }),
            ];
            const out = enrichViewRows(rows, { labels: { 'camt:DE15': 'Hauptkonto', 'camt:DE31': 'Steuerkonto' } });
            const a = out.find((r) => r.id === 'a');
            const b = out.find((r) => r.id === 'b');
            expect(a?.transfer?.groupId).toBe(b?.transfer?.groupId);
            expect(a?.transfer?.direction).toBe('out');
            expect(a?.transfer?.partner).toBe('Steuerkonto');
            expect(b?.transfer?.partner).toBe('Hauptkonto');
            expect(a?.account).toBe('Hauptkonto');
        });

        await it('does NOT pair two legs on the same account', async () => {
            const rows = [
                row({
                    id: 'a',
                    accountKey: 'camt:DE15',
                    amount: -50,
                    category: '1360 Interne Überweisung',
                    kind: 'neutral',
                }),
                row({
                    id: 'b',
                    accountKey: 'camt:DE15',
                    amount: 50,
                    category: '1360 Interne Überweisung',
                    kind: 'neutral',
                }),
            ];
            const out = enrichViewRows(rows);
            expect(out[0].transfer).toBeUndefined();
        });

        await it('attaches the matched PayPal source by embedded reference', async () => {
            const rows = [
                row({ id: 'c', purpose: '1000000000022/PP.1555.PP/. DigitalO', category: '4806 Hosting/Cloud' }),
            ];
            const pp: UnifiedTransaction[] = [
                {
                    id: 'p',
                    source: 'paypal',
                    accountKey: 'paypal:x',
                    bookingDate: '2025-09-02',
                    amount: -179.57,
                    currency: 'EUR',
                    counterparty: 'DigitalOcean',
                    purpose: 'Server',
                    reference: '1000000000022',
                },
            ];
            const out = enrichViewRows(rows, { paypalTxs: pp });
            expect(out[0].paypal?.merchant).toBe('DigitalOcean');
        });
    });
};
