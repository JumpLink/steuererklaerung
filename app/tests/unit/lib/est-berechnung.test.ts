import { describe, it, expect } from '@gjsify/unit';
import { computeEst, estThemeImpacts, type EstInputs } from '../../../src/core/elster/est-berechnung.ts';
import { estTarif, estTarifSplitting, zumutbareBelastung } from '../../../src/core/elster/est-tarif.ts';

// A realistic Einzelveranlagung base case (VZ 2025). Every asserted figure below is hand-computed
// from the pipeline in est-berechnung.ts; the tarifliche ESt is cross-checked against the already
// unit-tested estTarif() rather than a pinned number, so the two kernels stay consistent.
function base(): EstInputs {
    return {
        year: 2025,
        veranlagung: 'einzel',
        kirchensteuersatz: 0.09,
        bruttoarbeitslohn: 45000,
        einbehalten: { lohnsteuer: 7500, soli: 0, kirchensteuer: 600 },
        werbungskosten: {
            homeofficeTage: 100, // 100 × 6 = 600
            pendel: { tage: 120, kmEinfach: 25 }, // 120 × (20×0,30 + 5×0,38) = 120 × 7,90 = 948
            posten: [{ bezeichnung: 'Monitor', betrag: 600, quelle: 'manuell' }],
        },
        vorsorge: {
            rvArbeitnehmer: 4185,
            rvArbeitgeberSteuerfrei: 4185,
            kvBasis: 3000,
            pvBasis: 600,
            sonstige: 300,
            hatAgZuschuss: true,
        },
        sonderausgaben: { spenden: 200, gezahlteKirchensteuer: 600 },
        agb: { krankheitskosten: 1000 },
        par35a: { handwerkerArbeitskosten: 1000, haushaltsnah: 500, minijob: 0 },
    };
}

export default async () => {
    await describe('computeEst — Werbungskosten (Anlage N)', async () => {
        await it('adds Entfernung + Homeoffice + Posten and beats the Pauschbetrag', async () => {
            const r = computeEst(base());
            expect(r.werbungskosten.entfernungspauschale).toBe(948);
            expect(r.werbungskosten.homeofficePauschale).toBe(600);
            expect(r.werbungskosten.angesetzt).toBe(2148);
            expect(r.werbungskosten.pauschbetragGewonnen).toBe(false);
            expect(r.einkuenfte19).toBe(42852);
        });

        await it('falls back to the Arbeitnehmer-Pauschbetrag when actual WK are lower', async () => {
            const inp = base();
            inp.werbungskosten = { homeofficeTage: 10, posten: [] }; // 60 € actual
            const r = computeEst(inp);
            expect(r.werbungskosten.angesetzt).toBe(1230);
            expect(r.werbungskosten.pauschbetragGewonnen).toBe(true);
            expect(r.einkuenfte19).toBe(45000 - 1230);
        });

        await it('caps the Homeoffice-Pauschale at 1.260 €', async () => {
            const inp = base();
            inp.werbungskosten = { homeofficeTage: 300, posten: [] }; // 300×6 = 1.800 → capped
            const r = computeEst(inp);
            expect(r.werbungskosten.homeofficePauschale).toBe(1260);
        });
    });

    await describe('computeEst — Vorsorge (§10 Abs. 3/4 Höchstbeträge)', async () => {
        await it('subtracts the steuerfreier AG-Anteil from the Altersvorsorge', async () => {
            const r = computeEst(base());
            // min(8.370, 29.344) − 4.185 AG = 4.185
            expect(r.vorsorge.altersvorsorgeAbziehbar).toBe(4185);
        });

        await it('deducts Basis-KV/PV in full even above the sonstige-cap (verdrängt weitere)', async () => {
            const r = computeEst(base());
            // Basis-KV 3.000 × 0,96 (§10(1)3 S.4) + PV 600 = 3.480 ≥ cap 1.900 → the sonstige 300 drop
            // out, Basis fully deductible
            expect(r.vorsorge.basisKvPv).toBe(3480);
            expect(r.vorsorge.sonstigeAbziehbar).toBe(3480);
        });

        await it('applies the §10 Abs. 1 Nr. 3 Satz 4 4 %-Krankengeld-Kürzung to the gesetzliche KV only, not the PV', async () => {
            const inp = base();
            // kvBasis 1.000 → 960 deductible (× 0,96); PV 500 stays uncut → basisKvPv 1.460.
            // No AG-Zuschuss (cap 2.800) and no sonstige, so the Basis carries through 1:1.
            inp.vorsorge = { ...inp.vorsorge, kvBasis: 1000, pvBasis: 500, sonstige: 0, hatAgZuschuss: false };
            const r = computeEst(inp);
            expect(r.vorsorge.basisKvPv).toBe(1460); // 1.000×0,96 + 500
            expect(r.vorsorge.sonstigeAbziehbar).toBe(1460);
        });

        await it('fills sonstige up to the cap when Basis-KV/PV is below it', async () => {
            const inp = base();
            inp.vorsorge = { ...inp.vorsorge, kvBasis: 800, pvBasis: 200, sonstige: 1500, hatAgZuschuss: true };
            const r = computeEst(inp);
            // Basis 800×0,96 + 200 = 968 < cap 1.900 → min(968 + 1.500, 1.900) = 1.900
            expect(r.vorsorge.sonstigeAbziehbar).toBe(1900);
        });
    });

    await describe('computeEst — Sonderausgaben & zvE', async () => {
        await it('caps Spenden at 20 % of the GdE and applies the 36 € Pauschbetrag floor', async () => {
            const r = computeEst(base());
            expect(r.sonderausgaben.spenden).toBe(200); // well under 20 % of 42.852
            // KiSt 600 + Spenden 200 = 800 > 36 → 800 angesetzt
            expect(r.sonderausgaben.nichtVorsorgeAngesetzt).toBe(800);
            expect(r.sonderausgaben.gesamt).toBe(8465); // 7.665 Vorsorge (KV −4 %) + 800
        });

        await it('rounds the zvE down to whole euro', async () => {
            const r = computeEst(base());
            // 42.852 − 8.465 − 0 agB = 34.387
            expect(r.zvE).toBe(34387);
            expect(r.tariflicheESt).toBe(estTarif(34387, 2025));
        });
    });

    await describe('computeEst — außergewöhnliche Belastungen (§33 stufenweise)', async () => {
        await it('swallows Krankheitskosten below the zumutbare Belastung and shows it', async () => {
            const r = computeEst(base());
            // stufenweise: 15.340×5 % + (42.852−15.340)×6 % = 767 + 1.650,72 = 2.417,72
            expect(r.agb.zumutbareBelastung).toBe(2417.72);
            expect(r.agb.abziehbar).toBe(0);
            expect(r.agb.geschluckt).toBe(1000);
        });

        await it('deducts only the part above the zumutbare Belastung', async () => {
            const inp = base();
            inp.agb.krankheitskosten = 5000;
            const r = computeEst(inp);
            expect(r.agb.abziehbar).toBe(round2(5000 - 2417.72));
        });

        await it('zumutbareBelastung helper is stufenweise across the band boundary', async () => {
            // single, no kids: 15.340×5 % + (60.000−51.130)... crosses all three bands
            // 767 + (51.130−15.340)×6 % + (60.000−51.130)×7 % = 767 + 2.147,40 + 620,90 = 3.535,30
            expect(zumutbareBelastung(60000, 'einzel', 0, 2025)).toBe(3535.3);
        });
    });

    await describe('computeEst — §35a Steuerermäßigung (auf die tarifliche ESt)', async () => {
        await it('credits 20 % up to the per-category caps, no Verfall at normal income', async () => {
            const r = computeEst(base());
            // Handwerker min(200,1.200) + haushaltsnah min(100,4.000) = 300
            expect(r.ermaessigung35a.berechnet).toBe(300);
            expect(r.ermaessigung35a.angesetzt).toBe(300);
            expect(r.ermaessigung35a.verfallen).toBe(0);
            expect(r.festzusetzendeESt).toBe(round2(r.tariflicheESt - 300));
        });

        await it('caps the credit at the tarifliche ESt and reports the forfeited part (low income)', async () => {
            const inp = base();
            inp.bruttoarbeitslohn = 15000; // pushes zvE below/near the Grundfreibetrag → tiny tarif
            inp.par35a = { handwerkerArbeitskosten: 6000, haushaltsnah: 0, minijob: 0 }; // 1.200 credit
            const r = computeEst(inp);
            expect(r.ermaessigung35a.berechnet).toBe(1200);
            expect(r.ermaessigung35a.angesetzt).toBe(r.tariflicheESt);
            expect(r.ermaessigung35a.verfallen).toBe(round2(1200 - r.tariflicheESt));
            expect(r.festzusetzendeESt).toBe(0);
            expect(r.hinweise.some((h) => h.includes('verfallen'))).toBe(true);
        });
    });

    await describe('computeEst — Annexsteuern & Abrechnung', async () => {
        await it('levies no Soli below the Freigrenze and settles KiSt on the festzusetzende ESt', async () => {
            const r = computeEst(base());
            expect(r.abrechnung.soli.soll).toBe(0); // festzusetzende 5.247 < 19.950
            expect(r.abrechnung.kirchensteuer.soll).toBe(round2(r.festzusetzendeESt * 0.09));
        });

        await it('sums the per-tax settlements into the signed refund (Erstattung > 0)', async () => {
            const r = computeEst(base());
            const sum = round2(
                r.abrechnung.est.erstattung + r.abrechnung.soli.erstattung + r.abrechnung.kirchensteuer.erstattung,
            );
            expect(r.erstattung).toBe(sum);
            expect(r.erstattung > 0).toBe(true);
        });

        await it('goes negative (Nachzahlung) when too little was withheld', async () => {
            const inp = base();
            inp.einbehalten = { lohnsteuer: 3000, soli: 0, kirchensteuer: 0 };
            const r = computeEst(inp);
            expect(r.erstattung < 0).toBe(true);
        });

        await it('levies Soli above the Freigrenze on a high income', async () => {
            const inp = base();
            inp.bruttoarbeitslohn = 120000;
            const r = computeEst(inp);
            expect(r.festzusetzendeESt > 19950).toBe(true);
            expect(r.abrechnung.soli.soll > 0).toBe(true);
        });
    });

    await describe('computeEst — Splitting & Gewerbe', async () => {
        await it('uses the Splittingtarif for a Zusammenveranlagung', async () => {
            const inp = base();
            inp.veranlagung = 'splitting';
            const r = computeEst(inp);
            expect(r.tariflicheESt).toBe(estTarifSplitting(r.zvE, 2025));
        });

        await it('folds Einkünfte aus Gewerbebetrieb into the GdE', async () => {
            const inp = base();
            inp.einkuenfteGewerbe = 10000;
            const r = computeEst(inp);
            expect(r.gesamtbetragEinkuenfte).toBe(round2(r.einkuenfte19 + 10000));
        });

        await it('folds festgestellte Beteiligungsanteile into the Gewerbe-Einkünfte (like the E10 XML)', async () => {
            const inp = base();
            inp.einkuenfteGewerbe = 10000;
            inp.einkuenfteGewerbeBeteiligungen = -9.05; // e.g. a GbR-Anteil (Aufgabeverlust nets negative)
            const r = computeEst(inp);
            expect(r.einkuenfteGewerbe).toBe(round2(10000 - 9.05));
            expect(r.gesamtbetragEinkuenfte).toBe(round2(r.einkuenfte19 + 10000 - 9.05));
        });
    });

    await describe('computeEst — §32b Progressionsvorbehalt', async () => {
        await it('lowers the tarifliche ESt for a repayment (negative Progressionseinkünfte), zvE unchanged', async () => {
            const ref = computeEst(base());
            const inp = base();
            inp.progressionseinkuenfte = -538.53; // e.g. an Elterngeld repayment
            const r = computeEst(inp);
            expect(r.zvE).toBe(ref.zvE); // §32b only changes the rate, not the zvE
            expect(r.tariflicheESt < ref.tariflicheESt).toBe(true);
            expect(r.progressionseinkuenfte).toBe(-538.53);
        });

        await it('raises the tarifliche ESt for received Leistungen (Elterngeld)', async () => {
            const ref = computeEst(base());
            const inp = base();
            inp.progressionseinkuenfte = 8000;
            expect(computeEst(inp).tariflicheESt > ref.tariflicheESt).toBe(true);
        });
    });

    await describe('computeEst — §24b Entlastungsbetrag Alleinerziehende', async () => {
        await it('deducts the anteiligen Entlastungsbetrag from the GdE and lowers the zvE', async () => {
            const ref = computeEst(base());
            const inp = base();
            inp.entlastungAlleinerziehende = { monate: 2, weitereKinder: 0 }; // e.g. Nov+Dec
            const r = computeEst(inp);
            expect(r.entlastungAlleinerziehende).toBe(round2((4260 * 2) / 12)); // 710
            expect(r.gesamtbetragEinkuenfte).toBe(round2(ref.gesamtbetragEinkuenfte - 710));
            expect(r.zvE < ref.zvE).toBe(true);
        });

        await it('adds the Erhöhungsbetrag (240 €) per further child, ganzjährig', async () => {
            const inp = base();
            inp.entlastungAlleinerziehende = { monate: 12, weitereKinder: 2 };
            expect(computeEst(inp).entlastungAlleinerziehende).toBe(4260 + 240 * 2);
        });

        await it('grants nothing without qualifying months', async () => {
            const inp = base();
            inp.entlastungAlleinerziehende = { monate: 0, weitereKinder: 3 };
            expect(computeEst(inp).entlastungAlleinerziehende).toBe(0);
        });
    });

    await describe('estThemeImpacts — exact counterfactual', async () => {
        await it('values §35a Handwerker at the credit plus its KiSt knock-on', async () => {
            const impacts = estThemeImpacts(base());
            const handwerker = impacts.find((t) => t.key === 'handwerker');
            expect(handwerker?.amount).toBe(1000);
            // 200 € credit + 200×9 % KiSt = 218 €
            expect(handwerker?.impact).toBe(218);
        });

        await it('shows 0 € impact for a Gesundheit theme swallowed by the zumutbare Belastung', async () => {
            const impacts = estThemeImpacts(base());
            const gesundheit = impacts.find((t) => t.key === 'gesundheit');
            expect(gesundheit?.amount).toBe(1000);
            expect(gesundheit?.impact).toBe(0);
        });

        await it('measures the Arbeit theme against the Pauschbetrag baseline, not zero', async () => {
            const impacts = estThemeImpacts(base());
            const arbeit = impacts.find((t) => t.key === 'arbeit');
            // amount = 948 + 600 + 600 = 2.148; impact = value of the 918 € above the 1.230 Pauschbetrag
            expect(arbeit?.amount).toBe(2148);
            expect((arbeit?.impact ?? 0) > 0).toBe(true);
        });
    });

    await describe('computeEst — Schulgeld (§10 Nr. 9) & Kinderbetreuung (§10 Nr. 5)', async () => {
        await it('deducts 30 % of the Schulgeld, capped at 5.000 € per child, and lowers the zvE', async () => {
            // Kirchensteuer 600 in both cases so the 36 € Pauschbetrag floor cannot interfere;
            // Schulgeld 3.000 → a clean 900 € deduction, so the zvE difference is exact (no rounding play).
            const sa = (schulgeld: number) => ({ spenden: 0, gezahlteKirchensteuer: 600, schulgeld });
            const r = computeEst({ ...base(), kinder: 3, sonderausgaben: sa(3000) });
            expect(r.sonderausgaben.schulgeld).toBe(900); // 30 % of 3.000, under 5.000 × 3
            const ohne = computeEst({ ...base(), kinder: 3, sonderausgaben: sa(0) });
            expect(ohne.zvE - r.zvE).toBe(900);
        });

        await it('caps Kinderbetreuung at 80 % and 4.800 € per child (VZ 2025, JStG 2024)', async () => {
            const r = computeEst({ ...base(), kinder: 1, sonderausgaben: { spenden: 0, gezahlteKirchensteuer: 0, kinderbetreuung: 9000 } });
            expect(r.sonderausgaben.kinderbetreuung).toBe(4800); // 80 % × 9.000 = 7.200, capped at 4.800
        });

        await it('caps PER CHILD when Je-Kind-Beträge vorliegen (kein Pauschal-Deckel × Kinderzahl)', async () => {
            // Kind 1: 10.000 € Schulgeld → 30 % = 3.000, under 5.000; Kind 2: 20.000 € → 30 % = 6.000 → 5.000.
            const r = computeEst({
                ...base(),
                kinder: 2,
                sonderausgaben: { spenden: 0, gezahlteKirchensteuer: 0, schulgeld: 30000, schulgeldJeKind: [10000, 20000] },
            });
            expect(r.sonderausgaben.schulgeld).toBe(8000); // 3.000 + 5.000 instead of min(9.000, 2 × 5.000)
            const b = computeEst({
                ...base(),
                kinder: 2,
                sonderausgaben: { spenden: 0, gezahlteKirchensteuer: 0, kinderbetreuung: 8000, kinderbetreuungJeKind: [8000, 0] },
            });
            expect(b.sonderausgaben.kinderbetreuung).toBe(4800); // 80 % × 8.000 = 6.400 → 4.800 per child, not 2 × 4.800
        });

        await it('grants no Schulgeld deduction without children (Hinweis)', async () => {
            const r = computeEst({ ...base(), kinder: 0, sonderausgaben: { spenden: 0, gezahlteKirchensteuer: 0, schulgeld: 3000 } });
            expect(r.sonderausgaben.schulgeld).toBe(0);
            expect(r.hinweise.some((h) => h.includes('kinder = 0'))).toBe(true);
        });
    });

    await describe('computeEst — §34g Parteizuwendungen (Steuerermäßigung)', async () => {
        await it('reduces the tarifliche ESt by 50 % of the contribution (before §35a)', async () => {
            const withParty = computeEst({ ...base(), par34g: { parteibeitrag: 70 } });
            const without = computeEst({ ...base(), par34g: { parteibeitrag: 0 } });
            expect(withParty.ermaessigung34g.angesetzt).toBe(35);
            expect(round2(without.festzusetzendeESt - withParty.festzusetzendeESt)).toBe(35);
        });

        await it('caps the begünstigte Zuwendung at 1.650 € (825 € credit) and hints at the overflow', async () => {
            const r = computeEst({ ...base(), par34g: { parteibeitrag: 2000 } });
            expect(r.ermaessigung34g.beguenstigt).toBe(1650);
            expect(r.ermaessigung34g.angesetzt).toBe(825);
            expect(r.hinweise.some((h) => h.includes('§34g'))).toBe(true);
        });
    });
};

/** Local round-2 mirror so the test file stays independent of the money module path. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
