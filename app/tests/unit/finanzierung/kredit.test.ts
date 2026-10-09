import { describe, expect, it } from '@gjsify/unit';

import {
    annuitaet,
    effektivzins,
    finanzierungsmix,
    maxDarlehen,
    mixRestschuldNach,
    restschuldNach,
    tilgungsplan,
    type Tranche,
} from '@steuererklaerung/kredit';
import { deZahl } from '../../../src/frontends/cli/finanzierung.ts';

export default async () => {
    await describe('annuitaet', async () => {
        await it('applies the German convention: (Zins + Tilgung) on the initial amount', async () => {
            // 220.000 · (3,9 % + 2 %) / 12 = 220000 · 0.059 / 12 = 1081,67
            expect(annuitaet(220000, 3.9, 2)).toBe(1081.67);
            // A round case that is exact: 100.000 · 6 % / 12 = 500
            expect(annuitaet(100000, 4, 2)).toBe(500);
        });

        await it('inverts through maxDarlehen', async () => {
            const betrag = maxDarlehen(500, 4, 2);
            expect(betrag).toBe(100000);
            expect(annuitaet(betrag, 4, 2)).toBe(500);
        });

        await it('rejects a zero rate sum, which has no finite loan', async () => {
            expect(() => maxDarlehen(500, 0, 0)).toThrow();
        });
    });

    await describe('tilgungsplan', async () => {
        await it('splits the first instalment into interest and repayment', async () => {
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const first = plan.zeilen[0]!;
            // Month 1 interest = 100000 · 4 % / 12 = 333,33; repayment = 500 − 333,33
            expect(first.zins).toBe(333.33);
            expect(first.tilgung).toBe(166.67);
            expect(first.restschuld).toBe(99833.33);
        });

        await it('shifts the split towards repayment over time', async () => {
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const first = plan.zeilen[0]!;
            const later = plan.zeilen[119]!; // after 10 years
            expect(later.zins < first.zins).toBeTruthy();
            expect(later.tilgung > first.tilgung).toBeTruthy();
            // The instalment itself is constant.
            expect(later.rate).toBe(first.rate);
        });

        await it('reports the debt left when the Zinsbindung ends', async () => {
            const plan = tilgungsplan({
                betrag: 100000,
                sollzins: 4,
                tilgung: 2,
                zinsbindungJahre: 10,
            });
            expect(plan.restschuldNachBindung).not.toBeNull();
            // Roughly 77k after 10 years at 4/2 — assert the band, not a magic constant.
            expect(plan.restschuldNachBindung! > 75000).toBeTruthy();
            expect(plan.restschuldNachBindung! < 80000).toBeTruthy();
            // restschuldNach must agree with it.
            expect(restschuldNach(plan, 10)).toBe(plan.restschuldNachBindung);
        });

        await it('amortises fully and the last instalment is not larger than the rest', async () => {
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, tilgung: 2 });
            expect(plan.laufzeitMonate).not.toBeNull();
            const last = plan.zeilen[plan.zeilen.length - 1]!;
            expect(last.restschuld).toBe(0);
            expect(last.rate <= plan.rate).toBeTruthy();
            // Total repayment equals the loan.
            expect(Math.abs(plan.summeTilgung - 100000) < 0.02).toBeTruthy();
        });

        await it('shortens the term with a Sondertilgung', async () => {
            const ohne = tilgungsplan({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const mit = tilgungsplan({
                betrag: 100000,
                sollzins: 4,
                tilgung: 2,
                sondertilgungProJahr: 5000,
            });
            expect(mit.laufzeitMonate! < ohne.laufzeitMonate!).toBeTruthy();
            expect(mit.summeZins < ohne.summeZins).toBeTruthy();
        });

        await it('reports a never-amortising loan instead of looping forever', async () => {
            // A fixed rate below the monthly interest can never repay anything.
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, rate: 100 });
            expect(plan.laufzeitMonate).toBeNull();
            expect(plan.zeilen.length).toBe(0);
            expect(plan.restschuldNachBindung).toBe(100000);
        });

        await it('accepts a fixed rate as an alternative to a Tilgung percentage', async () => {
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, rate: 500 });
            expect(plan.rate).toBe(500);
            expect(plan.zeilen[0]!.zins).toBe(333.33);
        });

        await it('rejects an input with neither Tilgung nor Rate', async () => {
            expect(() => tilgungsplan({ betrag: 100000, sollzins: 4 })).toThrow();
        });

        await it('rejects a non-positive amount', async () => {
            expect(() => tilgungsplan({ betrag: 0, sollzins: 4, tilgung: 2 })).toThrow();
        });

        await it('aggregates the yearly rows consistently with the monthly ones', async () => {
            const plan = tilgungsplan({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const year1 = plan.jahre[0]!;
            const monthlyZins = plan.zeilen.filter((z) => z.jahr === 1).reduce((s, z) => s + z.zins, 0);
            expect(Math.abs(year1.zins - monthlyZins) < 0.02).toBeTruthy();
            expect(year1.restschuld).toBe(plan.zeilen[11]!.restschuld);
        });
    });

    await describe('effektivzins', async () => {
        await it('equals the monthly compounding of the Sollzins when there are no costs', async () => {
            // (1 + 0.04/12)^12 − 1 = 4.07 %
            const eff = effektivzins({ betrag: 100000, sollzins: 4, tilgung: 2 });
            expect(eff).toBe(4.07);
        });

        await it('rises above the Sollzins once a Disagio shrinks the payout', async () => {
            const plain = effektivzins({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const withDisagio = effektivzins({ betrag: 100000, sollzins: 4, tilgung: 2 }, { disagioProzent: 5 });
            expect(withDisagio > plain).toBeTruthy();
        });

        await it('rises with an upfront fee too', async () => {
            const plain = effektivzins({ betrag: 100000, sollzins: 4, tilgung: 2 });
            const withFee = effektivzins({ betrag: 100000, sollzins: 4, tilgung: 2 }, { gebuehren: 2000 });
            expect(withFee > plain).toBeTruthy();
        });

        await it('refuses a loan that never amortises', async () => {
            expect(() => effektivzins({ betrag: 100000, sollzins: 4, rate: 100 })).toThrow();
        });
    });

    await describe('tilgungsfreie Anlaufjahre', async () => {
        await it('leaves the debt untouched and only charges interest', async () => {
            const plan = tilgungsplan({
                betrag: 100000,
                sollzins: 1,
                tilgung: 2,
                tilgungsfreieAnlaufjahre: 2,
            });
            // Month 24 is still interest-only: 100.000 · 1 % / 12 = 83,33
            expect(plan.zeilen[23].rate).toBe(83.33);
            expect(plan.zeilen[23].tilgung).toBe(0);
            expect(plan.zeilen[23].restschuld).toBe(100000);
            // Month 25 steps up to the full annuity and starts repaying.
            expect(plan.zeilen[24].rate).toBe(annuitaet(100000, 1, 2));
            expect(plan.zeilen[24].tilgung > 0).toBeTruthy();
        });

        await it('pushes the payoff out by exactly the interest-only period', async () => {
            const ohne = tilgungsplan({ betrag: 100000, sollzins: 1, tilgung: 2 });
            const mit = tilgungsplan({
                betrag: 100000,
                sollzins: 1,
                tilgung: 2,
                tilgungsfreieAnlaufjahre: 3,
            });
            expect((mit.laufzeitMonate ?? 0) - (ohne.laufzeitMonate ?? 0)).toBe(36);
            // …and costs the interest of those 36 months on the untouched principal.
            expect(Math.round(mit.summeZins - ohne.summeZins)).toBe(Math.round(100000 * 0.01 * 3));
        });
    });

    await describe('finanzierungsmix', async () => {
        /** A promotional tranche with an interest-only start, plus bank money. */
        const tranchen = (): Tranche[] => [
            {
                key: 'foerder',
                name: 'Förderdarlehen',
                betrag: 140000,
                sollzins: 1,
                tilgung: 2,
                tilgungsfreieAnlaufjahre: 5,
                zinsbindungJahre: 10,
            },
            {
                key: 'bank',
                name: 'Bankdarlehen',
                betrag: 60000,
                sollzins: 4,
                tilgung: 2,
                zinsbindungJahre: 10,
            },
        ];

        await it('adds the tranches up and weights the blended rate by amount', async () => {
            const mix = finanzierungsmix({ tranchen: tranchen() });
            expect(mix.summeDarlehen).toBe(200000);
            // (140.000·1 % + 60.000·4 %) / 200.000 = 1,9 %
            expect(mix.mischzins).toBe(1.9);
        });

        await it('reports the peak burden, not just the first instalment', async () => {
            const mix = finanzierungsmix({ tranchen: tranchen() });
            // Start: 140.000 interest-only (116,67) + bank annuity (300) = 416,67
            expect(mix.startRate).toBe(116.67 + 300);
            // The peak arrives only when the interest-only period ends — checking
            // affordability against the start rate would understate it by ~350 €.
            expect(mix.maxRate > mix.startRate).toBeTruthy();
            expect(mix.maxRateMonat).toBe(61);
        });

        await it('names the tranche that causes each step in the burden', async () => {
            const mix = finanzierungsmix({ tranchen: tranchen() });
            const sprung = mix.stufen.find((s) => s.monat === 61);
            expect(sprung !== undefined).toBeTruthy();
            expect(sprung?.grund.includes('Förderdarlehen')).toBeTruthy();
            expect(sprung?.grund.includes('tilgungsfreie Anlaufzeit')).toBeTruthy();
            expect((sprung?.rateNachher ?? 0) > (sprung?.rateVorher ?? 0)).toBeTruthy();
        });

        await it('counts a grant as cover but never as debt', async () => {
            const mit: Tranche[] = [
                ...tranchen(),
                { key: 'zuschuss', name: 'Zuschuss', betrag: 1, sollzins: 0, tilgung: 100, zuschuss: 20000 },
            ];
            const mix = finanzierungsmix({ tranchen: mit, bedarf: 240000 });
            expect(mix.summeZuschuss).toBe(20000);
            expect(mix.deckung).toBe(220001);
            expect(mix.luecke).toBe(19999);
        });

        await it('sums the residual debt across tranches for the Anschlussfinanzierung', async () => {
            const mix = finanzierungsmix({ tranchen: tranchen() });
            const nach10 = mixRestschuldNach(mix, 10);
            const einzeln = mix.tranchen.reduce((s, t) => s + restschuldNach(t.plan, 10), 0);
            expect(Math.abs(nach10 - einzeln) < 0.02).toBeTruthy();
            // Five interest-only years mean the promotional tranche is barely touched.
            expect(nach10 > 150000).toBeTruthy();
        });

        await it('refuses an empty mix', async () => {
            expect(() => finanzierungsmix({ tranchen: [] })).toThrow();
        });
    });

    await describe('deZahl — German numbers off a bank quote', async () => {
        await it('reads a comma as the decimal mark', async () => {
            // The trap: Number('4,4') is NaN, parseFloat('4,4') is 4. Both would
            // produce a plausible-looking wrong financing instead of an error.
            expect(deZahl('4,4', 'Zins')).toBe(4.4);
            expect(deZahl('1.234,56', 'Betrag')).toBe(1234.56);
        });

        await it('reads a bare dot group as German thousands, not as decimals', async () => {
            expect(deZahl('232.000', 'Betrag')).toBe(232000);
            expect(deZahl('1.234.000', 'Betrag')).toBe(1234000);
        });

        await it('still accepts plain English notation', async () => {
            expect(deZahl('4.4', 'Zins')).toBe(4.4);
            expect(deZahl('232000', 'Betrag')).toBe(232000);
            expect(deZahl(4.4, 'Zins')).toBe(4.4);
        });

        await it('rejects nonsense loudly instead of computing with NaN', async () => {
            expect(() => deZahl('vier komma vier', 'Zins')).toThrow();
            expect(() => deZahl('', 'Zins')).toThrow();
            expect(() => deZahl(Number.NaN, 'Zins')).toThrow();
        });
    });
};
