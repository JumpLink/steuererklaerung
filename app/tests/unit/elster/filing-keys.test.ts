import { describe, it, expect } from '@gjsify/unit';
import {
    filingKindForForm,
    filingPeriodForScope,
    formForFilingKind,
} from '../../../src/core/actions/elster/filing-keys.ts';

/**
 * The register key, shared by the two paths that submit.
 *
 * `recordWebFiling` (typed in after a filing made by hand in Mein ELSTER) and
 * `submitFiling` (the tool's own ERiC transmission) must name the same filing
 * the same way, or one return lands twice under two keys. This mapping was
 * private to the web path while the ERiC path recorded nothing at all — so the
 * two could not disagree, because only one of them spoke.
 */
export default async () => {
    await describe('filing register keys', async () => {
        await it('maps every form to its kind and back', async () => {
            for (const form of ['ustva', 'euer', 'uste', 'gewst', 'feststellung', 'est'] as const) {
                expect(formForFilingKind(filingKindForForm(form))).toBe(form);
            }
            // The one that is not an identity, and the reason a round-trip test
            // is worth having: the annual VAT return is filed as `uste` and
            // recorded as `ust-jahr`.
            expect(filingKindForForm('uste')).toBe('ust-jahr');
            expect(formForFilingKind('ust-jahr')).toBe('uste');
        });

        await it('answers null for a kind that is not a form', async () => {
            // `dauerfrist` is in the register but is not a return, so nothing
            // should go looking for a snapshot of it.
            expect(formForFilingKind('dauerfrist')).toBe(null);
            expect(formForFilingKind('')).toBe(null);
        });

        await it('keys an annual form on the bare year', async () => {
            expect(filingPeriodForScope('uste', 2025)).toBe('2025');
            expect(filingPeriodForScope('est', 2025, null)).toBe('2025');
            // A scope passed to an annual form is ignored rather than honoured:
            // the register has one slot per year for these.
            expect(filingPeriodForScope('feststellung', 2025, '2025-Q1')).toBe('2025');
        });

        await it('keys a USt-VA on its Voranmeldungszeitraum', async () => {
            expect(filingPeriodForScope('ustva', 2026, '2026-Q1')).toBe('2026-Q1');
            expect(filingPeriodForScope('ustva', 2026, '2026-03')).toBe('2026-03');
        });

        await it('refuses a USt-VA period that is missing or from another year', async () => {
            // Silently falling back to the bare year would make Q1..Q4 overwrite
            // each other and corrupt the Vorauszahlungssoll (Z119), which sums
            // the year's UStVA rows.
            expect(() => filingPeriodForScope('ustva', 2026)).toThrow();
            expect(() => filingPeriodForScope('ustva', 2026, '')).toThrow();
            // The year guard: submitting Q1/2026 must not be recorded under 2025.
            expect(() => filingPeriodForScope('ustva', 2026, '2025-Q1')).toThrow();
            expect(() => filingPeriodForScope('ustva', 2026, '2026-Q5')).toThrow();
            expect(() => filingPeriodForScope('ustva', 2026, '2026-13')).toThrow();
        });
    });
};
