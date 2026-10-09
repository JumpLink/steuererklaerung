import { describe, it, expect } from '@gjsify/unit';
import { amazonRowsToPayments, amazonRowsToOrderInfo } from '../../../src/core/clients/amazon/parser.ts';
import { enrichCamtFromAmazon } from '../../../src/core/lib/transactions/amazon-enrich.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

const rows = [
    {
        Zahlungsdatum: '25/04/2025',
        Zahlungsbetrag: '20,97',
        'Amazon-interne Produktkategorie': 'CE',
        Titel: 'MOBESV Hülle für Oneplus 6T',
    },
    {
        Zahlungsdatum: '03/11/2025',
        Zahlungsbetrag: '395,91',
        'Amazon-interne Produktkategorie': 'Computer & Zubehör',
        Titel: 'Brother ADS-4500W Scanner',
    },
];

function camt(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: 'a', source: 'camt', accountKey: 'camt:DE15', iban: 'DE15', bookingDate: '2025-04-25', amount: -20.97, currency: 'EUR', ...over };
}

export default async () => {
    await describe('Amazon import + enrichment', async () => {
        await it('groups per-article rows into payments keyed by date + amount', async () => {
            const p = amazonRowsToPayments(rows);
            expect(p).toHaveLength(2);
            expect(p[0]).toStrictEqual({ date: '2025-04-25', amount: 20.97, items: ['[CE] MOBESV Hülle für Oneplus 6T'] });
        });

        await it('folds items onto the matching Amazon charge (amount + date window)', async () => {
            const { enriched, matched } = enrichCamtFromAmazon(
                [camt({ counterparty: 'AMZN Mktp DE*U38ZM1195' })],
                amazonRowsToPayments(rows),
            );
            expect(matched).toBe(1);
            expect(enriched[0].purpose).toContain('Oneplus');
        });

        await it('ignores a non-Amazon charge with the same amount', async () => {
            const { matched } = enrichCamtFromAmazon([camt({ counterparty: 'Some Shop' })], amazonRowsToPayments(rows));
            expect(matched).toBe(0);
        });

        await it('groups order info by order number for receipt scoping', async () => {
            const info = amazonRowsToOrderInfo([
                { Bestellnummer: '028-1', 'Amazon-interne Produktkategorie': 'Computer & Zubehör', Titel: 'Maus' },
                { Bestellnummer: '028-1', 'Amazon-interne Produktkategorie': 'Computer & Zubehör', Titel: 'Tastatur' },
                { Bestellnummer: '302-2', 'Amazon-interne Produktkategorie': 'Home Improvement', Titel: 'TOBOLIN' },
            ]);
            expect(info.get('028-1')).toStrictEqual({ categories: ['Computer & Zubehör'], titles: ['Maus', 'Tastatur'] });
            expect(info.get('302-2')?.categories).toStrictEqual(['Home Improvement']);
        });
    });
};
