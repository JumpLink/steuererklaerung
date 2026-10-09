import { describe, it, expect } from '@gjsify/unit';
import { enrichWithPaypal } from '../../../src/core/lib/transactions/paypal-enrich.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: 'x', source: 'camt', accountKey: 'camt:a', bookingDate: '2025-01-03', amount: -10.68, currency: 'EUR', ...over };
}
function pp(reference: string, counterparty: string, purpose: string): UnifiedTransaction {
    return { id: `paypal_${reference}`, source: 'paypal', accountKey: 'paypal:hauptkonto', bookingDate: '2025-01-02', amount: -10.6, currency: 'USD', counterparty, purpose, reference };
}

export default async () => {
    await describe('enrichWithPaypal', async () => {
        const paypal = [pp('1234567890123', 'DeepSeek', 'PayPal Express-Zahlung')];

        await it('folds the PayPal merchant into a bank charge matched by reference', async () => {
            const [out] = enrichWithPaypal([tx({ purpose: '1234567890123/PP.1555.PP/. unklar' })], paypal);
            expect(out.purpose).toContain('DeepSeek');
            expect(out.counterparty).toBe('DeepSeek');
        });

        await it('leaves non-PayPal transactions untouched', async () => {
            const input = tx({ purpose: 'NONREF Bürobedarf 9999' });
            const [out] = enrichWithPaypal([input], paypal);
            expect(out.purpose).toBe('NONREF Bürobedarf 9999');
        });

        await it('passes through unchanged when no PayPal data is loaded', async () => {
            const input = tx({ purpose: '1234567890123/PP.1555.PP/. unklar' });
            expect(enrichWithPaypal([input], [])[0]).toBe(input);
        });
    });
};
