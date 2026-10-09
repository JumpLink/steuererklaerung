import { describe, it, expect } from '@gjsify/unit';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    aggregateEuerByTransactions,
    type EuerErstattung,
    type TxDocInfo,
} from '../../../src/core/elster/euer-transactions.ts';
import { ustvaAusBuchungen } from '../../../src/core/elster/ustva-buchungen.ts';
import { bewirtungsTeile } from '../../../src/core/elster/splitbuchung.ts';
import { getPeriodDateRange, loadManifest, resolveEntity } from '../../../src/core/config/index.ts';
import { buildTxClassifyRules } from '../../../src/core/actions/elster/euer.ts';
import { buildDemoFilings, buildDemoTransactions } from '../../../src/core/lib/demo/dataset.ts';
import { round2 } from '../../../src/core/lib/money.ts';

// All bookings, names and amounts below are invented.
const BUERO = '4930 Bürobedarf';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'tx',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}
const doc = (net: number, vat: number, category = BUERO): TxDocInfo => ({
    documentId: 1,
    category,
    netEur: net,
    vatEur: vat,
    currency: 'EUR',
});

export default async () => {
    await describe('ustvaAusBuchungen — the USt-VA of a period from the EÜR rows', async () => {
        const kauf = tx({ id: 'kauf', bookingDate: '2026-02-10', amount: -119 });
        const umsatz = tx({ id: 'ums', bookingDate: '2026-02-20', amount: 238, counterparty: 'Kundin A' });
        const buch = tx({ id: 'buch', bookingDate: '2026-03-02', amount: -107 });
        const rueck = tx({ id: 'rueck', bookingDate: '2026-04-15', amount: 119, counterparty: 'Lieferant' });
        const essen = tx({ id: 'essen', bookingDate: '2026-05-08', amount: -119 });
        const fremd = tx({ id: 'fremd', bookingDate: '2026-02-11', amount: -50 });
        const docs = new Map<string, TxDocInfo>([
            ['kauf', doc(100, 19)],
            ['ums', doc(200, 38, '8400 Erlöse 19% USt')],
            ['buch', doc(100, 7, '4940 Fortbildung/Fachliteratur')],
            ['fremd', doc(50, 0, '4970 Nebenkosten Geldverkehr')],
        ]);
        const link: EuerErstattung = { originalTxId: 'kauf', category: BUERO, vatRate: 0.19, originalLabel: 'Kauf' };
        const agg = aggregateEuerByTransactions([kauf, umsatz, buch, rueck, essen, fremd], docs, 2026, {
            detail: true,
            erstattungen: new Map([['rueck', link]]),
            aufteilungen: new Map([['essen', bewirtungsTeile(119)]]),
        });
        const rows = agg.detail!;

        await it('takes revenue by rate and Vorsteuer by payment date', async () => {
            const q1 = ustvaAusBuchungen(rows, '2026-01-01', '2026-03-31');
            expect(q1.net_19).toBe(200);
            expect(q1.vat_out).toBe(38);
            expect(q1.net_7).toBe(0); // the 7 % book is a purchase, not a sale
            expect(q1.vat_in).toBe(26); // 19 (Bürobedarf) + 7 (book) + 0 (bank fee)
        });

        await it('a linked refund takes its Vorsteuer back in the quarter it arrives', async () => {
            const q2 = ustvaAusBuchungen(rows, '2026-04-01', '2026-06-30');
            // −19 (refund) + 19 (whole Bewirtung: 70 % abziehbar AND the 30 % keep their Vorsteuer)
            expect(q2.vat_in).toBe(0);
            expect(q2.net_19).toBe(0);
        });

        await it('the quarters add up to the year the Anlage EÜR declares', async () => {
            const quartale = [1, 2, 3, 4].map((quarter) => {
                const { dateFrom, dateTo } = getPeriodDateRange({ year: 2026, quarter });
                return ustvaAusBuchungen(rows, dateFrom, dateTo);
            });
            expect(round2(quartale.reduce((s, q) => s + q.vat_out, 0))).toBe(agg.totals.outputVat);
            expect(round2(quartale.reduce((s, q) => s + q.vat_in, 0))).toBe(agg.totals.inputVat);
        });
    });

    await describe('EÜR category totals keep debits and credits apart', async () => {
        await it('an unclassified debit is no revenue and its VAT is Vorsteuer', async () => {
            const ein = tx({ id: 'ein', amount: 119, counterparty: 'Unbekannt A', purpose: 'xyz' });
            const aus = tx({ id: 'aus', amount: -238, counterparty: 'Unbekannt B', purpose: 'xyz' });
            const agg = aggregateEuerByTransactions([ein, aus], new Map(), 2026, {});
            expect(agg.coverage.unclassified.length).toBe(2);
            expect(agg.totals.incomeNet).toBe(100);
            expect(agg.totals.outputVat).toBe(19);
            expect(agg.totals.expenseNet).toBe(200);
            expect(agg.totals.inputVat).toBe(38);
        });
    });

    await describe('demo register — the filed Voranmeldungen match the demo bookings', async () => {
        await it('each filed quarter declares what the bookings yield', async () => {
            const elster = resolveEntity(loadManifest('demo/steuererklaerung.json'), 'gbr').elster!;
            const txs = buildDemoTransactions()
                .filter((a) => !a.key.startsWith('fints:'))
                .flatMap((a) => a.txs);
            const rows = aggregateEuerByTransactions(txs, new Map(), 2026, {
                detail: true,
                klassifizierung: buildTxClassifyRules(elster),
            }).detail!;
            for (const f of buildDemoFilings()) {
                const quarter = Number(f.period.slice(-1));
                const { dateFrom, dateTo } = getPeriodDateRange({ year: 2026, quarter });
                const q = ustvaAusBuchungen(rows, dateFrom, dateTo);
                expect(`${f.period}: ${round2(q.vat_out - q.vat_in)}`).toBe(`${f.period}: ${f.declaredAmount}`);
            }
        });
    });
};
