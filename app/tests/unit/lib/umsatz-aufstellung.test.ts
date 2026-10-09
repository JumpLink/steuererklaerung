import { describe, it, expect } from '@gjsify/unit';
import {
    assembleUmsatzReport,
    toUmsatzPdfModel,
    umsatzToCsv,
    type UmsatzCoverage,
} from '../../../src/core/actions/umsatz-aufstellung.ts';
import type { EuerTxAggregate, EuerTxDetailRow } from '../../../src/core/elster/euer-transactions.ts';
import type { UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';

function income(over: Partial<EuerTxDetailRow>): EuerTxDetailRow {
    return {
        id: 'x',
        accountKey: 'camt:DE15',
        bookingDate: '2023-06-15',
        amount: 0,
        kind: 'income',
        source: 'rule',
        category: '8400 Erlöse 19 %',
        kz: '',
        net: 0,
        vat: 0,
        gross: 0,
        ...over,
    };
}

// Three SYNTHETIC revenue lines (Kunde A/B/C) summing to net 33.558,02 € (all 19 %) — chosen only
// to exercise the aggregation/rounding, NOT a real figure. (The actual GbR 2023 turnover is
// 54.192 € per the official USt-Jahreserklärung / Paperless #2967; the store was incomplete for
// Jan–May 2023, which is exactly the case the coverage warning is built to surface.)
const AGG = {
    detail: [
        income({
            bookingDate: '2023-07-20',
            counterparty: 'Kunde B',
            purpose: 'Zahlung Rechnung RG5567',
            net: 20000,
            vat: 3800,
            gross: 23800,
        }),
        income({
            bookingDate: '2023-06-15',
            counterparty: 'Kunde A',
            purpose: 'RE-2023-001 Beratung',
            net: 10000,
            vat: 1900,
            gross: 11900,
        }),
        income({
            bookingDate: '2023-08-01',
            counterparty: 'Kunde C',
            purpose: 'Design',
            net: 3558.02,
            vat: 676.02,
            gross: 4234.04,
        }),
    ],
} as unknown as EuerTxAggregate;

const USTE = { net_19: 33558.02, net_7: 0, net_0: 0, vat_out: 6376.02, vat_in: 0, vatPayable: 6376.02 } as UsteAggregate;

const FULL: UmsatzCoverage = { firstDate: '2023-01-05', lastDate: '2023-12-28', fullYear: true, warning: null };
const META = { entityId: 'gbr', entityName: 'Muster & Partner GbR', taxNumber: '11/222/33333', year: 2023, basis: 'ist' as const };

export default async () => {
    await describe('assembleUmsatzReport', async () => {
        const report = assembleUmsatzReport(AGG, USTE, FULL, META);

        await it('sums the net revenue to the target Bemessungsgrundlage', async () => {
            expect(report.totalNet).toBe(33558.02);
            expect(report.netByRate.rate19).toBe(33558.02);
            expect(report.netByRate.rate7).toBe(0);
        });

        await it('sums USt and gross consistently', async () => {
            expect(report.totalVat).toBe(6376.02);
            expect(report.totalGross).toBe(39934.04);
        });

        await it('sorts rows by date and extracts invoice references', async () => {
            expect(report.rows.map((r) => r.date)).toStrictEqual(['2023-06-15', '2023-07-20', '2023-08-01']);
            expect(report.rows[0].ref).toBe('RE-2023-001');
            expect(report.rows[1].ref).toBe('RG5567');
            expect(report.rows[2].ref).toBeNull();
        });

        await it('flags a reconciliation mismatch when the USt aggregate disagrees', async () => {
            const skewed = { ...USTE, net_19: 30000 } as UsteAggregate;
            const r2 = assembleUmsatzReport(AGG, skewed, FULL, META);
            expect(r2.reconciliationNote).not.toBeNull();
            expect(report.reconciliationNote).toBeNull(); // the matching case stays clean
        });
    });

    await describe('umsatzToCsv', async () => {
        const csv = umsatzToCsv(assembleUmsatzReport(AGG, USTE, FULL, META));
        await it('has a header, one line per row, and a matching total', async () => {
            const lines = csv.trimEnd().split('\n');
            expect(lines[0]).toBe('Datum;Beleg;Gegenpartei;Netto;USt;Brutto;Satz');
            expect(csv).toContain('33.558,02'); // the Bemessungsgrundlage
            expect(csv).toContain('15.06.2023;RE-2023-001;Kunde A;10.000,00');
        });
    });

    await describe('toUmsatzPdfModel', async () => {
        await it('formats totals and carries the Bemessungsgrundlage into the meta block', async () => {
            const model = toUmsatzPdfModel(assembleUmsatzReport(AGG, USTE, FULL, META));
            expect(model.totalNet).toBe('33.558,02');
            expect(model.warning).toBeNull();
            expect(model.meta.some((m) => m.value === '33.558,02 €')).toBe(true);
            expect(model.rows.length).toBe(3);
        });

        await it('surfaces the coverage warning when the year is not fully covered', async () => {
            const partial: UmsatzCoverage = {
                firstDate: '2023-05-31',
                lastDate: '2023-12-28',
                fullYear: false,
                warning: 'Achtung: … 01.01.2023 – 31.05.2023 nicht erfasst.',
            };
            const model = toUmsatzPdfModel(assembleUmsatzReport(AGG, USTE, partial, META));
            expect(model.warning).toContain('nicht erfasst');
        });
    });
};
