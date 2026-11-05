import { describe, it, expect } from '@gjsify/unit';
import type { ElsterVorsteuerOhneZahlung } from '../../../src/core/config/index.ts';
import {
    mitVorsteuerOhneZahlung,
    summeVorsteuerOhneZahlung,
    vorsteuerOhneZahlungDesJahres,
    vorsteuerOhneZahlungImZeitraum,
} from '../../../src/core/elster/vorsteuer-ohne-zahlung.ts';
import { aggregateUsteFromEuerTx, computeUsteFormFigures } from '../../../src/core/elster/uste-aggregate.ts';
import type { UstvaAggregate } from '../../../src/core/elster/ustva-aggregate.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';

// All items and amounts below are invented.
const abfindung: ElsterVorsteuerOhneZahlung = {
    datum: '2025-05-20',
    bezeichnung: 'Sachwert Testgerät',
    netto: 1000,
    vorsteuer: 190,
    rechnungsnummer: 'T-1',
};
const spaeter: ElsterVorsteuerOhneZahlung = { datum: '2025-11-02', bezeichnung: 'Zweite', netto: 100, vorsteuer: 19 };
const items = [abfindung, spaeter];

const ustva: UstvaAggregate = {
    net_19: 500,
    net_7: 0,
    vat_out: 95,
    vat_in: 10,
    outgoing_count: 1,
    incoming_count: 1,
};

const euer: EuerTxAggregate = {
    year: 2025,
    basis: 'cash-transactions',
    adjustmentsApplied: true,
    income: [
        {
            category: '8400 Erlöse 19% USt',
            bucket: 'x',
            kz: '',
            kind: 'income',
            count: 1,
            net: 1000,
            vat: 190,
            gross: 1190,
        },
    ],
    expenses: [],
    neutral: [],
    totals: {
        incomeNet: 1000,
        outputVat: 190,
        expenseNet: 50,
        inputVat: 9.5,
        profit: 950,
        vatPayable: 180.5,
        nachtraeglichNet: 0,
    },
    coverage: {
        transactions: 0,
        classifiedByDocument: 0,
        classifiedByRule: 0,
        classifiedByManual: 0,
        unclassified: [],
        activeFrom: '2025-01-01',
        activeTo: '2025-12-31',
        outsidePeriod: [],
    },
};

export default async () => {
    await describe('Vorsteuer ohne Zahlung — Auswahl', async () => {
        await it('takes only the items whose Rechnungseingang lies in the period (inclusive)', async () => {
            const q2 = vorsteuerOhneZahlungImZeitraum(items, '2025-04-01', '2025-06-30');
            expect(q2.length).toBe(1);
            expect(q2[0]).toBe(abfindung);
            const tag = vorsteuerOhneZahlungImZeitraum(items, '2025-05-20', '2025-05-20');
            expect(tag.length).toBe(1);
            expect(tag[0]).toBe(abfindung);
            expect(vorsteuerOhneZahlungImZeitraum(items, '2025-07-01', '2025-09-30').length).toBe(0);
        });
        await it('takes the items of a calendar year and tolerates an absent list', async () => {
            expect(vorsteuerOhneZahlungDesJahres(items, 2025).length).toBe(2);
            expect(vorsteuerOhneZahlungDesJahres(items, 2024).length).toBe(0);
            expect(vorsteuerOhneZahlungImZeitraum(undefined, '2025-01-01', '2025-12-31').length).toBe(0);
        });
        await it('sums the deductible VAT', async () => {
            expect(summeVorsteuerOhneZahlung(items)).toBe(209);
        });
    });

    await describe('Vorsteuer ohne Zahlung — USt-VA', async () => {
        await it('adds the Vorsteuer to Kz 66 and counts the item', async () => {
            const r = mitVorsteuerOhneZahlung(ustva, [abfindung]);
            expect(r.vat_in).toBe(200);
            expect(r.incoming_count).toBe(2);
            expect(r.vat_out).toBe(95);
        });
        await it('returns the aggregate unchanged when nothing falls into the period', async () => {
            expect(mitVorsteuerOhneZahlung(ustva, [])).toBe(ustva);
        });
    });

    await describe('Vorsteuer ohne Zahlung — USt-Jahr', async () => {
        await it('adds the year’s items to the input VAT and lowers the Zahllast', async () => {
            const u = aggregateUsteFromEuerTx(euer, 0, undefined, items);
            expect(u.vat_in).toBe(218.5); // 9,50 + 190 + 19
            expect(u.vatPayable).toBe(-28.5); // 190 − 218,50
            expect(u.vorsteuerOhneZahlung?.length).toBe(2);
            expect(computeUsteFormFigures(u).vorsteuer).toBe(218.5);
        });
        await it('ignores items of another year and leaves the shape alone without any', async () => {
            const u = aggregateUsteFromEuerTx(euer, 0, undefined, [{ ...abfindung, datum: '2024-12-31' }]);
            expect(u.vat_in).toBe(9.5);
            expect('vorsteuerOhneZahlung' in u).toBe(false);
        });
    });
};
