import { describe, it, expect } from '@gjsify/unit';
import { assistantExampleIds } from '../../../src/core/actions/assistant/examples.ts';
import { capabilities } from '../../../src/core/countries/index.ts';

const TAX_IDS = ['vat-due', 'deadlines', 'est-entlastungsbetrag', 'est-kinderbetreuung', 'est-elterngeld'];

export default async () => {
    await describe('assistantExampleIds — suggestions follow the tax module', async () => {
        const de = capabilities({ taxModule: 'de' });
        const none = capabilities({ taxModule: 'none' });

        await it('offers VAT and deadlines to a German business', async () => {
            const ids = assistantExampleIds(de, { hasEst: false, business: true });
            expect(ids.includes('vat-due')).toBe(true);
            expect(ids.includes('deadlines')).toBe(true);
        });

        await it('offers no tax question with the tax module off', async () => {
            for (const hasEst of [false, true]) {
                const ids = assistantExampleIds(none, { hasEst, business: !hasEst, receiptSearch: true });
                expect(ids.some((id) => TAX_IDS.includes(id))).toBe(false);
                expect(ids.includes('biggest-expenses')).toBe(true);
            }
        });

        await it('gives a private ESt entity the intake topics, not VAT', async () => {
            const ids = assistantExampleIds(de, { hasEst: true, business: false });
            expect(ids.includes('est-entlastungsbetrag')).toBe(true);
            expect(ids.includes('vat-due')).toBe(false);
        });

        await it('offers the receipt search only where the frontend has it', async () => {
            expect(assistantExampleIds(de, { hasEst: false, business: true }).includes('find-receipts')).toBe(false);
            expect(
                assistantExampleIds(de, { hasEst: false, business: true, receiptSearch: true }).includes(
                    'find-receipts',
                ),
            ).toBe(true);
        });
    });
};
