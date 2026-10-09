import { describe, it, expect } from '@gjsify/unit';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { aggregateEstByTransactions, classifyPrivateTransaction } from '../../../src/core/elster/est-aggregate.ts';

let seq = 0;
function tx(partial: Partial<UnifiedTransaction> & { amount: number }): UnifiedTransaction {
    seq += 1;
    return {
        id: partial.id ?? `t${seq}`,
        source: 'fints',
        accountKey: 'fints:demo-giro',
        bookingDate: partial.bookingDate ?? '2025-06-01',
        amount: partial.amount,
        currency: 'EUR',
        counterparty: partial.counterparty,
        purpose: partial.purpose,
        category: partial.category,
        reference: partial.reference,
        type: partial.type,
    };
}

// Mirrors the demo privat account (src/lib/demo/dataset.ts txPrivat).
function demoPrivate(): UnifiedTransaction[] {
    return [
        tx({ id: 'gehalt', amount: 2850, counterparty: 'Nordsee IT GmbH', purpose: 'Gehalt', category: 'Einnahmen (privat)' }),
        tx({ id: 'miete', amount: -995, counterparty: 'Hausverwaltung', purpose: 'Miete Wohnung', category: 'Miete (privat)' }),
        tx({ id: 'nk', amount: -124.3, counterparty: 'Stadtwerke', purpose: 'Strom & Gas', category: 'Nebenkosten (privat)' }),
        tx({ id: 'elektro', amount: -238, counterparty: 'Elektro Petersen', purpose: 'Elektroinstallation', category: 'Handwerkerleistungen' }),
        tx({ id: 'zahn', amount: -386.5, counterparty: 'Zahnarztpraxis Dr. Kern', purpose: 'Zahnbehandlung', category: 'Gesundheit' }),
        tx({ id: 'fahr', amount: -89, counterparty: 'Fahrschule Nordlicht', purpose: 'Fahrstunde', category: 'Sonstiges' }),
        tx({ id: 'maler', amount: -714, counterparty: 'Malermeister Voss', purpose: 'Malerarbeiten Wohnung', category: 'Handwerkerleistungen' }),
        tx({ id: 'spende', amount: -150, counterparty: 'Seenotretter e.V.', purpose: 'Spende', category: 'Spenden' }),
    ];
}

export default async () => {
    await describe('classifyPrivateTransaction', async () => {
        await it('routes Handwerker, Gesundheit, Spenden, Gehalt by keyword', async () => {
            expect(classifyPrivateTransaction(tx({ amount: -714, counterparty: 'Malermeister Voss', purpose: 'Malerarbeiten' })).bucket).toBe('handwerker');
            expect(classifyPrivateTransaction(tx({ amount: -386.5, counterparty: 'Zahnarztpraxis Dr. Kern', purpose: 'Zahnbehandlung' })).bucket).toBe('gesundheit');
            expect(classifyPrivateTransaction(tx({ amount: -150, counterparty: 'Seenotretter e.V.', purpose: 'Spende' })).bucket).toBe('spenden');
            expect(classifyPrivateTransaction(tx({ amount: 2850, purpose: 'Gehalt' })).bucket).toBe('gehalt');
        });

        await it('recognises haushaltsnahe DL and Versicherungen', async () => {
            expect(classifyPrivateTransaction(tx({ amount: -60, counterparty: 'Gartenpflege Meyer', purpose: 'Gartenpflege' })).bucket).toBe('haushaltsnah');
            expect(classifyPrivateTransaction(tx({ amount: -94.8, counterparty: 'Versicherung Nord', purpose: 'Private Haftpflicht' })).bucket).toBe('vorsorge');
        });

        await it('leaves an unknown purpose unclassified (neutral)', async () => {
            const c = classifyPrivateTransaction(tx({ amount: -89, counterparty: 'Fahrschule Nordlicht', purpose: 'Fahrstunde', category: 'Sonstiges' }));
            expect(c.bucket).toBe('neutral');
            expect(c.source).toBe('unclassified');
        });
    });

    await describe('aggregateEstByTransactions — demo private account', async () => {
        await it('rolls up the theme buckets and treats §35a gross as an upper bound', async () => {
            const a = aggregateEstByTransactions(demoPrivate(), 2025);
            expect(a.handwerkerBrutto).toBe(952); // 238 + 714, gross
            expect(a.handwerkerArbeitskosten).toBe(0); // no overrides yet → claims nothing
            expect(a.par35aOhneArbeitskosten).toBe(2); // both Handwerker txs flagged
            expect(a.krankheitskosten).toBe(386.5);
            expect(a.spenden).toBe(150);
            expect(a.gehaltNettoSumme).toBe(2850);
        });

        await it('claims the Arbeitskosten once per-item overrides are supplied', async () => {
            const a = aggregateEstByTransactions(demoPrivate(), 2025, {
                overrides: { arbeitskosten: { elektro: 160, maler: 420 } },
            });
            expect(a.handwerkerArbeitskosten).toBe(580); // 160 + 420 (Arbeitslohn only)
            expect(a.par35aOhneArbeitskosten).toBe(0);
        });

        await it('caps an override at the transaction gross', async () => {
            const a = aggregateEstByTransactions(demoPrivate(), 2025, {
                overrides: { arbeitskosten: { elektro: 9999 } },
            });
            expect(a.handwerkerArbeitskosten).toBe(238); // min(9999, 238)
        });

        await it('counts Miete/Nebenkosten as neutral, not unclassified', async () => {
            const a = aggregateEstByTransactions(demoPrivate(), 2025);
            const unclassifiedIds = a.coverage.unclassified.map((u) => u.id);
            expect(unclassifiedIds.includes('miete')).toBe(false);
            expect(unclassifiedIds.includes('fahr')).toBe(true); // Fahrschule/Sonstiges is unknown
        });

        await it('turns arbeit transactions into Werbungskosten posten', async () => {
            const txs = [...demoPrivate(), tx({ id: 'buch', amount: -49.9, counterparty: 'Fachbuchhandlung', purpose: 'Fachliteratur TypeScript' })];
            const a = aggregateEstByTransactions(txs, 2025);
            expect(a.werbungskostenPosten.length).toBe(1);
            expect(a.werbungskostenPosten[0].betrag).toBe(49.9);
            expect(a.werbungskostenPosten[0].quelle).toBe('transaktion');
        });

        await it('respects a reclassification override', async () => {
            // Force the Fahrschule tx into Werbungskosten (Fortbildung).
            const a = aggregateEstByTransactions(demoPrivate(), 2025, {
                overrides: { reklassifizierung: { fahr: 'arbeit' } },
            });
            expect(a.werbungskostenPosten.some((p) => p.betrag === 89)).toBe(true);
            expect(a.coverage.unclassified.map((u) => u.id).includes('fahr')).toBe(false);
        });

        await it('filters to the requested year', async () => {
            const txs = [...demoPrivate(), tx({ id: 'old', amount: -500, counterparty: 'Malermeister Voss', purpose: 'Maler', bookingDate: '2024-09-03' })];
            const a = aggregateEstByTransactions(txs, 2025);
            expect(a.handwerkerBrutto).toBe(952); // the 2024 Maler tx excluded
        });
    });
};
