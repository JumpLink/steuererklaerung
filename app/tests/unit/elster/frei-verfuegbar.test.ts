import { describe, it, expect } from '@gjsify/unit';
import {
    computeFreiVerfuegbar,
    FAELLIG_FENSTER_TAGE,
    ustZeitraum,
    type FreiVerfuegbarInput,
    type UstVaStand,
} from '../../../src/core/elster/frei-verfuegbar.ts';
import { computeOffeneSteuerzahlungen } from '../../../src/core/elster/steuerzahlungen.ts';
import type { Filing } from '@steuererklaerung/store';

// Invented figures only. Stichtag Thursday 8 Oct 2026.
const TODAY = '2026-10-08';
const AT = '2026-10-01T10:00:00.000Z';

function filing(over: Partial<Filing>): Filing {
    return {
        entityId: 'firma',
        kind: 'ustva',
        period: '2026-Q2',
        filedAt: '2026-07-09',
        paidAt: null,
        amount: null,
        declaredAmount: 100,
        surcharge: null,
        assessedAmount: null,
        assessedAt: null,
        note: null,
        createdAt: AT,
        updatedAt: AT,
        ...over,
    };
}

const SELF = [{ ids: ['firma'], entityId: 'firma', entityName: 'Muster GmbH', dauerfrist: false }];

const QUARTAL: UstVaStand = { cadence: 'quarter', dauerfrist: false, eingereicht: [] };

/** A complete input; override any part. */
function input(over: Partial<FreiVerfuegbarInput> = {}): FreiVerfuegbarInput {
    const zahlungen = computeOffeneSteuerzahlungen(
        [
            filing({ period: '2026-Q2', declaredAmount: 200 }), // due 10 Jul → overdue
            filing({ kind: 'ust-jahr', period: '2025', filedAt: '2026-09-20', declaredAmount: 50 }), // due 20 Oct → in window
            filing({ kind: 'ust-jahr', period: '2024', filedAt: '2026-10-07', declaredAmount: 70 }), // due 9 Nov → outside
            filing({ kind: 'gewst', period: '2025', declaredAmount: 30 }), // per Bescheid → no date
        ],
        SELF,
        TODAY,
    );
    return {
        stichtag: TODAY,
        entityId: 'firma',
        entityName: 'Muster GmbH',
        konten: [
            { name: 'Geschäftskonto', accountKey: 'qonto:a', saldo: 5000, letzteBuchung: '2026-10-01' },
            { name: 'PayPal', accountKey: 'paypal:a', saldo: 250.5, letzteBuchung: '2026-09-12' },
        ],
        ust: {
            status: 'ok',
            daten: {
                ...QUARTAL,
                eingereicht: [
                    { period: '2026-Q1', filedAt: '2026-04-09' },
                    { period: '2026-Q2', filedAt: '2026-07-09' },
                ],
                buchungen: {
                    status: 'ok',
                    daten: [
                        { bookingDate: '2026-06-30', kind: 'income', vat: 999 }, // before the window
                        { bookingDate: '2026-07-15', kind: 'income', vat: 190 },
                        { bookingDate: '2026-09-01', kind: 'expense', vat: 38 },
                        { bookingDate: '2026-09-02', kind: 'neutral', vat: 0 },
                        { bookingDate: '2026-10-09', kind: 'income', vat: 500 }, // after the Stichtag
                    ],
                },
            },
        },
        steuerzahlungen: { status: 'ok', daten: zahlungen },
        eingangsrechnungen: {
            status: 'ok',
            daten: {
                regel: 'Test: offen = ohne Zahlung',
                posten: [
                    { id: '1', label: 'Lieferant A', betrag: 119, dueDate: '2026-10-20' },
                    { id: '2', label: 'Lieferant B', betrag: 23.8, dueDate: null },
                ],
            },
        },
        ruecklage: {
            jahr: 2026,
            est: { status: 'ok', daten: { soll: 4000, einbehalten: 1000, vorauszahlungen: 1200 } },
            gewst: {
                status: 'ok',
                daten: {
                    gewerbesteuer: 1400,
                    messbetrag: 350,
                    hebesatz: 400,
                    zahlungen: [{ datum: '2026-05-15', betrag: -300, text: 'GewSt-Vorauszahlung II/2026' }],
                },
            },
        },
        ...over,
    };
}

export default async () => {
    await describe('frei-verfuegbar — USt-Zeitraum', async () => {
        await it('starts the day after the newest filed Voranmeldung', async () => {
            const z = ustZeitraum(
                {
                    ...QUARTAL,
                    eingereicht: [
                        { period: '2026-Q1', filedAt: '2026-04-09' },
                        { period: '2026-Q2', filedAt: '2026-07-09' },
                    ],
                },
                TODAY,
            );
            expect(z.von).toBe('2026-07-01');
            expect(z.grund).toContain('Q2/2026');
        });

        await it('without a filing takes the periods whose deadline still runs — and says so', async () => {
            const q = ustZeitraum(QUARTAL, TODAY);
            // Q3 is due 10 Oct (a Saturday → 12 Oct), still running; Q2's deadline passed in July.
            expect(q.von).toBe('2026-07-01');
            expect(q.grund).toContain('Keine eingereichte Voranmeldung');
            // Monthly with Dauerfrist: August is due 10 Oct (→ 12 Oct), July's deadline (10 Sep) passed.
            expect(ustZeitraum({ cadence: 'month', dauerfrist: true, eingereicht: [] }, TODAY).von).toBe('2026-08-01');
        });

        await it('falls back to the start of the year without Voranmeldungen, never before the business began', async () => {
            expect(ustZeitraum({ cadence: null, dauerfrist: false, eingereicht: [] }, TODAY).von).toBe('2026-01-01');
            expect(ustZeitraum({ ...QUARTAL, businessStart: '2026-08-15' }, TODAY).von).toBe('2026-08-15');
        });
    });

    await describe('frei-verfuegbar — terms', async () => {
        const m = computeFreiVerfuegbar(input());
        const term = (key: string) => m.freiVerfuegbar.terme.find((t) => t.key === key)!;

        await it('sums the balance of every own account', async () => {
            expect(term('kontostand').betrag).toBe(5250.5);
            expect(term('kontostand').zeilen.length).toBe(3); // two accounts + the completeness caveat
        });

        await it('counts USt minus Vorsteuer only between the last VA and the Stichtag', async () => {
            expect(term('ust-seit-va').betrag).toBe(152);
            expect(term('ust-seit-va').zeilen[0].label).toBe('Zeitraum 01.07.2026 bis 08.10.2026');
        });

        await it(`deducts overdue, undated and ${FAELLIG_FENSTER_TAGE}-day payments, lists the later one without deducting`, async () => {
            const t = term('steuerzahlungen-faellig');
            expect(t.betrag).toBe(280); // 200 overdue + 50 in 12 days + 30 per Bescheid; 70 in 32 days stays out
            const later = t.zeilen.find((z) => z.label.includes('2024'))!;
            expect(later.betrag).toBeNull();
            expect(later.herkunft).toContain('nicht abgezogen');
            expect(t.zeilen.find((z) => z.label.includes('Q2/2026'))!.herkunft).toContain('überfällig');
            expect(t.zeilen.find((z) => z.label.includes('Gewerbesteuer'))!.herkunft).toContain('vorsichtshalber');
        });

        await it('deducts the gross amounts of open incoming invoices', async () => {
            expect(term('offene-eingangsrechnungen').betrag).toBe(142.8);
        });

        await it('combines the terms into Frei verfügbar', async () => {
            expect(m.freiVerfuegbar.betrag).toBe(4675.7); // 5250,50 − 152 − 280 − 142,80
            expect(m.freiVerfuegbar.vollstaendig).toBe(true);
            expect(m.freiVerfuegbar.hinweis).toContain('keine Empfehlung');
        });

        await it('computes the Steuerrücklage as estimate minus prepayments', async () => {
            const r = m.steuerruecklage;
            expect(r.terme.find((t) => t.key === 'est')!.betrag).toBe(1800);
            expect(r.terme.find((t) => t.key === 'gewst')!.betrag).toBe(1100);
            expect(r.betrag).toBe(2900);
            expect(r.erstattung).toBe(false);
            expect(r.label).toContain('Schätzung');
        });
    });

    await describe('frei-verfuegbar — refund and Vorsteuer surplus', async () => {
        await it('shows a refund as a negative Rücklage, never clamped to 0', async () => {
            const m = computeFreiVerfuegbar(
                input({
                    ruecklage: {
                        jahr: 2026,
                        est: { status: 'ok', daten: { soll: 1000, einbehalten: 1500, vorauszahlungen: 0 } },
                        gewst: { status: 'entfaellt', grund: 'kein Gewerbebetrieb hinterlegt ist.' },
                    },
                }),
            );
            expect(m.steuerruecklage.betrag).toBe(-500);
            expect(m.steuerruecklage.erstattung).toBe(true);
            expect(m.steuerruecklage.vollstaendig).toBe(true);
            expect(m.steuerruecklage.terme[0].zeilen.some((z) => z.label.includes('Erstattung'))).toBe(true);
        });

        await it('a Vorsteuer surplus raises the free amount and says why', async () => {
            const base = input();
            const m = computeFreiVerfuegbar(
                input({
                    ust: {
                        status: 'ok',
                        daten: {
                            ...QUARTAL,
                            eingereicht: [{ period: '2026-Q2', filedAt: '2026-07-09' }],
                            buchungen: {
                                status: 'ok',
                                daten: [{ bookingDate: '2026-08-01', kind: 'expense', vat: 95 }],
                            },
                        },
                    },
                }),
            );
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'ust-seit-va')!;
            expect(t.betrag).toBe(-95);
            expect(t.zeilen.some((z) => z.label.startsWith('Vorsteuer-Überhang'))).toBe(true);
            expect(m.freiVerfuegbar.betrag).toBe(round(computeFreiVerfuegbar(base).freiVerfuegbar.betrag! + 152 + 95));
        });
    });

    await describe('frei-verfuegbar — missing data', async () => {
        await it('without any account the result is not computable, not 0', async () => {
            const m = computeFreiVerfuegbar(input({ konten: [] }));
            const k = m.freiVerfuegbar.terme[0];
            expect(k.status).toBe('nicht-berechenbar');
            expect(k.erklaerung.startsWith('Nicht berechenbar, weil')).toBe(true);
            expect(m.freiVerfuegbar.betrag).toBeNull();
            expect(m.freiVerfuegbar.vollstaendig).toBe(false);
        });

        await it('a term without data is named, left out and marks the result incomplete', async () => {
            const m = computeFreiVerfuegbar(
                input({
                    ust: {
                        status: 'ok',
                        daten: {
                            ...QUARTAL,
                            buchungen: { status: 'nicht-berechenbar', grund: 'die Buchungen fehlen.' },
                        },
                    },
                }),
            );
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'ust-seit-va')!;
            expect(t.status).toBe('nicht-berechenbar');
            expect(t.erklaerung).toBe('Nicht berechenbar, weil die Buchungen fehlen.');
            expect(t.zeilen[0].label.startsWith('Zeitraum')).toBe(true); // the window is still shown
            expect(m.freiVerfuegbar.vollstaendig).toBe(false);
            expect(m.freiVerfuegbar.betrag).toBe(4827.7); // 5250,50 − 280 − 142,80, USt left out
        });

        await it('an invoice without amount is listed as not computable', async () => {
            const m = computeFreiVerfuegbar(
                input({
                    eingangsrechnungen: {
                        status: 'ok',
                        daten: {
                            regel: 'Test',
                            posten: [{ id: '9', label: 'Ohne Betrag', betrag: null, dueDate: null }],
                        },
                    },
                }),
            );
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'offene-eingangsrechnungen')!;
            expect(t.status).toBe('teilweise');
            expect(t.zeilen[0].herkunft).toContain('nicht berechenbar');
            expect(m.freiVerfuegbar.vollstaendig).toBe(false);
        });

        await it('a Rücklage without any estimate is not computable; one that does not apply is 0', async () => {
            const fehlt = computeFreiVerfuegbar(
                input({
                    ruecklage: {
                        jahr: 2026,
                        est: { status: 'nicht-berechenbar', grund: 'für 2026 keine ESt-Angaben hinterlegt sind.' },
                        gewst: { status: 'nicht-berechenbar', grund: 'Gemeinde und Hebesatz fehlen.' },
                    },
                }),
            );
            expect(fehlt.steuerruecklage.betrag).toBeNull();
            const entfaellt = computeFreiVerfuegbar(
                input({
                    ruecklage: {
                        jahr: 2026,
                        est: { status: 'entfaellt', grund: 'die Gesellschafter sie zahlen.' },
                        gewst: { status: 'entfaellt', grund: 'kein Gewerbebetrieb hinterlegt ist.' },
                    },
                }),
            );
            expect(entfaellt.steuerruecklage.betrag).toBe(0);
            expect(entfaellt.steuerruecklage.vollstaendig).toBe(true);
        });

        await it('after a Betriebsaufgabe before the window there is no USt left to count', async () => {
            const m = computeFreiVerfuegbar(
                input({
                    ust: {
                        status: 'ok',
                        daten: {
                            ...QUARTAL,
                            eingereicht: [{ period: '2026-Q2', filedAt: '2026-07-09' }],
                            businessEnd: '2026-06-30',
                            buchungen: {
                                status: 'ok',
                                daten: [{ bookingDate: '2026-08-01', kind: 'income', vat: 19 }],
                            },
                        },
                    },
                }),
            );
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'ust-seit-va')!;
            expect(t.betrag).toBe(0);
            expect(t.erklaerung).toContain('keine Geschäftstätigkeit');
        });
    });
};

function round(n: number): number {
    return Math.round(n * 100) / 100;
}
