import { describe, it, expect } from '@gjsify/unit';
import {
    usteToSteuerblatt,
    euerToSteuerblatt,
    gewstToSteuerblatt,
    ustvaToSteuerblatt,
} from '../../../src/core/actions/elster/steuerblatt-pdf.ts';
import type { UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';
import type { UstvaAggregate } from '../../../src/core/elster/ustva-aggregate.ts';
import type { GewstReport } from '../../../src/core/actions/elster/gewst.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

const elster = {
    tax_number: '11/222/33333',
    taxation_basis: 'ist',
    betrieb: { name: 'Muster & Partner GbR', strasse: 'Musterstraße 12', plz: '12345', ort: 'Musterstadt', art: 'X' },
} as ElsterConfig;

const uste = {
    year: 2025,
    net_19: 15230.53,
    lieferungenSonstLeistungen_19: 15230.53,
    wertabgabeLieferung_19: 0,
    wertabgabeSonstige_19: 0,
    net_7: 0,
    net_0: 0,
    vat_out: 2893.82,
    vat_in: 1852.23,
    vatPayable: 1041.59,
    prepaidVat: 444.57,
    closingBalance: 597.02,
    prepaidVatSource: 'register',
} as UsteAggregate;

const euerAgg = {
    year: 2025,
    basis: 'cash-transactions',
    adjustmentsApplied: true,
    income: [
        {
            category: 'Erlöse 19% USt',
            bucket: 'Umsatzerlöse',
            kz: '112',
            kind: 'income',
            count: 4,
            net: 15230.53,
            vat: 2893.82,
            gross: 18124.35,
        },
    ],
    expenses: [
        {
            category: 'Technikkosten',
            bucket: 'Aufwendungen für Telekommunikation',
            kz: '162',
            kind: 'expense',
            count: 6,
            net: 1000,
            vat: 190,
            gross: 1190,
        },
    ],
    neutral: [
        { category: 'Privatentnahme', bucket: 'Privat', kz: '', kind: 'neutral', count: 2, net: 0, vat: 0, gross: 500 },
    ],
    totals: {
        incomeNet: 15230.53,
        outputVat: 2893.82,
        expenseNet: 1000,
        inputVat: 190,
        profit: 14230.53,
        vatPayable: 2703.82,
        nachtraeglichNet: 0,
    },
    coverage: {
        transactions: 12,
        classifiedByDocument: 9,
        classifiedByRule: 2,
        classifiedByManual: 0,
        unclassified: [{ id: 'tx_x', bookingDate: '2025-06-01', amount: -50 }],
        activeFrom: '2025-01-01',
        activeTo: '2025-12-31',
        outsidePeriod: [],
    },
} as EuerTxAggregate;

const gewst = {
    result: {
        sumHinzurechnungen: 0,
        sumKuerzungen: 0,
        gewerbeertrag: 2300,
        gewerbeertragRounded: 2300,
        freibetrag: 24500,
        bemessungsgrundlage: 0,
        steuermesszahl: 0.035,
        messbetrag: 0,
        gewerbesteuer: 0,
    },
    euer: euerAgg,
} as GewstReport;

const gewstElster = { ...elster, gewerbe: { gemeinde: 'Musterstadt', hebesatz: 480 } } as ElsterConfig;

const ustvaAgg = {
    net_19: 1000,
    net_7: 200,
    vat_out: 204,
    vat_in: 50,
    outgoing_count: 2,
    incoming_count: 1,
} as UstvaAggregate;

const ustvaConfigQ2 = { ...elster, period: { year: 2025, quarter: 2 } } as ElsterConfig;

export default async () => {
    await describe('usteToSteuerblatt', async () => {
        const model = usteToSteuerblatt(uste, elster);

        await it('builds a titled review datasheet with the entity meta', async () => {
            expect(model.title).toBe('Umsatzsteuer-Jahreserklärung 2025 — Prüf-Datenblatt');
            expect(model.subtitle).toContain('Ist-Versteuerung');
            expect(model.meta.some((m) => m.value === 'Muster & Partner GbR')).toBe(true);
        });

        await it('derives the tax from the rounded-down BMG and flags the register Vorauszahlungssoll', async () => {
            const rows = model.sections[0].rows;
            // Z22 carries the BMG rounded DOWN to full euro in the label + the tax derived from it.
            const z22 = rows.find((r) => r.label.startsWith('Z22'));
            expect(z22?.label).toContain('BMG 15.230 €');
            expect(z22?.value).toBe('2.893,70 €'); // 15.230 × 19 %, NOT the per-receipt 2.893,82
            // Vorauszahlungssoll flagged as the register value, not the FA's authoritative Soll (Gap 4).
            expect(
                rows.some((r) => r.label.includes('Vorauszahlungssoll') && r.label.includes('nicht amtl. Soll')),
            ).toBe(true);
            const abschluss = rows.find((r) => r.label.startsWith('Z120 = Abschlusszahlung'));
            expect(abschluss?.value).toBe('596,90 €'); // 2.893,70 − 1.852,23 − 444,57 (form logic)
            expect(abschluss?.emphasis).toBe(true);
        });

        await it('warns that the Vorauszahlungssoll is not the Finanzamt Soll', async () => {
            expect(model.warnings.some((w) => w.includes('nicht das amtliche Soll'))).toBe(true);
        });
    });

    await describe('euerToSteuerblatt', async () => {
        const model = euerToSteuerblatt(euerAgg, elster);

        await it('titles the EÜR datasheet and carries the entity meta', async () => {
            expect(model.title).toBe('Anlage EÜR 2025 — Prüf-Datenblatt');
            expect(model.meta.some((m) => m.value === 'Muster & Partner GbR')).toBe(true);
        });

        await it('emphasises the profit and the income/expense sums', async () => {
            const einnahmen = model.sections.find((s) => s.heading.startsWith('Betriebseinnahmen'));
            expect(einnahmen?.rows.find((r) => r.label === 'Summe Einnahmen netto')?.emphasis).toBe(true);
            const ergebnis = model.sections.find((s) => s.heading === 'Ergebnis');
            const gewinn = ergebnis?.rows.find((r) => r.label.startsWith('Gewinn'));
            expect(gewinn?.value).toBe('14.230,53 €');
            expect(gewinn?.emphasis).toBe(true);
        });

        await it('shows the neutral section and the Kennzahlen, and warns on unclassified bookings', async () => {
            expect(model.sections.some((s) => s.heading.startsWith('Neutral'))).toBe(true);
            const kennzahlen = model.sections.find((s) => s.heading.startsWith('Anlage-EÜR Kennzahlen'));
            expect(kennzahlen?.rows.some((r) => r.label.includes('Kz 112'))).toBe(true);
            expect(model.warnings.some((w) => w.includes('unklassifizierte Buchung'))).toBe(true);
        });
    });

    await describe('gewstToSteuerblatt', async () => {
        const model = gewstToSteuerblatt(gewst, gewstElster, 2025);

        await it('titles the GewSt datasheet and carries the Gemeinde meta', async () => {
            expect(model.title).toBe('Gewerbesteuer 2025 — Prüf-Datenblatt');
            expect(model.meta.some((m) => m.label === 'Gemeinde' && m.value === 'Musterstadt')).toBe(true);
        });

        await it('emphasises the Bemessungsgrundlage and renders the Steuermesszahl as a percentage', async () => {
            const rows = model.sections[0].rows;
            const bmg = rows.find((r) => r.label === '= Bemessungsgrundlage');
            expect(bmg?.value).toBe('0,00 €');
            expect(bmg?.emphasis).toBe(true);
            expect(rows.some((r) => r.label.includes('Steuermesszahl 3,5 %') && r.value === '')).toBe(true);
        });

        await it('warns that a €0 Messbetrag is still filed', async () => {
            expect(model.warnings.some((w) => w.includes('Messbetrag 0 €'))).toBe(true);
        });
    });

    await describe('ustvaToSteuerblatt', async () => {
        const model = ustvaToSteuerblatt(ustvaAgg, ustvaConfigQ2);

        await it('titles with the quarter period and mirrors the Kz 83 payable', async () => {
            expect(model.title).toBe('Umsatzsteuer-Voranmeldung Q2 2025 — Prüf-Datenblatt');
            expect(model.meta.some((m) => m.label === 'Zeitraum' && m.value === 'Q2 2025')).toBe(true);
            const kz83 = model.sections[0].rows.find((r) => r.label.includes('Kz 83'));
            // 19%·1000 + 7%·200 − 50 = 190 + 14 − 50 = 154
            expect(kz83?.value).toBe('154,00 €');
            expect(kz83?.label).toContain('Verbleibende USt-Vorauszahlung');
            expect(kz83?.emphasis).toBe(true);
        });

        await it('labels a month period in German and flips the sign label on a refund', async () => {
            const march = ustvaToSteuerblatt({ ...ustvaAgg, vat_in: 500 } as UstvaAggregate, {
                ...elster,
                period: { year: 2025, month: 3 },
            } as ElsterConfig);
            expect(march.title).toContain('März 2025');
            const kz83 = march.sections[0].rows.find((r) => r.label.includes('Kz 83'));
            // 190 + 14 − 500 = −296 → Überschuss, shown as absolute
            expect(kz83?.label).toContain('Verbleibender Überschuss');
            expect(kz83?.value).toBe('296,00 €');
        });

        await it('warns about foreign-currency documents without a BMF rate', async () => {
            const withGap = ustvaToSteuerblatt(ustvaAgg, ustvaConfigQ2, {
                missingBmfRates: [{ id: 42, currency: 'USD', month: '2025-05' }],
            });
            expect(withGap.warnings.some((w) => w.includes('Fremdwährungsbeleg'))).toBe(true);
        });
    });
};
