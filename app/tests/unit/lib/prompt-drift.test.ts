import { describe, it, expect } from '@gjsify/unit';
import { INVOICE_EXTRACTION_SYSTEM_PROMPT } from '../../../src/core/lib/prompts.ts';
import { ACCOUNTING_CATEGORY_OPTIONS } from '../../../src/core/lib/select-field-constants.ts';

// Guards the invoice-extraction prompt against drifting out of sync with the
// accounting-category constant. The enum is interpolated from the constant, so
// it can't drift; the hand-written selection hints CAN — this fails if a new
// category is added without a hint.
export default async () => {
    await describe('invoice-extraction prompt ↔ accounting categories (drift guard)', async () => {
        await it('lists every category in the enum and gives each a selection hint', async () => {
            for (const cat of ACCOUNTING_CATEGORY_OPTIONS) {
                expect(INVOICE_EXTRACTION_SYSTEM_PROMPT, `"${cat}" missing from the prompt enum`).toContain(`"${cat}"`);
                expect(INVOICE_EXTRACTION_SYSTEM_PROMPT, `"${cat}" has no selection hint (→ "${cat}")`).toContain(`→ "${cat}"`);
            }
        });

        await it('embeds the full enum exactly as a comma-separated list', async () => {
            const enumStr = ACCOUNTING_CATEGORY_OPTIONS.map((c) => `"${c}"`).join(', ');
            expect(INVOICE_EXTRACTION_SYSTEM_PROMPT).toContain(`must be exactly one of: ${enumStr}.`);
        });
    });
};
