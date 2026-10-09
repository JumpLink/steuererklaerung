import { describe, it, expect } from '@gjsify/unit';
import { suggestPattern } from '../../../src/core/actions/classification-rules.ts';

export default async () => {
    await describe('suggestPattern', async () => {
        await it('takes the counterparty, the stable half of a bank booking', async () => {
            expect(suggestPattern({ counterparty: 'Hetzner Online GmbH', purpose: 'RG 12345 vom 03.06.' })).toBe(
                'Hetzner Online GmbH',
            );
        });

        await it('falls back to the longest name-like word of the purpose', async () => {
            // No counterparty is common on camt imports; the purpose is all there is.
            expect(suggestPattern({ counterparty: '', purpose: 'Dauerauftrag Buchhaltungssoftware 4711' })).toBe(
                'Buchhaltungssoftware',
            );
        });

        await it('never suggests a number — it would match exactly one payment', async () => {
            // The whole point of a rule is the NEXT booking. `RG-2025-0087` catches one and nothing else.
            expect(suggestPattern({ counterparty: null, purpose: 'RG-2025-0087 12345 987654321' })).toBe('');
            expect(suggestPattern({ counterparty: '  ', purpose: '2025 2026 4711' })).toBe('');
        });

        await it('has no suggestion when the booking carries no text at all', async () => {
            expect(suggestPattern({})).toBe('');
            expect(suggestPattern({ counterparty: null, purpose: null })).toBe('');
        });

        await it('trims, so a padded counterparty does not become a rule that never matches', async () => {
            expect(suggestPattern({ counterparty: '  Stripe Payments UG  ' })).toBe('Stripe Payments UG');
        });
    });
};
