import { describe, it, expect } from '@gjsify/unit';
import { enrichCamtFromMerchants } from '../../../src/core/lib/transactions/qonto-export-enrich.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: 'x', source: 'camt', accountKey: 'camt:DE15', iban: 'DE15', bookingDate: '2025-11-29', amount: -48.29, currency: 'EUR', ...over };
}

export default async () => {
    await describe('enrichCamtFromMerchants', async () => {
        const merchants = [
            { iban: 'DE15', dates: ['2025-11-28', '2025-11-29'], amount: -48.29, merchant: 'DIGITALOCEAN.COM', method: 'Karte' },
        ];

        await it('folds the merchant into a camt tx matched by iban+date+amount', async () => {
            const { enriched, matched } = enrichCamtFromMerchants([tx({ purpose: 'NONREF 9999' })], merchants);
            expect(matched).toBe(1);
            expect(enriched[0].counterparty).toBe('DIGITALOCEAN.COM');
            expect(enriched[0].purpose).toContain('DIGITALOCEAN.COM');
            expect(enriched[0].purpose).toContain('Karte');
        });

        await it('leaves an unmatched booking (amount differs) untouched', async () => {
            const { enriched, matched } = enrichCamtFromMerchants([tx({ amount: -99, purpose: 'NONREF 9999' })], merchants);
            expect(matched).toBe(0);
            expect(enriched[0].counterparty).toBeUndefined();
        });
    });
};
