import { describe, it, expect } from '@gjsify/unit';
import {
    evaluateCrossChecks,
    checkUstvaVsUste,
    checkSteuerkontoVsUst,
    checkEuerVsFeststellung,
    checkUstVerprobung,
    checkEuerVsEst,
    type CrossCheckInputs,
    type CrossCheckResult,
} from '../../../src/core/actions/elster/cross-checks.ts';
import type { EuerTxAggregate } from '../../../src/core/elster/euer-transactions.ts';
import type { UsteAggregate } from '../../../src/core/elster/uste-aggregate.ts';
import type { UstvaYearQuarter } from '../../../src/core/elster/ustva-aggregate.ts';
import type { SteuerkontoReport, SteuerGroup } from '../../../src/core/actions/elster/steuerkonto.ts';

// ── fixture builders ────────────────────────────────────────────────────
function euerFixture(profit: number, unclassified = 0): EuerTxAggregate {
    return {
        year: 2025,
        basis: 'cash-transactions',
        adjustmentsApplied: true,
        income: [],
        expenses: [],
        neutral: [],
        totals: {
            incomeNet: 0,
            outputVat: 0,
            expenseNet: 0,
            inputVat: 0,
            profit,
            vatPayable: 0,
            nachtraeglichNet: 0,
        },
        coverage: {
            transactions: 10,
            classifiedByDocument: 6,
            classifiedByRule: 4,
            classifiedByManual: 0,
            unclassified: Array.from({ length: unclassified }, (_, i) => ({
                id: `u${i}`,
                bookingDate: '2025-06-01',
                amount: -10,
            })),
            activeFrom: '2025-01-01',
            activeTo: '2025-12-31',
            outsidePeriod: [],
        },
    };
}

function usteFixture(o: Partial<UsteAggregate>): UsteAggregate {
    return {
        year: 2025,
        net_19: 1000,
        lieferungenSonstLeistungen_19: 1000.0,
        wertabgabeLieferung_19: 0,
        wertabgabeSonstige_19: 0,
        net_7: 0,
        net_0: 0,
        vat_out: 190,
        vat_in: 40,
        vatPayable: 150,
        prepaidVat: 150,
        closingBalance: 0,
        ...o,
    };
}

/**
 * `vatInTotal` is the Vorsteuer the belegbasierte quarters managed to reconstruct, spread over
 * them. It defaults to the annual `vat_in` of {@link usteFixture} so the default fixture models a
 * COMPLETE document basis — otherwise every fixture would look like the partial-coverage case and
 * mask the genuine drifts these tests are about. Pass a smaller total to model missing documents.
 */
function quarters(zahllasten: number[], vatInTotal = 40): UstvaYearQuarter[] {
    return zahllasten.map((zahllast, i) => ({
        quarter: i + 1,
        aggregate: {
            net_19: 0,
            net_7: 0,
            vat_out: 0,
            vat_in: i === 0 ? vatInTotal : 0,
            outgoing_count: 0,
            incoming_count: 0,
        },
        zahllast,
        outgoing: [],
        incoming: [],
        missingBmfRates: [],
    }));
}

function steuerkonto(ustGroups: Array<{ gezahlt: number; erstattet: number }>): SteuerkontoReport {
    const groups: SteuerGroup[] = ustGroups.map((g) => ({
        entity: 'GbR',
        art: 'USt',
        gezahlt: g.gezahlt,
        erstattet: g.erstattet,
        netto: g.erstattet - g.gezahlt,
        items: [],
    }));
    return { year: 2025, groups, entities: {}, internalReserve: { count: 0, out: 0 } };
}

const byId = (results: CrossCheckResult[], id: string): CrossCheckResult => {
    const r = results.find((x) => x.id === id);
    if (!r) throw new Error(`no cross-check with id ${id}`);
    return r;
};

// A fully reconciling business (GbR) fixture.
const reconciling: CrossCheckInputs = {
    year: 2025,
    entityLabel: 'gbr',
    hasUst: true,
    hasFeststellung: true,
    euer: euerFixture(2000, 0),
    uste: usteFixture({}),
    ustvaQuarters: quarters([40, 40, 40, 30]), // Σ 150 = prepaidVat
    steuerkonto: steuerkonto([{ gezahlt: 150, erstattet: 0 }]),
    feststellungProfit: 2000,
};

export default async () => {
    await describe('evaluateCrossChecks — reconciling case', async () => {
        const results = evaluateCrossChecks(reconciling);

        await it('produces one result per check id', async () => {
            expect(results.map((r) => r.id).sort()).toStrictEqual(
                [
                    'euer-vs-est',
                    'euer-vs-feststellung',
                    'steuerkonto-vs-ust',
                    'ust-verprobung',
                    'ustva-vs-uste',
                    'vollstaendigkeit',
                    'vorjahresvergleich',
                ].sort(),
            );
        });

        await it('register Σ declared USt-VA reconciles to the computed Σ quarters (ok, Δ 0)', async () => {
            const r = byId(results, 'ustva-vs-uste');
            expect(r.status).toBe('ok');
            expect(r.expected).toBe(150); // Σ berechnete Quartals-Zahllast (40+40+40+30)
            expect(r.actual).toBe(150); // register Σ declared (= prepaidVat)
            expect(r.delta).toBe(0);
        });

        await it('Steuerkonto USt payment matches the declared USt (ok, Δ 0)', async () => {
            const r = byId(results, 'steuerkonto-vs-ust');
            expect(r.status).toBe('ok');
            expect(r.expected).toBe(150);
            expect(r.actual).toBe(150);
            expect(r.delta).toBe(0);
        });

        await it('EÜR-Gewinn equals the Feststellung laufender Gewinn (ok)', async () => {
            const r = byId(results, 'euer-vs-feststellung');
            expect(r.status).toBe('ok');
            expect(r.delta).toBe(0);
        });

        await it('completeness ok when there are no unclassified bookings', async () => {
            const r = byId(results, 'vollstaendigkeit');
            expect(r.status).toBe('ok');
            expect(r.actual).toBe(0);
        });

        await it('USt-Verprobung ok when declared VAT matches 19 %/7 % of the net (Δ 0)', async () => {
            const r = byId(results, 'ust-verprobung');
            expect(r.status).toBe('ok');
            expect(r.expected).toBe(190);
            expect(r.actual).toBe(190);
            expect(r.delta).toBe(0);
        });

        await it('Vorjahresvergleich is an info placeholder (follow-up)', async () => {
            expect(byId(results, 'vorjahresvergleich').status).toBe('info');
        });
    });

    await describe('evaluateCrossChecks — injected mismatches', async () => {
        await it('flags a register-Soll ↔ computed-quarters drift as error with the correct delta', async () => {
            // Quarters sum to 130 (computed) but the register declared 150 ⇒ Δ = 150 − 130 = 20.
            const r = checkUstvaVsUste({ ...reconciling, ustvaQuarters: quarters([40, 40, 30, 20]) });
            expect(r.status).toBe('error');
            expect(r.expected).toBe(130); // Σ berechnete Quartale
            expect(r.actual).toBe(150); // Σ angemeldet (Register)
            expect(r.delta).toBe(20);
        });

        await it('flags the Säumniszuschlag-in-Soll bug: 444,57 € recorded vs 440,57 € computed (warn, Δ +4,00)', async () => {
            // The concrete GbR 2025-Q4 case: the payment (Zahllast 440,57 + 4,00 Säumniszuschlag)
            // was recorded as the Soll. The register then declares 444,57 while the independent
            // Paperless-driven quarters recompute to 440,57 → the check surfaces the 4,00 € Nebenleistung.
            const computed = checkUstvaVsUste({
                ...reconciling,
                uste: usteFixture({ prepaidVat: 444.57 }),
                ustvaQuarters: quarters([110, 110, 110, 110.57]), // Σ 440,57
            });
            expect(computed.status).toBe('warn');
            expect(computed.expected).toBe(440.57); // computed Σ quarters
            expect(computed.actual).toBe(444.57); // register Σ declared (the wrong Soll)
            expect(computed.delta).toBe(4);
            expect(computed.detail).toContain('Säumniszuschlag');

            // With the corrected declared Soll (440,57) the check reconciles cleanly.
            const fixed = checkUstvaVsUste({
                ...reconciling,
                uste: usteFixture({ prepaidVat: 440.57 }),
                ustvaQuarters: quarters([110, 110, 110, 110.57]),
            });
            expect(fixed.status).toBe('ok');
            expect(fixed.delta).toBe(0);
        });

        await it('downgrades the drift to warn when the belegbasierte Quartalsseite is incomplete', async () => {
            // The gbr-2025 shape: the quarters are Paperless-driven and reconstruct only a sliver
            // of the year's Vorsteuer (5 of 40), so their Σ Zahllast is systematically too high.
            // The register is then NOT proven wrong — and an 'error' here hard-blocks submission of
            // an unrelated, provably consistent return, which is what happened to the Anlage EÜR.
            const starved = checkUstvaVsUste({ ...reconciling, ustvaQuarters: quarters([40, 40, 30, 20], 5) });
            expect(starved.status).toBe('warn');
            // The numbers are still reported unchanged — the finding is surfaced, not suppressed.
            expect(starved.expected).toBe(130);
            expect(starved.actual).toBe(150);
            expect(starved.delta).toBe(20);
            expect(starved.detail).toContain('belegbasiert');
            expect(starved.detail).toContain('Steuerkonto');

            // Discriminator: the SAME drift with a complete document basis stays a hard error,
            // so this downgrade cannot swallow a real register defect.
            const complete = checkUstvaVsUste({ ...reconciling, ustvaQuarters: quarters([40, 40, 30, 20]) });
            expect(complete.status).toBe('error');
            expect(complete.detail).not.toContain('belegbasiert');
        });

        await it('keeps a clean reconciliation clean even when the Beleglage is thin', async () => {
            // No drift ⇒ nothing to downgrade; the partial basis must not turn 'ok' into a warning.
            const r = checkUstvaVsUste({ ...reconciling, ustvaQuarters: quarters([40, 40, 40, 30], 5) });
            expect(r.status).toBe('ok');
            expect(r.delta).toBe(0);
        });

        await it('flags an EÜR ↔ Feststellung mismatch as error with the delta', async () => {
            const r = checkEuerVsFeststellung({ ...reconciling, feststellungProfit: 1900 });
            expect(r.status).toBe('error');
            expect(r.expected).toBe(2000);
            expect(r.actual).toBe(1900);
            expect(r.delta).toBe(-100);
        });

        await it('errors on any unclassified bookings (they falsify every figure)', async () => {
            const r = evaluateCrossChecks({ ...reconciling, euer: euerFixture(2000, 3) });
            const v = byId(r, 'vollstaendigkeit');
            expect(v.status).toBe('error');
            expect(v.actual).toBe(3);
        });

        await it('only warns (not errors) on unclassified bookings for a config-driven privat ESt', async () => {
            // A pure Arbeitnehmer-ESt is config-driven → private-account bookings do not distort it.
            const r = evaluateCrossChecks({ ...reconciling, filesEuer: false, euer: euerFixture(2000, 42) });
            const v = byId(r, 'vollstaendigkeit');
            expect(v.status).toBe('warn');
            expect(v.actual).toBe(42);
            expect(v.detail).toContain('§ 35a');
        });

        await it('warns on a USt-Verprobung drift beyond 1 €', async () => {
            const r = checkUstVerprobung({ ...reconciling, uste: usteFixture({ vat_out: 200 }) });
            expect(r.status).toBe('warn');
            expect(r.expected).toBe(190);
            expect(r.actual).toBe(200);
            expect(r.delta).toBe(10);
        });

        await it('warns when USt is declared but the Steuerkonto shows no payment', async () => {
            const r = checkSteuerkontoVsUst({ ...reconciling, steuerkonto: steuerkonto([]) });
            expect(r.status).toBe('warn');
            expect(r.expected).toBe(150);
            expect(r.actual).toBe(0);
        });
    });

    await describe('evaluateCrossChecks — graceful skips', async () => {
        await it('emits info for the USt checks when the entity has no USt (e.g. privat)', async () => {
            const r = evaluateCrossChecks({ ...reconciling, hasUst: false });
            expect(byId(r, 'ustva-vs-uste').status).toBe('info');
            expect(byId(r, 'steuerkonto-vs-ust').status).toBe('info');
            expect(byId(r, 'ust-verprobung').status).toBe('info');
        });

        await it('emits info for the Feststellung check when no GbR applies', async () => {
            const r = evaluateCrossChecks({ ...reconciling, hasFeststellung: false });
            expect(byId(r, 'euer-vs-feststellung').status).toBe('info');
        });

        await it('surfaces the skip reason in the info detail when a report threw', async () => {
            const r = checkUstvaVsUste({ ...reconciling, uste: undefined, skips: { uste: 'boom' } });
            expect(r.status).toBe('info');
            expect(r.detail).toContain('boom');
        });
    });

    /**
     * The ESt's Einkünfte aus Gewerbebetrieb is a hand-kept COPY of the EÜR profit, and it went
     * stale for real: the 2025 ESt was filed on 28.07.2026 with 811,53 € while the Anlage EÜR for
     * the same year computes 837,56 €. Two filings to the same Finanzamt, 26,03 € apart, and no
     * check compared them.
     */
    await describe('checkEuerVsEst', async () => {
        const withEst = (profit: number, declared: number, abgegeben = false): CrossCheckInputs => ({
            ...reconciling,
            entityLabel: 'jumplink',
            euer: euerFixture(profit, 0),
            estGewerbe: { profil: 'privat', betrag: declared, abgegeben },
        });

        await it('blocks an ESt that has NOT gone out yet', async () => {
            const r = checkEuerVsEst(withEst(837.56, 811.53));
            expect(r.status).toBe('error');
            expect(r.expected).toBe(837.56);
            expect(r.actual).toBe(811.53);
            expect(r.delta).toBe(-26.03);
            expect(r.detail.includes('Vor der Abgabe')).toBe(true);
        });

        await it('warns instead of blocking once that ESt is transmitted', async () => {
            // The live situation: the ESt went out on 28.07.2026 with the stale figure. An error
            // here would block the sign-off gate of the Anlage EÜR — the CORRECT form, with a
            // running deadline. Holding it back fixes nothing and misses a second deadline.
            const r = checkEuerVsEst(withEst(837.56, 811.53, true));
            expect(r.status).toBe('warn');
            expect(r.delta).toBe(-26.03);
            expect(r.detail.includes('§153 AO')).toBe(true);
        });

        await it('is ok when the copy matches', async () => {
            expect(checkEuerVsEst(withEst(837.56, 837.56)).status).toBe('ok');
        });

        await it('tolerates rounding below a euro', async () => {
            // The ESt XML carries whole euros, so a sub-euro gap is the format, not a defect.
            expect(checkEuerVsEst(withEst(837.56, 838)).status).toBe('ok');
        });

        await it('says the link is missing rather than guessing which Betrieb', async () => {
            const r = checkEuerVsEst({ ...reconciling, entityLabel: 'jumplink', euer: euerFixture(837.56, 0) });
            expect(r.status).toBe('info');
            expect(r.detail.includes('einkuenfte_gewerbe_quelle')).toBe(true);
        });

        await it('skips for an entity without an EÜR', async () => {
            const r = checkEuerVsEst({
                ...reconciling,
                filesEuer: false,
                estGewerbe: { profil: 'privat', betrag: 1, abgegeben: false },
            });
            expect(r.status).toBe('info');
        });

        await it('is part of the standard run', async () => {
            const r = byId(evaluateCrossChecks(withEst(837.56, 811.53)), 'euer-vs-est');
            expect(r.status).toBe('error');
        });

        await it('stays ok when it matches, transmitted or not', async () => {
            expect(checkEuerVsEst(withEst(837.56, 837.56, true)).status).toBe('ok');
        });
    });
};
