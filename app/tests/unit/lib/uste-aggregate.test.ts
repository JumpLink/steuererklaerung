import { describe, it, expect } from '@gjsify/unit';
import {
    aggregateUsteFromEuerTx,
    computeUsteFormFigures,
    type UsteAggregate,
} from '../../../src/core/elster/uste-aggregate.ts';
import { PRIVATANTEIL_CATEGORY, type EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';

function cat(category: string, net: number, vat: number) {
    return { category, bucket: category, kz: '', kind: 'income' as const, count: 1, net, vat, gross: net + vat };
}

const agg: EuerTxAggregate = {
    year: 2025,
    basis: 'cash-transactions',
    adjustmentsApplied: true,
    income: [cat('8400 Erlöse 19% USt', 1000, 190), cat('8300 Erlöse 7%', 200, 14)],
    expenses: [],
    neutral: [],
    totals: { incomeNet: 1200, outputVat: 204, expenseNet: 300, inputVat: 57, profit: 900, vatPayable: 147, nachtraeglichNet: 0 },
    coverage: { transactions: 0, classifiedByDocument: 0, classifiedByRule: 0, classifiedByManual: 0, unclassified: [], activeFrom: '2025-01-01', activeTo: '2025-12-31', outsidePeriod: [] },
};

export default async () => {
    await describe('aggregateUsteFromEuerTx', async () => {
        await it('splits taxable revenue by rate and carries the EÜR VAT totals', async () => {
            const u = aggregateUsteFromEuerTx(agg);
            expect(u.net_19).toBe(1000);
            expect(u.net_7).toBe(200);
            expect(u.vat_out).toBe(204);
            expect(u.vat_in).toBe(57);
            expect(u.vatPayable).toBe(147);
        });

        await it('computes the closing balance against the prepaid Voranmeldungen', async () => {
            const u = aggregateUsteFromEuerTx(agg, 100);
            expect(u.prepaidVat).toBe(100);
            expect(u.closingBalance).toBe(47); // 147 − 100 Abschlusszahlung
        });
    });

    // The annual Vordruck splits Kz 81 over three lines (22 / 23 / 24) — the USt-VA does not.
    await describe('aggregateUsteFromEuerTx — unentgeltliche Wertabgaben', async () => {
        const mitPrivatanteil: EuerTxAggregate = {
            ...agg,
            income: [...agg.income, cat(PRIVATANTEIL_CATEGORY, 200, 38)],
            totals: { ...agg.totals, incomeNet: 1400, outputVat: 242, profit: 1100, vatPayable: 185 },
        };

        await it('puts the Privatanteil on the §3 Abs. 9a line, not into plain revenue', async () => {
            const u = aggregateUsteFromEuerTx(mitPrivatanteil);
            expect(u.wertabgabeSonstige_19).toBe(200);
            expect(u.lieferungenSonstLeistungen_19).toBe(1000);
            expect(u.net_19).toBe(1200); // Kz 81 stays the total
        });

        await it('taxes the Betriebsaufgabe withdrawal as a §3 Abs. 1b supply', async () => {
            const u = aggregateUsteFromEuerTx(mitPrivatanteil, 0, {
                assets: [
                    { bezeichnung: 'CSL Computer PC855 i7', gemeinerWert: 150 },
                    { bezeichnung: 'PC 899 Core i9-10900K', gemeinerWert: 300 },
                ],
            });
            expect(u.wertabgabeLieferung_19).toBe(450);
            // The Entnahme is NOT in the Ist-EÜR → its USt has to be added on top.
            expect(u.vat_out).toBe(327.5); // 242 + 85,50
            expect(u.vatPayable).toBe(270.5); // 185 + 85,50
        });

        await it('always reconciles the three lines back to Kz 81', async () => {
            const u = aggregateUsteFromEuerTx(mitPrivatanteil, 0, {
                assets: [{ bezeichnung: 'PC', gemeinerWert: 300 }],
            });
            expect(u.lieferungenSonstLeistungen_19 + u.wertabgabeSonstige_19 + u.wertabgabeLieferung_19).toBe(u.net_19);
        });

        await it('ignores assets given up at a gemeiner Wert of 0', async () => {
            const u = aggregateUsteFromEuerTx(agg, 0, {
                assets: [
                    { bezeichnung: 'IKEA Regale', gemeinerWert: 0 },
                    { bezeichnung: 'PC', gemeinerWert: 300 },
                ],
            });
            expect(u.wertabgabeLieferung_19).toBe(300);
            expect(u.entnahmeAssets?.length).toBe(1);
        });

        await it('leaves the figures untouched without a Betriebsaufgabe', async () => {
            const u = aggregateUsteFromEuerTx(agg);
            expect(u.wertabgabeLieferung_19).toBe(0);
            expect(u.vat_out).toBe(204);
            expect(u.entnahmeAssets).toBe(undefined);
        });
    });

    // The ANNUAL FORM derives the tax from the Bemessungsgrundlage rounded DOWN to full euro per rate
    // (NOT the summed per-receipt VAT), including the §13b lines ELSTER does not auto-compute. Fictional
    // Muster values that still exercise the truncation + the full Berechnung chain.
    await describe('computeUsteFormFigures — rechnet wie das Formular (BMG abgerundet)', async () => {
        const muster: UsteAggregate = {
            year: 2025,
            net_19: 10_650.9, // 10000,90 + 450 + 200 (Kz 81 total)
            lieferungenSonstLeistungen_19: 10_000.9,
            wertabgabeLieferung_19: 450,
            wertabgabeSonstige_19: 200,
            entnahmeAssets: [{ bezeichnung: 'Muster-PC', gemeinerWert: 450 }],
            net_7: 500.7,
            net_0: 0,
            vat_out: 2058.62, // per-Beleg (higher than the form-correct tax)
            vat_in: 475.33,
            vatPayable: 1583.29,
            prepaidVat: 1000,
            closingBalance: 583.29,
            prepaidVatSource: 'register',
            reverseCharge: { abs1Base: 558.4, abs1Tax: 106.1, abs2Base: 100.7, abs2Tax: 19.13, deductibleVat: 125.23, count: 3 },
        };

        await it('rounds every BMG DOWN to full euro and derives the tax from it', async () => {
            const f = computeUsteFormFigures(muster);
            expect(f.lieferungen19.bmg).toBe(10_000); // rounded down, not 10.001
            expect(f.lieferungen19.tax).toBe(1900); // 10000 × 19 %
            expect(f.wertabgabeLieferung19?.tax).toBe(85.5); // 450 × 19 %
            expect(f.wertabgabeSonstige19?.tax).toBe(38); // 200 × 19 %
            expect(f.ermaessigt7?.bmg).toBe(500); // 500,70 → 500
            expect(f.ermaessigt7?.tax).toBe(35); // 500 × 7 %
            // Z37 from the rounded-down BMG — NOT the per-Beleg USt (2058,62).
            expect(f.steuerUmsaetze).toBe(2058.5);
        });

        await it('derives the §13b tax per line from the rounded BMG (not the per-receipt sum)', async () => {
            const f = computeUsteFormFigures(muster);
            expect(f.reverseChargeAbs1?.bmg).toBe(558); // 558,40 → 558
            expect(f.reverseChargeAbs1?.tax).toBe(106.02); // 558 × 19 % (NOT 106,10)
            expect(f.reverseChargeAbs2?.bmg).toBe(100); // 100,70 → 100
            expect(f.reverseChargeAbs2?.tax).toBe(19); // 100 × 19 %
            expect(f.steuer13b).toBe(125.02);
            // §13b stays Zahllast-neutral: the tax owed equals the deductible Vorsteuer.
            expect(f.vorsteuer13b).toBe(f.steuer13b);
        });

        await it('chains verbleibende USt → Abschlusszahlung like the form', async () => {
            const f = computeUsteFormFigures(muster);
            expect(f.vorsteuer).toBe(475.33); // Z79 to the cent, not rounded down
            expect(f.vorsteuerSumme).toBe(600.35); // 475,33 + 125,02
            expect(f.verbleibend).toBe(1583.17); // 2058,50 + 125,02 − 600,35
            expect(f.vorauszahlungssoll).toBe(1000);
            expect(f.abschluss).toBe(583.17); // 1583,17 − 1000
            expect(f.prepaidVatSource).toBe('register');
        });

        await it('omits the §13b + 7 % lines when there are none', async () => {
            const f = computeUsteFormFigures({ ...muster, net_7: 0, reverseCharge: undefined });
            expect(f.ermaessigt7).toBeUndefined();
            expect(f.reverseChargeAbs1).toBeUndefined();
            expect(f.reverseChargeAbs2).toBeUndefined();
            expect(f.steuer13b).toBe(0);
            expect(f.vorsteuer13b).toBe(0);
        });
    });
};
