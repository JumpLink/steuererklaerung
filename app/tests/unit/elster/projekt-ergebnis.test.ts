import { describe, it, expect } from '@gjsify/unit';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { aggregateEuerByTransactions, beitragsZeilen } from '../../../src/core/elster/euer-transactions.ts';
import { berechneTeile, PRIVAT_KATEGORIE } from '../../../src/core/elster/splitbuchung.ts';
import {
    danachGilt,
    jahrZeitraum,
    passendeProjektRegel,
    projektergebnis,
    projektFuerBuchung,
    projektKosten,
    rechnungsAnteil,
    type KostenQuelle,
    type ProjektEntscheidung,
    type ProjektRechnung,
    type ProjektRegel,
} from '../../../src/core/elster/projekt-ergebnis.ts';

// All projects, bookings and amounts below are invented.
const PROJEKTE = new Map([
    ['hafenlicht-relaunch', 'Hafenlicht Relaunch'],
    ['leuchtturm-shop', 'Leuchtturm Shop'],
]);
const BEKANNT = new Set(PROJEKTE.keys());
const BUERO = '4930 Bürobedarf';

let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: `pe${n++}`,
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}

/** The rows the presenter hands to the pure part: the EÜR detail rows of the booking. */
function zeilen(
    txs: UnifiedTransaction[],
    aufteilungen?: Map<string, Parameters<typeof berechneTeile>[1]>,
): KostenQuelle[] {
    const agg = aggregateEuerByTransactions(txs, new Map(), 2026, { detail: true, aufteilungen });
    const byId = new Map(txs.map((t) => [t.id, t]));
    return (agg.detail ?? []).map((r) => ({
        id: r.id,
        amount: r.amount,
        counterparty: r.counterparty,
        purpose: r.purpose,
        reference: byId.get(r.id)?.reference,
        type: byId.get(r.id)?.type,
        bookingDate: r.bookingDate,
        kind: r.kind,
        category: r.category,
        net: r.net,
        aufteilung: r.aufteilung?.map((t) => ({ nr: t.nr, category: t.category, kind: t.kind, net: t.net })),
    }));
}

const ZEITRAUM = jahrZeitraum(2026);
const regel = (muster: string, projekt = 'hafenlicht-relaunch', ausnahmen?: string[]): ProjektRegel => ({
    muster,
    projekt,
    ...(ausnahmen ? { ausnahmen } : {}),
});
const entscheidung = (projectId: string | null, teilNr = 0): ProjektEntscheidung => ({ teilNr, projectId });

export default async () => {
    await describe('Projekt: Regel und Vorrang', async () => {
        const kuesten = tx({ id: 'k1', counterparty: 'Küstenlicht Bildagentur', purpose: 'Lizenz Bild 4711' });

        await it('matches a case-insensitive substring of counterparty, purpose, reference and type', () => {
            expect(passendeProjektRegel(kuesten, [regel('KÜSTENLICHT')], BEKANNT)?.projekt).toBe('hafenlicht-relaunch');
            expect(passendeProjektRegel(kuesten, [regel('bild 4711')], BEKANNT)?.muster).toBe('bild 4711');
            const ref = tx({ id: 'r1', reference: 'HL-PROJEKT-7', type: 'Kartenzahlung' });
            expect(passendeProjektRegel(ref, [regel('hl-projekt')], BEKANNT)).not.toBe(null);
            expect(passendeProjektRegel(ref, [regel('kartenzahlung')], BEKANNT)).not.toBe(null);
            expect(passendeProjektRegel(kuesten, [regel('Nordtype')], BEKANNT)).toBe(null);
        });

        await it('never claims an income, an empty pattern or a deleted project', () => {
            const eingang = tx({ id: 'e1', amount: 50, counterparty: 'Küstenlicht Bildagentur' });
            expect(passendeProjektRegel(eingang, [regel('küstenlicht')], BEKANNT)).toBe(null);
            expect(passendeProjektRegel(kuesten, [regel('   ')], BEKANNT)).toBe(null);
            expect(passendeProjektRegel(kuesten, [regel('küstenlicht', 'gelöscht')], BEKANNT)).toBe(null);
        });

        await it('leaves the bookings of `ausnahmen` alone, and the first matching rule wins', () => {
            const rules = [regel('küstenlicht', 'leuchtturm-shop', ['k1']), regel('küstenlicht')];
            expect(passendeProjektRegel(kuesten, rules, BEKANNT)?.projekt).toBe('hafenlicht-relaunch');
            const andere = tx({ id: 'k2', counterparty: 'Küstenlicht Bildagentur' });
            expect(passendeProjektRegel(andere, rules, BEKANNT)?.projekt).toBe('leuchtturm-shop');
        });

        await it('names its origin: via Regel, manuell, manuell: kein Projekt', () => {
            const viaRegel = projektFuerBuchung(kuesten, [], [regel('küstenlicht')], BEKANNT);
            expect(viaRegel.herkunft?.art).toBe('regel');
            expect(viaRegel.herkunft?.label).toBe('via Regel „küstenlicht“');
            const manuell = projektFuerBuchung(
                kuesten,
                [entscheidung('leuchtturm-shop')],
                [regel('küstenlicht')],
                BEKANNT,
            );
            expect(manuell.projectId).toBe('leuchtturm-shop');
            expect(manuell.herkunft?.label).toBe('manuell');
            const keins = projektFuerBuchung(kuesten, [entscheidung(null)], [regel('küstenlicht')], BEKANNT);
            expect(keins.projectId).toBe(null);
            expect(keins.herkunft?.art).toBe('keine');
            expect(projektFuerBuchung(kuesten, [], [], BEKANNT).herkunft).toBe(null);
        });

        await it('a decision of the person wins over a rule, also for a project that has since been deleted', () => {
            const gelöscht = projektFuerBuchung(kuesten, [entscheidung('gelöscht')], [regel('küstenlicht')], BEKANNT);
            expect(gelöscht.projectId).toBe(null);
            expect(gelöscht.herkunft).toBe(null);
        });

        await it('says what applies once the decision is taken back', () => {
            const rules = [regel('küstenlicht')];
            expect(danachGilt(kuesten, [entscheidung('leuchtturm-shop')], rules, PROJEKTE)).toBe(
                'Danach gilt: via Regel „küstenlicht“ → Projekt „Hafenlicht Relaunch“.',
            );
            expect(danachGilt(kuesten, [entscheidung('leuchtturm-shop')], [], PROJEKTE)).toBe(
                'Danach gilt: kein Projekt.',
            );
            expect(danachGilt(kuesten, [entscheidung(null)], rules, PROJEKTE)).toBe(
                'Danach gilt: via Regel „küstenlicht“ → Projekt „Hafenlicht Relaunch“.',
            );
        });
    });

    await describe('Projekt: Kosten', async () => {
        await it('counts the EÜR net of an expense, not the gross', () => {
            const t = tx({
                id: 'a',
                amount: -119,
                counterparty: 'Küstenlicht Bildagentur',
                purpose: 'Bürobedarf Bild',
            });
            const kosten = projektKosten(
                zeilen([t]),
                new Map([['a', [entscheidung('hafenlicht-relaunch')]]]),
                [],
                PROJEKTE,
                ZEITRAUM,
            );
            const liste = kosten.get('hafenlicht-relaunch') ?? [];
            expect(liste.length).toBe(1);
            expect(liste[0].net).toBe(100);
            expect(liste[0].herkunft.label).toBe('manuell');
        });

        await it('ignores income, bookings outside the period and unassigned bookings', () => {
            const rows = zeilen([
                tx({ id: 'ein', amount: 500, counterparty: 'Hafenlicht GmbH', purpose: 'Rechnung' }),
                tx({ id: 'alt', amount: -119, bookingDate: '2025-12-30', counterparty: 'Küstenlicht Bildagentur' }),
                tx({ id: 'ohne', amount: -119, counterparty: 'Anderer Lieferant' }),
            ]);
            const kosten = projektKosten(
                rows,
                new Map(),
                [regel('hafenlicht'), regel('küstenlicht')],
                PROJEKTE,
                ZEITRAUM,
            );
            expect(kosten.size).toBe(0);
        });

        await it('leaves out private and other neutral money', () => {
            const privat = tx({
                id: 'p',
                amount: -50,
                counterparty: 'Küstenlicht Bildagentur',
                purpose: 'Privatentnahme',
            });
            const rows = zeilen([privat]);
            const kosten = projektKosten(
                rows,
                new Map([['p', [entscheidung('hafenlicht-relaunch')]]]),
                [],
                PROJEKTE,
                ZEITRAUM,
            );
            expect(rows[0].kind).toBe('neutral');
            expect(kosten.size).toBe(0);
        });

        await it('assigns a rule hit and honours „kein Projekt"', () => {
            const rows = zeilen([
                tx({ id: 'r1', counterparty: 'Küstenlicht Bildagentur', purpose: 'Bildlizenz 1' }),
                tx({ id: 'r2', counterparty: 'Küstenlicht Bildagentur', purpose: 'Bildlizenz 2' }),
            ]);
            const entscheidungen = new Map([['r2', [entscheidung(null)]]]);
            const kosten = projektKosten(rows, entscheidungen, [regel('küstenlicht')], PROJEKTE, ZEITRAUM);
            expect((kosten.get('hafenlicht-relaunch') ?? []).map((z) => z.txId)).toStrictEqual(['r1']);
            expect(kosten.get('hafenlicht-relaunch')?.[0].herkunft.art).toBe('regel');
        });

        await it('books a split booking per part: the private part is no cost, each part its own project', () => {
            const t = tx({
                id: 'gemischt',
                amount: -238,
                counterparty: 'Versandhaus Möwenpost',
                purpose: 'Bestellung',
            });
            const eingaben = [
                { category: BUERO, betrag: 119, vatRate: 0.19 },
                { category: '4806 Hosting/Cloud', betrag: 59.5, vatRate: 0.19 },
                { category: PRIVAT_KATEGORIE, rest: true, vatRate: 0.19 },
            ];
            expect(berechneTeile(-238, eingaben).length).toBe(3);
            const rows = zeilen([t], new Map([['gemischt', eingaben]]));
            expect(
                beitragsZeilen(
                    aggregateEuerByTransactions([t], new Map(), 2026, {
                        detail: true,
                        aufteilungen: new Map([['gemischt', eingaben]]),
                    }).detail!,
                ).length,
            ).toBe(3);

            // Whole booking → one project: both business parts follow it, the private one never counts.
            const ganz = projektKosten(
                rows,
                new Map([['gemischt', [entscheidung('hafenlicht-relaunch')]]]),
                [],
                PROJEKTE,
                ZEITRAUM,
            );
            expect((ganz.get('hafenlicht-relaunch') ?? []).map((z) => `${z.teilNr}:${z.net}`)).toStrictEqual([
                '1:100',
                '2:50',
            ]);

            // Part 2 to another project: it wins over the whole-booking decision for that part only.
            const teil = projektKosten(
                rows,
                new Map([['gemischt', [entscheidung('hafenlicht-relaunch'), entscheidung('leuchtturm-shop', 2)]]]),
                [],
                PROJEKTE,
                ZEITRAUM,
            );
            expect((teil.get('hafenlicht-relaunch') ?? []).map((z) => `${z.teilNr}:${z.net}`)).toStrictEqual(['1:100']);
            expect((teil.get('leuchtturm-shop') ?? []).map((z) => `${z.teilNr}:${z.net}`)).toStrictEqual(['2:50']);

            // Only the private part decided: nothing, since a private part is no cost.
            const nurPrivat = projektKosten(
                rows,
                new Map([['gemischt', [entscheidung('hafenlicht-relaunch', 3)]]]),
                [],
                PROJEKTE,
                ZEITRAUM,
            );
            expect(nurPrivat.size).toBe(0);
        });
    });

    await describe('Projekt: Ergebnis', async () => {
        const rechnungen: ProjektRechnung[] = [
            {
                id: 'i1',
                nummer: 'RE-2026-0001',
                datum: '2026-02-01',
                netto: 1000,
                sekunden: { 'hafenlicht-relaunch': 36000 },
            },
            // Two projects on one invoice, 3 h : 1 h → 75 % / 25 % of 400 €.
            {
                id: 'i2',
                nummer: 'RE-2026-0002',
                datum: '2026-04-01',
                netto: 400,
                sekunden: { 'hafenlicht-relaunch': 10800, 'leuchtturm-shop': 3600 },
            },
            {
                id: 'i3',
                nummer: 'RE-2025-0009',
                datum: '2025-12-01',
                netto: 900,
                sekunden: { 'hafenlicht-relaunch': 7200 },
            },
        ];
        const kosten = projektKosten(
            zeilen([
                tx({ id: 'k1', amount: -119, counterparty: 'Küstenlicht Bildagentur', purpose: 'Bürobedarf Bild 1' }),
                tx({ id: 'k2', amount: -59.5, counterparty: 'Küstenlicht Bildagentur', purpose: 'Bürobedarf Bild 2' }),
            ]),
            new Map(),
            [regel('küstenlicht')],
            PROJEKTE,
            ZEITRAUM,
        );
        const zeiten = [
            { projectId: 'hafenlicht-relaunch', startedAt: '2026-01-20T08:00:00Z', seconds: 36000 },
            { projectId: 'hafenlicht-relaunch', startedAt: '2026-03-20T08:00:00Z', seconds: 10800 },
            { projectId: 'hafenlicht-relaunch', startedAt: '2025-11-20T08:00:00Z', seconds: 7200 },
            { projectId: 'leuchtturm-shop', startedAt: '2026-03-20T08:00:00Z', seconds: 3600 },
        ];
        const alle = [...kosten.values()].flat();

        await it('splits an invoice of several projects by tracked hours', () => {
            expect(rechnungsAnteil(rechnungen[1], 'hafenlicht-relaunch')).toBe(0.75);
            expect(rechnungsAnteil(rechnungen[1], 'leuchtturm-shop')).toBe(0.25);
            expect(rechnungsAnteil(rechnungen[0], 'leuchtturm-shop')).toBe(0);
        });

        await it('Umsatz − Kosten = Ergebnis, with hours and the result per hour', () => {
            const e = projektergebnis(
                { id: 'hafenlicht-relaunch', name: 'Hafenlicht Relaunch' },
                { kosten: alle, rechnungen, zeiten },
                ZEITRAUM,
            );
            expect(e.umsatz).toBe(1300);
            expect(e.kosten).toBe(150);
            expect(e.ergebnis).toBe(1150);
            expect(e.stunden).toBe(13);
            expect(e.ergebnisProStunde).toBe(88.46);
            expect(e.rechnungen.map((r) => r.nummer).join()).toBe('RE-2026-0001,RE-2026-0002');
            expect(e.rechnungen[1].anteil).toBe(0.75);
            expect(e.ausgaben.length).toBe(2);
        });

        await it('counts only the period: invoices by date, expenses by booking date, hours by start', () => {
            const e2025 = projektergebnis(
                { id: 'hafenlicht-relaunch', name: 'Hafenlicht Relaunch' },
                { kosten: alle, rechnungen, zeiten },
                jahrZeitraum(2025),
            );
            expect(e2025.umsatz).toBe(900);
            expect(e2025.kosten).toBe(0);
            expect(e2025.stunden).toBe(2);
            const quartal = projektergebnis(
                { id: 'hafenlicht-relaunch', name: 'Hafenlicht Relaunch' },
                { kosten: alle, rechnungen, zeiten },
                { von: '2026-04-01', bis: '2026-06-30' },
            );
            expect(quartal.umsatz).toBe(300);
            expect(quartal.stunden).toBe(null);
            expect(quartal.ergebnisProStunde).toBe(null);
        });

        await it('a project without anything is zero, not missing, and a loss is negative', () => {
            const leer = projektergebnis(
                { id: 'leuchtturm-shop', name: 'Leuchtturm Shop' },
                { kosten: [], rechnungen: [], zeiten: [] },
                ZEITRAUM,
            );
            expect(`${leer.umsatz}/${leer.kosten}/${leer.ergebnis}`).toBe('0/0/0');
            expect(leer.stunden).toBe(null);
            const verlust = projektergebnis(
                { id: 'hafenlicht-relaunch', name: 'Hafenlicht Relaunch' },
                { kosten: alle, rechnungen: [], zeiten: [zeiten[0]] },
                ZEITRAUM,
            );
            expect(verlust.ergebnis).toBe(-150);
            expect(verlust.ergebnisProStunde).toBe(-15);
        });
    });
};
