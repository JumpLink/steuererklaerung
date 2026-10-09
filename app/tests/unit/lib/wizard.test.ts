import { describe, it, expect } from '@gjsify/unit';
import { assembleTaxReturnPlan, type TaxReturnPlanInputs } from '../../../src/core/actions/elster/wizard.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';
import type { UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';
import type { GewstReport } from '../../../src/core/actions/elster/gewst.ts';
import type { FeststellungReport } from '../../../src/core/actions/elster/feststellung.ts';

function euer(over: Partial<EuerTxAggregate> = {}): EuerTxAggregate {
    return {
        year: 2025,
        basis: 'cash-transactions',
        adjustmentsApplied: true,
        income: [],
        expenses: [],
        neutral: [],
        totals: {
            incomeNet: 15230.53,
            outputVat: 2893.82,
            expenseNet: 12380.13,
            inputVat: 1852.23,
            profit: 2850.4,
            vatPayable: 1041.59,
            nachtraeglichNet: 0,
        },
        coverage: {
            transactions: 369,
            classifiedByDocument: 52,
            classifiedByRule: 317,
            classifiedByManual: 0,
            unclassified: [],
            activeFrom: '2025-01-01',
            activeTo: '2025-10-31',
            outsidePeriod: [],
        },
        ...over,
    };
}

function uste(over: Partial<UsteAggregate> = {}): UsteAggregate {
    return {
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
        ...over,
    };
}

function inputs(over: Partial<TaxReturnPlanInputs> = {}): TaxReturnPlanInputs {
    return {
        entityId: 'artcode',
        year: 2025,
        euer: euer(),
        uste: uste(),
        gewst: null,
        feststellung: null,
        hasBetrieb: true,
        betriebsaufgabeSchaetzung: false,
        ...over,
    };
}

const gewstFixture: GewstReport = {
    result: {
        sumHinzurechnungen: 0,
        sumKuerzungen: 0,
        gewerbeertrag: 2074.8,
        gewerbeertragRounded: 2000,
        freibetrag: 24500,
        bemessungsgrundlage: 0,
        steuermesszahl: 0.035,
        messbetrag: 0,
        gewerbesteuer: 0,
    },
    euer: euer(),
};

const feststellungFixture: FeststellungReport = {
    result: {
        year: 2025,
        totalProfit: 2850.4,
        festgestellteEinkuenfte: 1590.4,
        aufgabegewinn: 0,
        einkuenfteGesamt: 1590.4,
        allocations: [
            {
                gesellschafter: { id: 'partner2', name: 'Max Mustermann', steuerId: '12345678901', quote: 0.5 },
                laufenderAnteil: 1425.2,
                sonderbetriebsausgaben: 630,
                profitShare: 795.2,
                aufgabegewinnAnteil: 0,
                gesamtAnteil: 795.2,
            },
        ],
        rounding: { rawSum: 2850.4, residual: 0 },
    },
    euer: euer(),
};

export default async () => {
    await describe('assembleTaxReturnPlan', async () => {
        await it('is abgabebereit when classified + adjusted + betrieb present', async () => {
            const plan = assembleTaxReturnPlan(inputs());
            expect(plan.ready).toBe(true);
            expect(plan.steps.length).toBe(5);
            expect(plan.steps.find((s) => s.id === 'vollstaendigkeit')?.status).toBe('ok');
            // EÜR + USt-Jahr only (no gewerbe/gesellschafter given).
            expect(plan.forms.map((f) => f.form).join(',')).toBe('euer,uste');
            expect(plan.forms.every((f) => f.canExport)).toBe(true);
        });

        await it('exposes the monetary summary hero (USt closing balance + key figures)', async () => {
            const plan = assembleTaxReturnPlan(inputs({ gewst: gewstFixture, feststellung: feststellungFixture }));
            expect(plan.summary?.primary.kind).toBe('payment'); // closingBalance 597,02 ≥ 0 → Nachzahlung
            expect(plan.summary?.primary.amount).toBe(597.02);
            expect(plan.summary?.primary.label).toBe('Voraussichtliche Nachzahlung');
            const labels = (plan.summary?.secondary ?? []).map((l) => l.label);
            expect(labels.join(',')).toBe('Gewinn (EÜR),USt-Zahllast,GewSt-Messbetrag,Festgestellte Einkünfte');
            expect(plan.summary?.secondary.find((l) => l.label === 'USt-Zahllast')?.amount).toBe(euer().totals.vatPayable);
        });

        await it('flips the summary to a refund when the USt closing balance is negative', async () => {
            const plan = assembleTaxReturnPlan(inputs({ uste: uste({ closingBalance: -120 }) }));
            expect(plan.summary?.primary.kind).toBe('refund');
            expect(plan.summary?.primary.amount).toBe(120);
            expect(plan.summary?.primary.label).toBe('Voraussichtliche Erstattung');
        });

        await it('deep-links open steps to where they are fixed (Buchungen / Einstellungen)', async () => {
            // Unclassified bookings → the Vollständigkeit step points at the Buchungen view.
            const blockedPlan = assembleTaxReturnPlan(
                inputs({
                    euer: euer({
                        coverage: {
                            transactions: 10,
                            classifiedByDocument: 2,
                            classifiedByRule: 7,
                            classifiedByManual: 0,
                            unclassified: [{ id: 'x', bookingDate: '2025-05-01', amount: -42 }],
                            activeFrom: '2025-01-01',
                            activeTo: '2025-12-31',
                            outsidePeriod: [],
                        },
                    }),
                }),
            );
            expect(
                blockedPlan.steps.find((s) => s.id === 'vollstaendigkeit')?.actions?.map((a) => a.view).join(','),
            ).toBe('transactions');
            // No betrieb → the Formulare step points at the Einstellungen (ELSTER config) view.
            const noBetrieb = assembleTaxReturnPlan(inputs({ hasBetrieb: false }));
            expect(noBetrieb.steps.find((s) => s.id === 'formulare')?.actions?.map((a) => a.view).join(',')).toBe(
                'settings',
            );
            // A clean plan carries no deep-link on the (ok) Vollständigkeit step.
            expect(assembleTaxReturnPlan(inputs()).steps.find((s) => s.id === 'vollstaendigkeit')?.actions).toBe(
                undefined,
            );
        });

        await it('blocks on unclassified bookings', async () => {
            const plan = assembleTaxReturnPlan(
                inputs({
                    euer: euer({
                        coverage: {
                            transactions: 10,
                            classifiedByDocument: 2,
                            classifiedByRule: 7,
                            classifiedByManual: 0,
                            unclassified: [{ id: 'x', bookingDate: '2025-05-01', amount: -42 }],
                            activeFrom: '2025-01-01',
                            activeTo: '2025-12-31',
                            outsidePeriod: [],
                        },
                    }),
                }),
            );
            expect(plan.steps.find((s) => s.id === 'vollstaendigkeit')?.status).toBe('blocked');
            expect(plan.ready).toBe(false);
        });

        await it('blocks when the year-end adjustments were not applied (no ELSTER config)', async () => {
            const plan = assembleTaxReturnPlan(inputs({ euer: euer({ adjustmentsApplied: false }) }));
            expect(plan.steps.find((s) => s.id === 'vollstaendigkeit')?.status).toBe('blocked');
            expect(plan.ready).toBe(false);
        });

        await it('blocks export (and readiness) when there is no betrieb', async () => {
            const plan = assembleTaxReturnPlan(inputs({ hasBetrieb: false }));
            expect(plan.forms.every((f) => !f.canExport)).toBe(true);
            expect(plan.steps.find((s) => s.id === 'formulare')?.status).toBe('blocked');
            expect(plan.ready).toBe(false);
        });

        await it('warns (but stays ready) when a Betriebsaufgabe estimate is configured', async () => {
            const plan = assembleTaxReturnPlan(inputs({ betriebsaufgabeSchaetzung: true }));
            expect(plan.steps.find((s) => s.id === 'anpassungen')?.status).toBe('warn');
            expect(plan.steps.find((s) => s.id === 'pruefung')?.status).toBe('warn');
            expect(plan.ready).toBe(true);
        });

        await it('adds GewSt + Feststellung previews with partner names but NOT their Steuer-IdNr', async () => {
            const plan = assembleTaxReturnPlan(inputs({ gewst: gewstFixture, feststellung: feststellungFixture }));
            expect(plan.forms.map((f) => f.form).join(',')).toBe('euer,uste,gewst,feststellung');
            const fest = plan.forms.find((f) => f.form === 'feststellung');
            expect(fest?.figures.some((r) => r.label === 'Max Mustermann')).toBe(true);
            // Privacy: the partner's Steuer-IdNr must never leak into a preview figure.
            const serialised = JSON.stringify(plan);
            expect(serialised.includes('12345678901')).toBe(false);
        });
    });
};
