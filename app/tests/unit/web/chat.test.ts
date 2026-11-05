import { describe, it, expect } from '@gjsify/unit';
import { buildChatContext } from '../../../src/core/actions/assistant/chat.ts';
import type { YearCache } from '../../../src/core/presenters/year-snapshot.ts';

const yc = {
    year: 2025,
    transactions: { rows: [1, 2, 3], coverage: { unclassified: [1] } },
    euer: { aggregate: { totals: { incomeNet: 18460.4, expenseNet: 15020.0, profit: 3440.4, vatPayable: 1403.18 } } },
    uste: { net_19: 18460.4, vat_out: 3507.48, vat_in: 2104.3, vatPayable: 1403.18, closingBalance: 1403.18 },
    gewst: { result: { messbetrag: 0, gewerbesteuer: 0 } },
    feststellung: {
        result: {
            einkuenfteGesamt: 1125.55,
            allocations: [{ gesellschafter: { name: 'Erika Mustermann' }, gesamtAnteil: 562.77 }],
        },
    },
    bwa: {
        totals: { gesamtleistung: 18460.4, rohertrag: 18460.4, betriebskosten: 15020.0, betriebsergebnis: 3440.4 },
    },
    dashboard: {
        fristen: [
            { label: 'USt-Jahreserklärung', dueDate: '2026-08-31', amount: 1403.18, amountLabel: 'Abschlusszahlung' },
        ],
        load: { ust: 1403.18, gewst: 0, total: 1403.18 },
    },
    hinweise: [
        { key: 'k', level: 'tipp', title: 'Kleinunternehmerregelung wäre möglich', text: 'Umsatz unter 25.000 €.' },
    ],
    reconciliation: {},
} as unknown as YearCache;

export default async () => {
    await describe('buildChatContext', async () => {
        const ctx = buildChatContext(yc, 'Muster & Partner GbR', 2025);

        await it('includes the entity, year and the EÜR/USt/BWA figures', async () => {
            expect(ctx.includes('Muster & Partner GbR')).toBe(true);
            expect(ctx.includes('Wirtschaftsjahr: 2025')).toBe(true);
            expect(ctx.includes('Gewinn 3.440,40')).toBe(true);
            expect(ctx.includes('Zahllast 1.403,18')).toBe(true);
            expect(ctx.includes('Betriebsergebnis 3.440,40')).toBe(true);
        });

        await it('includes the deadlines, the Feststellung split and the hints', async () => {
            expect(ctx.includes('2026-08-31')).toBe(true);
            expect(ctx.includes('Erika Mustermann 562,77')).toBe(true);
            expect(ctx.includes('Kleinunternehmerregelung')).toBe(true);
        });

        await it('omits sections that are absent (no crash on a sparse cache)', async () => {
            const sparse = {
                year: 2025,
                transactions: { rows: [], coverage: { unclassified: [] } },
            } as unknown as YearCache;
            const c = buildChatContext(sparse, 'JumpLink', 2025);
            expect(c.includes('JumpLink')).toBe(true);
            expect(c.includes('USt-Jahreserklärung')).toBe(false);
        });
    });
};
