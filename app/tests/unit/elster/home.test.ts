import { describe, it, expect } from '@gjsify/unit';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { computeSteuerDashboard } from '../../../src/core/elster/fristen.ts';

// The Übersicht "Als Nächstes" + Steuer-Prognose KPI come from the Steuer-Dashboard. A privat
// entity (est config, no ELSTER) must get its Einkommensteuererklärung deadline AND its ESt estimate
// as the KPI — never the (zero) business load, which would render a misleading "0 €" tile.
export default async () => {
    await describe('buildHomeModel — "Als Nächstes" + Steuer-KPI', async () => {
        await it('surfaces the ESt Abgabetermin and the ESt estimate KPI for a privat entity', async () => {
            const dashboard = computeSteuerDashboard({ year: 2025, est: { erstattung: 34.17 } });
            const m = buildHomeModel({ year: 2025, txs: [], dashboard });
            expect(m.tasks.some((t) => t.title === 'Einkommensteuererklärung')).toBe(true);
            expect(m.tasks[0]?.sub).toContain('2026-07-31');
            // KPI = the personal ESt result, not the zero business load. + Erstattung → negative KPI
            // total (mirrors the load's "+ = Nachzahlung" convention) → labelled 'vsl. Erstattung'.
            expect(m.kpis.tax).toStrictEqual({ total: -34.17, label: 'vsl. Erstattung' });
        });

        await it('shows the deadline but NO tax KPI when the ESt estimate is unavailable (never a bogus 0 €)', async () => {
            const dashboard = computeSteuerDashboard({ year: 2025, est: { erstattung: null } });
            const m = buildHomeModel({ year: 2025, txs: [], dashboard });
            expect(m.tasks.some((t) => t.title === 'Einkommensteuererklärung')).toBe(true);
            expect(m.kpis.tax).toBe(null);
        });

        await it('keeps the USt+GewSt load KPI + business fristen for a business entity', async () => {
            const dashboard = computeSteuerDashboard({
                year: 2025,
                uste: { vatPayable: 1196.82, closingBalance: 1196.82, prepaidVat: 0 },
            });
            const m = buildHomeModel({ year: 2025, txs: [], dashboard });
            expect(m.kpis.tax).toStrictEqual({ total: 1196.82, label: 'vsl. Nachzahlung' });
            expect(m.tasks.some((t) => t.title === 'USt-Jahreserklärung')).toBe(true);
        });

        await it('has no tasks and no tax KPI without a dashboard', async () => {
            const m = buildHomeModel({ year: 2025, txs: [], dashboard: null });
            expect(m.tasks.length).toBe(0);
            expect(m.kpis.tax).toBe(null);
        });

        await it('puts one warn task per double-payment suspicion before the fristen', async () => {
            const dashboard = computeSteuerDashboard({ year: 2025, est: { erstattung: 10 } });
            const m = buildHomeModel({
                year: 2025,
                txs: [],
                dashboard,
                doppelzahlungVerdacht: [{ rechnungId: 'inv-1', rechnungNummer: 'RE-2025-0001', zuViel: 1234.5 }],
            });
            expect(m.tasks[0]).toStrictEqual({
                title: 'Rechnung RE-2025-0001 doppelt bezahlt?',
                sub: '1.234,50 € zu viel eingegangen — klären',
                tone: 'warn',
                kind: 'doppelzahlung',
                ref: 'inv-1',
            });
            expect(m.tasks.some((t) => t.title === 'Einkommensteuererklärung')).toBe(true);
        });

        await it('flags a partly surplus suspicion in the task sub line', async () => {
            const m = buildHomeModel({
                year: 2025,
                txs: [],
                dashboard: null,
                doppelzahlungVerdacht: [{ rechnungId: 'inv-1', rechnungNummer: 'RE-1', zuViel: 20, teilweise: true }],
            });
            expect(m.tasks[0].sub).toBe('20,00 € zu viel eingegangen (teilweise zu viel) — klären');
        });
    });
};
