import { describe, it, expect } from '@gjsify/unit';
import { computeAufgabebilanz, type AufgabebilanzInput } from '../../../src/core/elster/aufgabebilanz.ts';

const base: AufgabebilanzInput = {
    datum: '2025-10-31',
    anlagen: [{ id: 'pc', bezeichnung: 'PC', restbuchwert: 1 }],
    bank: [{ konto: 'Hauptkonto', saldo: 500 }],
    posten: [
        { ref: 'a', datum: '2025-11-12', bezeichnung: 'Rechnung Oktober', netto: 1000, ust: 190, art: 'einnahme' },
        { ref: 'b', datum: '2025-11-24', bezeichnung: 'Steuerberatung', netto: 300, ust: 57, art: 'ausgabe' },
        { ref: 'c', datum: '2025-12-03', bezeichnung: 'Buchführung Q3', netto: 200, ust: 38, art: 'ausgabe', als: 'rueckstellung' },
        { ref: 'd', datum: '2025-12-31', bezeichnung: 'Mahngebühr', netto: 10, ust: 0, art: 'ausgabe', entstanden: '2026-04-13' },
    ],
    // EÜR to the Aufgabe 2.000 + the four §24 flows (1000 − 300 − 200 − 10)
    laufenderGewinn: 2490,
    nachtraeglichNet: 490,
};

export default async () => {
    await describe('computeAufgabebilanz', async () => {
        await it('classifies by art, entstanden and an explicit als', async () => {
            const r = computeAufgabebilanz(base);
            expect(r.forderungen.map((p) => p.ref)).toStrictEqual(['a']);
            expect(r.verbindlichkeiten.map((p) => p.ref)).toStrictEqual(['b']);
            expect(r.rueckstellungen.map((p) => p.ref)).toStrictEqual(['c']);
            expect(r.nachtraeglich.map((p) => p.ref)).toStrictEqual(['d']);
        });

        await it('computes the Übergangsgewinn net of USt', async () => {
            const u = computeAufgabebilanz(base).uebergangsgewinn;
            expect(u.forderungen).toBe(1000);
            expect(u.verbindlichkeiten).toBe(300);
            expect(u.rueckstellungen).toBe(200);
            expect(u.summe).toBe(500);
        });

        await it('reconciles to the unchanged laufender Gewinn', async () => {
            const ue = computeAufgabebilanz(base).ueberleitung;
            expect(ue.euerBisAufgabe).toBe(2000);
            expect(ue.nachtraeglichNet).toBe(-10);
            expect(ue.laufenderGewinn).toBe(2490);
            expect(ue.abweichung).toBe(0);
        });

        await it('balances with Eigenkapital as the Saldo', async () => {
            const r = computeAufgabebilanz(base);
            // Aktiva: PC 1 + Forderung 1190 + Vorsteuer 57 + Bank 500 = 1748
            expect(r.summeAktiva).toBe(1748);
            // Fremdkapital: Verbindlichkeit 357 + Rückstellung 200 (netto) + USt 190 = 747
            expect(r.eigenkapital).toBe(1001);
            const passiva = r.passiva.reduce((s, z) => s + z.betrag, 0);
            expect(Math.round(passiva * 100) / 100).toBe(1748);
        });

        await it('carries tax balances on their side without touching the Übergangsgewinn', async () => {
            const r = computeAufgabebilanz({
                ...base,
                steuerposten: [{ bezeichnung: 'USt-Verbindlichkeit', betrag: 300, seite: 'passiv' }],
            });
            expect(r.eigenkapital).toBe(701);
            expect(r.uebergangsgewinn.summe).toBe(500);
        });

        await it('reports a §24 flow missing from the posten', async () => {
            const r = computeAufgabebilanz({ ...base, nachtraeglichNet: 450 });
            expect(r.ueberleitung.abweichung).toBe(40);
        });

        await it('rejects an income classified as a liability', async () => {
            expect(() =>
                computeAufgabebilanz({
                    ...base,
                    posten: [{ ref: 'x', datum: '2025-11-01', bezeichnung: 'X', netto: 1, ust: 0, art: 'einnahme', als: 'rueckstellung' }],
                }),
            ).toThrow();
        });
    });
};
