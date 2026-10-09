import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    aggregateEuerByTransactions,
    beitragsZeilen,
    type TxDocInfo,
} from '../../../src/core/elster/euer-transactions.ts';
import {
    AufteilungFehler,
    BEWIRTUNG_KATEGORIE,
    BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE,
    PRIVAT_KATEGORIE,
    abgabeWarnung,
    aufteilungTitel,
    berechneTeile,
    betroffeneAbgaben,
    bewirtungsTeile,
    doppelzaehlungHinweis,
    hauptTeil,
    restBetrag,
    teilAusText,
    vorsteuerPrivat,
    type TeilEingabe,
} from '../../../src/core/elster/splitbuchung.ts';
import { erbeVonUrsprung, erstattungKandidaten, type ErstattungBuchung } from '../../../src/core/elster/erstattung.ts';
import { herkunftText, istAufteilung, wasGiltDanach } from '../../../src/core/elster/zu-pruefen.ts';
import { loadAufteilungen, loadAufteilungTeile, schreibeAufteilung } from '../../../src/core/actions/aufteilungen.ts';
import { getDecisionLog } from '../../../src/core/actions/classifications.ts';

// All bookings, names and amounts below are invented.
const BUERO = '4930 Bürobedarf';
const SOFTWARE = '4964 Software/Lizenzen';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'tx',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}
const doc = (net: number, vat: number, category = BUERO, documentId = 7): TxDocInfo => ({
    documentId,
    category,
    netEur: net,
    vatEur: vat,
    currency: 'EUR',
});

const fehler = (fn: () => unknown): string => {
    try {
        fn();
    } catch (e) {
        expect(e instanceof AufteilungFehler).toBe(true);
        return (e as Error).message;
    }
    throw new Error('expected an AufteilungFehler');
};

const halbPrivat: TeilEingabe[] = [
    { category: BUERO, betrag: 59.5, vatRate: 0.19 },
    { category: PRIVAT_KATEGORIE, rest: true, vatRate: 0.19 },
];

export default async () => {
    await describe('Splitbuchung: Teile und Rest', async () => {
        await it('gives the remainder to the rest part, to the cent', async () => {
            const t = berechneTeile(-100, [
                { category: BUERO, betrag: 33.33 },
                { category: SOFTWARE, betrag: 33.33 },
                { category: PRIVAT_KATEGORIE },
            ]);
            expect(t.map((p) => p.betrag).join('|')).toBe('33.33|33.33|33.34');
            expect(t[2].rest).toBe(true);
            expect(Math.round(t.reduce((s, p) => s + p.betrag, 0) * 100)).toBe(10000);
            expect(t[0].net).toBe(28.01);
            expect(t[0].vat).toBe(5.32);
            expect(t[2].betrieblich).toBe(false);
        });

        await it('takes the rest part from its flag, wherever it stands', async () => {
            const t = berechneTeile(-50, [
                { category: PRIVAT_KATEGORIE, rest: true },
                { category: BUERO, betrag: 0.01 },
            ]);
            expect(t[0].betrag).toBe(49.99);
            expect(restBetrag(-50, [{ category: BUERO, betrag: 60 }, { category: BUERO }], 1)).toBe(-10);
        });

        await it('accepts all amounts filled in when they add up, and the last part is the rest', async () => {
            const t = berechneTeile(-10, [
                { category: BUERO, betrag: 4 },
                { category: SOFTWARE, betrag: 6 },
            ]);
            expect(t[1].rest).toBe(true);
            expect(
                fehler(() =>
                    berechneTeile(-10, [
                        { category: BUERO, betrag: 4 },
                        { category: SOFTWARE, betrag: 5 },
                    ]),
                ),
            ).toContain('Die Teile ergeben 9,00 €');
        });

        await it('defaults the rate to the receipt, else the category; private parts to 0 without receipt', async () => {
            const mitBeleg = berechneTeile(-107, [{ category: BUERO, betrag: 50 }, { category: PRIVAT_KATEGORIE }], {
                belegSatz: 0.07,
            });
            expect(mitBeleg.map((p) => p.vatRate).join('|')).toBe('0.07|0.07');
            const ohne = berechneTeile(-107, [{ category: BUERO, betrag: 50 }, { category: PRIVAT_KATEGORIE }]);
            expect(ohne.map((p) => p.vatRate).join('|')).toBe('0.19|0');
        });
    });

    await describe('Splitbuchung: Teil als Text (CLI)', async () => {
        await it('reads category, amount and rate, and a part without amount as the rest', async () => {
            expect(JSON.stringify(teilAusText('4930=59,50@19'))).toBe(
                JSON.stringify({ category: BUERO, betrag: 59.5, vatRate: 0.19 }),
            );
            expect(JSON.stringify(teilAusText('1800 Privatentnahme'))).toBe(
                JSON.stringify({ category: PRIVAT_KATEGORIE, rest: true }),
            );
            expect(teilAusText('4964 = 1.234,56').betrag).toBe(1234.56);
            expect(teilAusText('4654 Nicht').category).toBe(BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE);
            expect(fehler(() => teilAusText('4654=10'))).toContain('nicht eindeutig');
            expect(fehler(() => teilAusText('9999=10'))).toContain('keine Kategorie');
            expect(fehler(() => teilAusText('4930=zehn'))).toContain('kein Betrag');
        });
    });

    await describe('Splitbuchung: Prüfung der Eingabe', async () => {
        await it('refuses parts that exceed the booking, zero, a sign, and nothing left', async () => {
            expect(
                fehler(() => berechneTeile(-100, [{ category: BUERO, betrag: 120 }, { category: PRIVAT_KATEGORIE }])),
            ).toContain('nur 100,00 €');
            expect(
                fehler(() => berechneTeile(-100, [{ category: BUERO, betrag: 0 }, { category: PRIVAT_KATEGORIE }])),
            ).toContain('über 0 €');
            expect(
                fehler(() => berechneTeile(-100, [{ category: BUERO, betrag: -5 }, { category: PRIVAT_KATEGORIE }])),
            ).toContain('positiv');
            expect(
                fehler(() => berechneTeile(-100, [{ category: BUERO, betrag: 100 }, { category: PRIVAT_KATEGORIE }])),
            ).toContain('bleibt nichts');
        });

        await it('refuses one part, two rests, cents below a cent, unknown categories and rates', async () => {
            expect(fehler(() => berechneTeile(-100, [{ category: BUERO }]))).toContain('mindestens zwei');
            expect(
                fehler(() =>
                    berechneTeile(-100, [
                        { category: BUERO, rest: true },
                        { category: PRIVAT_KATEGORIE, rest: true },
                    ]),
                ),
            ).toContain('Nur ein Teil');
            expect(fehler(() => berechneTeile(-100, [{ category: BUERO }, { category: PRIVAT_KATEGORIE }]))).toContain(
                'ohne Betrag',
            );
            expect(
                fehler(() => berechneTeile(-100, [{ category: BUERO, betrag: 1.005 }, { category: PRIVAT_KATEGORIE }])),
            ).toContain('Nachkommastellen');
            expect(
                fehler(() =>
                    berechneTeile(-100, [{ category: 'Erfunden', betrag: 1 }, { category: PRIVAT_KATEGORIE }]),
                ),
            ).toContain('keine Kategorie');
            expect(
                fehler(() =>
                    berechneTeile(-100, [
                        { category: BUERO, betrag: 1, vatRate: 0.16 },
                        { category: PRIVAT_KATEGORIE },
                    ]),
                ),
            ).toContain('Steuersatz');
            expect(fehler(() => berechneTeile(0, halbPrivat))).toContain('0 €');
        });

        await it('keeps income and expense apart from the booking direction', async () => {
            expect(
                fehler(() =>
                    berechneTeile(-100, [{ category: '8400 Erlöse 19% USt', betrag: 10 }, { category: BUERO }]),
                ),
            ).toContain('eine Einnahme');
            const gutschrift = berechneTeile(107 + 119, [
                { category: '8400 Erlöse 19% USt', betrag: 119 },
                { category: '8300 Erlöse 7% USt' },
            ]);
            expect(gutschrift.map((p) => `${p.net}/${p.vat}`).join('|')).toBe('100/19|100/7');
        });
    });

    await describe('Splitbuchung: EÜR', async () => {
        const kauf = tx({ id: 'kauf', counterparty: 'Versandhaus Möwe' });
        const anderes = tx({ id: 'abo', amount: -11.9, counterparty: 'Pixelwerk' });
        const docs = new Map([
            ['kauf', doc(100, 19)],
            ['abo', doc(10, 1.9, SOFTWARE, 8)],
        ]);

        await it('books each part under its own category; the private part has no expense and no Vorsteuer', async () => {
            const ohne = aggregateEuerByTransactions([kauf, anderes], docs, 2026, { detail: true });
            const mit = aggregateEuerByTransactions([kauf, anderes], docs, 2026, {
                detail: true,
                aufteilungen: new Map([['kauf', halbPrivat]]),
            });
            const buero = mit.expenses.find((c) => c.category === BUERO)!;
            expect(`${buero.net}/${buero.vat}/${buero.gross}`).toBe('50/9.5/59.5');
            const privat = mit.neutral.find((c) => c.category === PRIVAT_KATEGORIE)!;
            expect(`${privat.net}/${privat.vat}/${privat.gross}`).toBe('0/0/59.5');
            expect(mit.totals.expenseNet).toBe(60);
            expect(mit.totals.inputVat).toBe(11.4);
            expect(mit.totals.profit).toBe(-60);
            // The unrelated booking stays exactly as it was.
            const sw = (a: typeof mit) => JSON.stringify(a.expenses.find((c) => c.category === SOFTWARE));
            expect(sw(mit)).toBe(sw(ohne));
            expect(JSON.stringify(mit.detail!.find((r) => r.id === 'abo'))).toBe(
                JSON.stringify(ohne.detail!.find((r) => r.id === 'abo')),
            );
            expect(mit.coverage.transactions).toBe(2);
        });

        await it('shows the parts in one row with its origin and what applies without it', async () => {
            const mit = aggregateEuerByTransactions([kauf], docs, 2026, {
                detail: true,
                aufteilungen: new Map([['kauf', halbPrivat]]),
            });
            const row = mit.detail![0];
            expect(mit.detail!.length).toBe(1);
            expect(istAufteilung(row)).toBe(true);
            expect(row.category).toBe(BUERO);
            expect(herkunftText(row)).toBe(aufteilungTitel(2));
            expect(row.aufteilung!.map((p) => `${p.category}:${p.gross}`).join('|')).toBe(
                `${BUERO}:59.5|${PRIVAT_KATEGORIE}:59.5`,
            );
            expect(wasGiltDanach(row)).toBe(`Danach gilt wieder: via Beleg #7 → ${BUERO}.`);
            const beitraege = beitragsZeilen(mit.detail!);
            expect(beitraege.map((r) => `${r.id}:${r.category}:${r.net}:${r.teilNr}`).join('|')).toBe(
                `kauf:${BUERO}:50:1|kauf:${PRIVAT_KATEGORIE}:0:2`,
            );
        });

        await it('books a Bewirtung 70/30 with the full Vorsteuer', async () => {
            const essen = tx({ id: 'essen', counterparty: 'Gasthaus Leuchtturm' });
            const teile = bewirtungsTeile(essen.amount, 0.19);
            const agg = aggregateEuerByTransactions([essen], new Map(), 2026, {
                aufteilungen: new Map([['essen', teile]]),
            });
            const abziehbar = agg.expenses.find((c) => c.category === BEWIRTUNG_KATEGORIE)!;
            const nicht = agg.neutral.find((c) => c.category === BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE)!;
            expect(`${abziehbar.gross}/${abziehbar.net}/${abziehbar.vat}`).toBe('83.3/70/13.3');
            expect(`${nicht.gross}/${nicht.net}/${nicht.vat}`).toBe('35.7/30/5.7');
            expect(agg.totals.expenseNet).toBe(70);
            expect(agg.totals.inputVat).toBe(19);
            expect(agg.totals.vatPayable).toBe(-19);
        });

        await it('ignores a stored split that no longer fits, instead of breaking the report', async () => {
            const agg = aggregateEuerByTransactions([kauf], docs, 2026, {
                aufteilungen: new Map([['kauf', [{ category: BUERO, betrag: 500 }, { category: PRIVAT_KATEGORIE }]]]),
            });
            expect(agg.totals.expenseNet).toBe(100);
        });

        await it('sums the private Vorsteuer and warns about a pauschal Privatanteil', async () => {
            const t = berechneTeile(-119, halbPrivat);
            expect(vorsteuerPrivat(t)).toBe(9.5);
            expect(doppelzaehlungHinweis(t, [])).toBe(null);
            expect(doppelzaehlungHinweis(t, [{ bezeichnung: 'Telefon' }])).toContain('(Telefon)');
            expect(
                doppelzaehlungHinweis(berechneTeile(-119, bewirtungsTeile(-119)), [{ bezeichnung: 'Telefon' }]),
            ).toBe(null);
            expect(hauptTeil(t).category).toBe(BUERO);
        });
    });

    await describe('Splitbuchung: Erstattung zu einer aufgeteilten Zahlung', async () => {
        const teile = berechneTeile(-119, halbPrivat);
        const original: ErstattungBuchung = {
            id: 'orig',
            bookingDate: '2026-03-10',
            amount: -119,
            counterparty: 'Versandhaus Möwe',
            kind: 'expense',
            source: 'manual',
            category: BUERO,
            net: 50,
            vat: 9.5,
            matchedRule: { id: 'aufteilung', label: aufteilungTitel(2), art: 'aufteilung' },
            documentId: 7,
            aufteilung: teile,
        };
        const refund = (amount: number): ErstattungBuchung => ({
            id: `r${amount}`,
            bookingDate: '2026-03-20',
            amount,
            counterparty: 'Versandhaus Möwe',
            kind: 'income',
            source: 'unclassified',
            category: '(unklassifiziert)',
            net: 0,
            vat: 0,
        });

        await it('inherits from the largest business part and offers at most its amount', async () => {
            expect(JSON.stringify(erbeVonUrsprung(original))).toBe(
                JSON.stringify({ category: BUERO, vatRate: 0.19, originalDocumentId: 7 }),
            );
            const k = erstattungKandidaten(refund(59.5), [original], []);
            expect(k.length).toBe(1);
            expect(k[0].exakt).toBe(true);
            expect(erstattungKandidaten(refund(119), [original], []).length).toBe(0);
        });

        await it('offers no original that is private as a whole, and never asks for a split refund', async () => {
            const privat = { ...original, kind: 'neutral' as const, category: PRIVAT_KATEGORIE };
            expect(erstattungKandidaten(refund(59.5), [privat], []).length).toBe(0);
            const geteilt = { ...refund(59.5), source: 'manual' as const, matchedRule: original.matchedRule };
            expect(erstattungKandidaten(geteilt, [original], []).length).toBe(0);
        });
    });

    await describe('Splitbuchung: eingereichte Zeiträume', async () => {
        const register = [
            { kind: 'ustva', period: '2026-Q1', filedAt: '2026-04-10' },
            { kind: 'ustva', period: '2026-Q2', filedAt: '2026-07-10' },
            { kind: 'euer', period: '2026', filedAt: null },
            { kind: 'ust-jahr', period: '2025', filedAt: '2026-05-01' },
        ];

        await it('finds the filed returns of the booking date, by quarter, month and year', async () => {
            expect(
                betroffeneAbgaben('2026-03-10', register)
                    .map((k) => k.label)
                    .join(),
            ).toBe('USt-Voranmeldung Q1/2026');
            expect(betroffeneAbgaben('2026-08-01', register).length).toBe(0);
            expect(
                betroffeneAbgaben('2025-11-02', [
                    ...register,
                    { kind: 'ustva', period: '2025-11', filedAt: '2025-12-10' },
                ])
                    .map((k) => k.label)
                    .join(),
            ).toBe('USt-Jahreserklärung 2025,USt-Voranmeldung 11/2025');
            const w = abgabeWarnung(betroffeneAbgaben('2026-03-10', register));
            expect(w).toContain('schon eingereicht');
            expect(w).toContain('§ 153 AO');
        });

        let dir = '';
        let prev: string | undefined;
        beforeEach(async () => {
            prev = process.env.LEDGER_DB_PATH;
            dir = mkdtempSync(join(tmpdir(), 'bh-aufteilung-'));
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            if (prev === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prev;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('writes nothing in a filed period without confirmation, and undoes with a log', async () => {
            expect(loadAufteilungTeile().length).toBe(0);
            const teile = berechneTeile(-119, halbPrivat);
            const ohne = schreibeAufteilung('kauf', '2026-03-10', teile, { abgaben: register });
            expect(ohne.ok).toBe(false);
            expect(loadAufteilungTeile().length).toBe(0);
            expect(schreibeAufteilung('kauf', '2026-03-10', teile, { abgaben: register, trotzAbgabe: true }).ok).toBe(
                true,
            );
            const gespeichert = loadAufteilungen(['kauf']).get('kauf')!;
            expect(gespeichert.map((p) => `${p.category}:${p.betrag}:${p.rest}`).join('|')).toBe(
                `${BUERO}:59.5:false|${PRIVAT_KATEGORIE}:null:true`,
            );
            // The stored parts book exactly like the entered ones.
            const kauf = tx({ id: 'kauf' });
            const agg = aggregateEuerByTransactions([kauf], new Map(), 2026, { aufteilungen: loadAufteilungen() });
            expect(agg.totals.expenseNet).toBe(50);

            expect(schreibeAufteilung('kauf', '2026-03-10', null, { abgaben: register }).ok).toBe(false);
            expect(loadAufteilungTeile(['kauf']).length).toBe(2);
            const weg = schreibeAufteilung('kauf', '2026-03-10', null, { abgaben: register, trotzAbgabe: true });
            expect(JSON.stringify(weg)).toBe(JSON.stringify({ ok: true, gespeichert: true }));
            expect(loadAufteilungTeile().length).toBe(0);
            const zurueck = aggregateEuerByTransactions([kauf], new Map(), 2026, { aufteilungen: loadAufteilungen() });
            expect(JSON.stringify(zurueck.totals)).toBe(
                JSON.stringify(aggregateEuerByTransactions([kauf], new Map(), 2026).totals),
            );
            expect(
                getDecisionLog('kauf')
                    .map((e) => e.action)
                    .join(','),
            ).toBe('aufteilung.save,aufteilung.remove');
        });

        await it('stores freely in an open period and replaces an earlier split', async () => {
            const a = berechneTeile(-119, halbPrivat);
            const b = berechneTeile(-119, bewirtungsTeile(-119));
            expect(schreibeAufteilung('x', '2026-08-01', a, { abgaben: register }).ok).toBe(true);
            expect(schreibeAufteilung('x', '2026-08-01', b, { abgaben: register }).ok).toBe(true);
            expect(
                loadAufteilungTeile(['x'])
                    .map((p) => p.category)
                    .join('|'),
            ).toBe(`${BEWIRTUNG_KATEGORIE}|${BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE}`);
        });
    });
};
