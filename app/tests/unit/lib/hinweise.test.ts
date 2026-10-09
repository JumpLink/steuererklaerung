import { describe, it, expect } from '@gjsify/unit';
import { computeHinweise } from '../../../src/core/elster/hinweise.ts';

const find = (hs: ReturnType<typeof computeHinweise>, key: string) => hs.find((h) => h.key === key);

export default async () => {
    await describe('computeHinweise — §19 Kleinunternehmer', async () => {
        await it('tipp: Regelbesteuerung but turnover under the 2025 threshold', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 15230.53, outputVat: 2893.82 });
            const k = find(hs, 'kleinunternehmer');
            expect(k?.level).toBe('tipp');
            expect(k?.ref).toBe('§ 19 Abs. 1 UStG');
            expect(k?.text.includes('25.000')).toBe(true);
        });
        await it('warnung: turnover over the laufend threshold (100.000 in 2025)', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 120000, outputVat: 22800 });
            expect(find(hs, 'kleinunternehmer')?.level).toBe('warnung');
        });
        await it('uses the lower 2024 thresholds (22.000 / 50.000)', async () => {
            const hs = computeHinweise({ year: 2024, umsatz: 24000, outputVat: 4560 });
            // 24.000 > 22.000 vorjahr but ≤ 50.000 laufend, Regelbesteuerung → info (not tipp)
            const k = find(hs, 'kleinunternehmer');
            expect(k?.level).toBe('info');
            expect(k?.text.includes('22.000')).toBe(true);
        });
        await it('info: shows the current Besteuerungsart when no action is implied', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 60000, outputVat: 11400 });
            expect(find(hs, 'kleinunternehmer')?.title.includes('Regelbesteuerung')).toBe(true);
        });
    });

    await describe('computeHinweise — other notices', async () => {
        await it('warns when USt prepayments are not yet recorded', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 15000,
                outputVat: 2850,
                uste: { vatPayable: 1196.82, closingBalance: 1196.82, prepaidVat: 0 },
            });
            expect(find(hs, 'ust-vorauszahlungen')?.level).toBe('warnung');
        });
        await it('flags the Vorsteuer-without-receipt gap + unclassified bookings', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 15000,
                outputVat: 2850,
                belegLuecke: { count: 12, sum: 1426 },
                unclassified: 3,
            });
            expect(find(hs, 'beleg-luecke')?.level).toBe('warnung');
            expect(find(hs, 'unklassifiziert')?.title.includes('3')).toBe(true);
        });
        await it('notes Betriebsaufgabe, double payments and a 0 GewSt-Messbetrag', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 15000,
                outputVat: 2850,
                businessEndDate: '2025-10-31',
                nachtraeglichNet: 1052,
                doppelzahlungen: 2,
                gewst: { messbetrag: 0 },
            });
            expect(find(hs, 'betriebsaufgabe')?.text.includes('31.10.2025')).toBe(true);
            expect(find(hs, 'doppelzahlungen')?.title.includes('2')).toBe(true);
            expect(find(hs, 'gewst-null')?.level).toBe('info');
        });
        await it('reminds about AfA and the next filing deadline', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 15000,
                outputVat: 2850,
                afa: 695.15,
                afaCount: 3,
                nextDeadline: '2026-08-31',
            });
            expect(find(hs, 'afa')?.text.includes('3 Anlagegut')).toBe(true);
            expect(find(hs, 'frist')?.text.includes('31.08.2026')).toBe(true);
        });
        await it('sorts warnung before tipp before info', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 15000,
                outputVat: 2850, // tipp (klein)
                unclassified: 1, // warnung
                gewst: { messbetrag: 0 }, // info
            });
            expect(hs[0].level).toBe('warnung');
            expect(hs[hs.length - 1].level).toBe('info');
        });
    });

    await describe('computeHinweise — Doppelzahlung', async () => {
        await it('warnung: unresolved suspicion, German title with the count', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 1000, outputVat: 190, doppelzahlungVerdacht: 2 });
            const h = find(hs, 'doppelzahlung-verdacht');
            expect(h?.level).toBe('warnung');
            expect(h?.title).toBe('2 Zahlung(en) möglicherweise doppelt erhalten — klären vor der Abgabe');
        });
        await it('warnung: open refund', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 1000, outputVat: 190, rueckzahlungOffen: 1 });
            const h = find(hs, 'doppelzahlung-rueckzahlung-offen');
            expect(h?.level).toBe('warnung');
            expect(h?.title).toBe('1 Doppelzahlung(en) noch nicht an den Kunden zurückgezahlt');
        });
        await it('no hint at zero / undefined; the neutralised info hint stays', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 1000,
                outputVat: 190,
                doppelzahlungVerdacht: 0,
                doppelzahlungen: 1,
            });
            expect(find(hs, 'doppelzahlung-verdacht')).toBe(undefined);
            expect(find(hs, 'doppelzahlung-rueckzahlung-offen')).toBe(undefined);
            expect(find(hs, 'doppelzahlungen')?.level).toBe('info');
        });
    });
};
