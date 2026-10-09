import { describe, it, expect } from '@gjsify/unit';
import { computeBwa } from '../../../src/core/elster/bwa.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';

// Minimal aggregate: computeBwa only reads detail + coverage.outsidePeriod.
const d = (bookingDate: string, category: string, kind: string, net: number) => ({ bookingDate, category, kind, net });
const o = (bookingDate: string, category: string, kind: string, net: number, included: boolean) => ({
    bookingDate,
    category,
    kind,
    net,
    included,
});

const AGG = {
    year: 2025,
    detail: [
        d('2025-03-10', '8400 Erlöse 19% USt', 'income', 1000),
        d('2025-03-12', '4946 Fremdleistungen', 'expense', 150), // direct cost
        d('2025-03-15', '4210 Miete/Raumkosten', 'expense', 300),
        d('2025-04-20', '8400 Erlöse 19% USt', 'income', 500),
        d('2025-04-25', '4964 Software/Lizenzen', 'expense', 100),
        d('2025-12-31', '4830 Abschreibungen (AfA)', 'expense', 200), // synthetic AfA, dated 31.12.
        d('2025-05-01', '1800 Privatentnahme', 'neutral', 0), // neutral → excluded
    ],
    coverage: {
        outsidePeriod: [
            o('2025-11-05', '8410 Nachträgliche Betriebseinnahme (§24)', 'income', 400, true), // kept §24
            o('2025-11-06', '4946 Fremdleistungen', 'expense', 999, false), // successor → excluded
        ],
    },
} as unknown as EuerTxAggregate;

export default async () => {
    await describe('computeBwa', async () => {
        const bwa = computeBwa(AGG, 2025);
        const line = (key: string) => bwa.lines.find((l) => l.key === key);

        await it('buckets only the months that carry a booking', async () => {
            expect(bwa.months).toStrictEqual([3, 4, 11, 12]);
        });

        await it('sums income across Umsatz + §24 (Gesamtleistung)', async () => {
            // 1000 + 500 (Umsatz) + 400 (§24) = 1900
            expect(bwa.totals.gesamtleistung).toBe(1900);
            expect(line('umsatz')?.total).toBe(1500);
            expect(line('sonstige_ertraege')?.total).toBe(400);
        });

        await it('separates the direct cost (Wareneinsatz) → Rohertrag', async () => {
            expect(line('wareneinsatz')?.total).toBe(150);
            expect(bwa.totals.rohertrag).toBe(1750); // 1900 − 150
        });

        await it('sums the operating cost groups (excl. direct)', async () => {
            // Raumkosten 300 + Software 100 + AfA 200 = 600
            expect(bwa.totals.betriebskosten).toBe(600);
            expect(line('raumkosten')?.total).toBe(300);
            expect(line('abschreibungen')?.total).toBe(200);
        });

        await it('Betriebsergebnis reconciles to income − all expense', async () => {
            // 1900 − (150 + 600) = 1150
            expect(bwa.totals.betriebsergebnis).toBe(1150);
            expect(line('betriebsergebnis')?.total).toBe(1150);
        });

        await it('places each amount in its booking month', async () => {
            const erg = line('betriebsergebnis');
            // months [3,4,11,12]: Mar 1000−150−300=550, Apr 500−100=400, Nov 400, Dec −200
            expect(erg?.perMonth).toStrictEqual([550, 400, 400, -200]);
        });

        await it('excludes neutral bookings and non-included §24 items', async () => {
            // the 999 Fremdleistung (included:false) must NOT inflate Wareneinsatz
            expect(line('wareneinsatz')?.total).toBe(150);
            // Privatentnahme (neutral) produces no group line
            expect(bwa.lines.some((l) => l.label.includes('Privatentnahme'))).toBe(false);
        });

        await it('computes the Umsatzrendite margin', async () => {
            expect(line('umsatzrendite')?.total).toBe(Math.round((1150 / 1900) * 100) / 100);
        });
    });
};
