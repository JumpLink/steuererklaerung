import { describe, it, expect } from '@gjsify/unit';
import { buildChatContext } from '../../../src/core/actions/assistant/chat.ts';
import type { YearCache } from '../../../src/core/presenters/year-snapshot.ts';

const yc = {
    year: 2025,
    transactions: { rows: [1, 2, 3], coverage: { unclassified: [1] } },
    euer: { aggregate: { totals: { incomeNet: 15230.53, expenseNet: 11553.13, profit: 3677.4, vatPayable: 1196.82 } } },
    uste: { net_19: 15230.53, vat_out: 2893.82, vat_in: 1697, vatPayable: 1196.82, closingBalance: 1196.82 },
    gewst: { result: { messbetrag: 0, gewerbesteuer: 0 } },
    feststellung: {
        result: {
            einkuenfteGesamt: 1125.55,
            allocations: [{ gesellschafter: { name: 'Erika Mustermann' }, gesamtAnteil: 562.77 }],
        },
    },
    bwa: {
        totals: { gesamtleistung: 15230.53, rohertrag: 15230.53, betriebskosten: 11553.13, betriebsergebnis: 3677.4 },
    },
    dashboard: {
        fristen: [
            { label: 'USt-Jahreserklärung', dueDate: '2026-08-31', amount: 1196.82, amountLabel: 'Abschlusszahlung' },
        ],
        load: { ust: 1196.82, gewst: 0, total: 1196.82 },
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
            expect(ctx.includes('Gewinn 3.677,40')).toBe(true);
            expect(ctx.includes('Zahllast 1.196,82')).toBe(true);
            expect(ctx.includes('Betriebsergebnis 3.677,40')).toBe(true);
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
