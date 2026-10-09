import { describe, it, expect } from '@gjsify/unit';
import {
    abgabeWarnungen,
    rankRueckzahlungKandidaten,
    verdachtTitel,
    zahlungZeile,
} from '../../../src/core/invoices/doppelzahlung-text.ts';

export default async () => {
    await describe('doppelzahlung-text', async () => {
        await it('names count and surplus, flags a partial surplus', async () => {
            expect(verdachtTitel({ txIds: ['a', 'b'], zuViel: 119, teilweise: false })).toContain(
                '2 Zahlungen zu viel',
            );
            expect(verdachtTitel({ txIds: ['a'], zuViel: 20, teilweise: true })).toContain('1 Zahlung zu viel');
            expect(verdachtTitel({ txIds: ['a'], zuViel: 20, teilweise: true })).toContain('(teilweise zu viel)');
            expect(verdachtTitel({ txIds: ['a'], zuViel: 20, teilweise: false })).not.toContain('teilweise');
        });

        await it('keeps the counterparty as plain data in the row', async () => {
            const z = zahlungZeile({ bookingDate: '2026-03-04', amount: 119, counterparty: '<b>Muster & Co</b>' });
            expect(z.title).toContain('04.03.2026');
            expect(z.sub).toBe('<b>Muster & Co</b>');
            expect(zahlungZeile({ bookingDate: '2026-03-04', amount: 5 }).sub).toBe('');
        });

        await it('warns only for what is open', async () => {
            expect(abgabeWarnungen({ verdacht: 0, rueckzahlungOffen: 0 })).toStrictEqual([]);
            expect(abgabeWarnungen({ verdacht: 2, rueckzahlungOffen: 0 }).length).toBe(1);
            const both = abgabeWarnungen({ verdacht: 1, rueckzahlungOffen: 3 });
            expect(both.length).toBe(2);
            expect(both[1]).toContain('3 Doppelzahlung(en) noch nicht zurückgezahlt');
        });

        await it('ranks the equal-amount debit first, then newest; drops credits', async () => {
            const txs = [
                { id: 'old-equal', bookingDate: '2026-01-01', amount: -119 },
                { id: 'new-other', bookingDate: '2026-05-01', amount: -40 },
                { id: 'credit', bookingDate: '2026-06-01', amount: 119 },
                { id: 'mid-other', bookingDate: '2026-03-01', amount: -7 },
            ];
            expect(rankRueckzahlungKandidaten(txs, 119).map((t) => t.id)).toStrictEqual([
                'old-equal',
                'new-other',
                'mid-other',
            ]);
            expect(rankRueckzahlungKandidaten(txs, 119, 1).length).toBe(1);
        });
    });
};
