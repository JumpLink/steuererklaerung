import { describe, it, expect } from '@gjsify/unit';
import { computeSteuerDashboard, jahresAbgabefrist } from '../../../src/core/elster/fristen.ts';

export default async () => {
    await describe('jahresAbgabefrist', async () => {
        await it('is 31 July of the following year without extension', async () => {
            expect(jahresAbgabefrist(2025)).toBe('2026-07-31');
            expect(jahresAbgabefrist(2024)).toBe('2025-07-31');
        });
        await it('shifts by the extension months', async () => {
            expect(jahresAbgabefrist(2025, 7)).toBe('2027-02-28'); // +7 months → end of Feb 2027
        });
    });

    await describe('computeSteuerDashboard', async () => {
        const dash = computeSteuerDashboard({
            year: 2025,
            uste: { vatPayable: 1196.82, closingBalance: 1196.82, prepaidVat: 0 },
            gewst: { messbetrag: 0, gewerbesteuer: 0 },
            feststellung: {
                einkuenfteGesamt: 1125.55,
                partner: [
                    { name: 'A', anteil: 562.77 },
                    { name: 'B', anteil: 562.78 },
                ],
            },
            euerGewinn: 3677.4,
        });

        await it('lists the three annual declarations, all due 31.07.2026', async () => {
            expect(dash.fristen.map((f) => f.key)).toStrictEqual(['ust-jahres', 'feststellung', 'gewst']);
            expect(dash.fristen.every((f) => f.dueDate === '2026-07-31')).toBe(true);
        });

        await it('estimates the own load as USt + GewSt (ESt excluded)', async () => {
            expect(dash.load.ust).toBe(1196.82);
            expect(dash.load.gewst).toBe(0);
            expect(dash.load.total).toBe(1196.82);
        });

        await it('flags the USt prepayments-not-yet-recorded and the 0-Messbetrag GewSt', async () => {
            expect(dash.fristen.find((f) => f.key === 'ust-jahres')?.note).toContain('Vorauszahlungen');
            expect(dash.fristen.find((f) => f.key === 'gewst')?.status).toBe('hinweis');
        });

        await it('surfaces the Einkünfte for the partners (no ESt estimate)', async () => {
            expect(dash.einkuenfte).toBe(1125.55);
            expect(dash.partner.length).toBe(2);
        });

        await it('falls back to the EÜR Gewinn when there is no Feststellung', async () => {
            const d2 = computeSteuerDashboard({ year: 2025, euerGewinn: 800, uste: null, gewst: null });
            expect(d2.fristen.map((f) => f.key)).toStrictEqual(['euer']);
            expect(d2.einkuenfte).toBe(800);
            expect(d2.load.total).toBe(0);
        });

        await it('adds no ESt frist and leaves estErstattung null without an est input', async () => {
            expect(dash.fristen.some((f) => f.key === 'est')).toBe(false);
            expect(dash.estErstattung).toBe(null);
        });
    });

    await describe('computeSteuerDashboard — private ESt (privat entity)', async () => {
        await it('surfaces the ESt Regelfrist (31.07. following year) for an est-only entity', async () => {
            const d = computeSteuerDashboard({ year: 2025, est: { erstattung: 31.17 } });
            const est = d.fristen.find((f) => f.key === 'est');
            expect(est?.label).toBe('Einkommensteuererklärung');
            expect(est?.dueDate).toBe('2026-07-31');
            expect(est?.status).toBe('offen');
            expect(est?.amountLabel).toBe('vsl. Erstattung');
            expect(d.estErstattung).toBe(31.17);
            // No business declaration → no business frist, zero business load.
            expect(d.fristen.map((f) => f.key)).toStrictEqual(['est']);
            expect(d.load.total).toBe(0);
        });

        await it('labels a negative estimate as vsl. Nachzahlung', async () => {
            const d = computeSteuerDashboard({ year: 2025, est: { erstattung: -240 } });
            expect(d.fristen.find((f) => f.key === 'est')?.amountLabel).toBe('vsl. Nachzahlung');
            expect(d.estErstattung).toBe(-240);
        });

        await it('still shows the deadline when the estimate is unavailable (null), with no amount', async () => {
            const d = computeSteuerDashboard({ year: 2025, est: { erstattung: null } });
            const est = d.fristen.find((f) => f.key === 'est');
            expect(est?.dueDate).toBe('2026-07-31');
            expect(est?.amount).toBe(null);
            expect(est?.amountLabel).toBe(undefined);
            expect(d.estErstattung).toBe(null);
        });

        await it('an entity with both business and ESt gets both fristen', async () => {
            const d = computeSteuerDashboard({
                year: 2025,
                uste: { vatPayable: 100, closingBalance: 100, prepaidVat: 50 },
                est: { erstattung: 10 },
            });
            expect(d.fristen.map((f) => f.key)).toStrictEqual(['ust-jahres', 'est']);
            expect(d.estErstattung).toBe(10);
        });
    });
};
