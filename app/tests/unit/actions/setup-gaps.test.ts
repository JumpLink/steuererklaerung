/**
 * The setup banner's decision — what counts as missing, and when a closed banner comes back.
 *
 *   - no manifest / no entity is a gap; an entity without an assigned account is one per entity,
 *   - demo entities are never a gap,
 *   - only someone who put the welcome off sees the banner — never an installation from before
 *     the welcome existed, never someone who finished it,
 *   - closing remembers the gaps; only a NEW one brings the banner back.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
    setupGapFingerprint,
    setupGaps,
    shouldShowSetupBanner,
    type SetupBannerSettings,
} from '../../../src/core/actions/setup-gaps.ts';

const deferred: SetupBannerSettings = { welcomeCompleted: false, welcomeDeferred: true };

export default async () => {
    await describe('setup gaps', async () => {
        await it('no manifest or no entity → one "no-entity" gap', async () => {
            expect(setupGapFingerprint(setupGaps(null))).toStrictEqual(['no-entity']);
            expect(setupGapFingerprint(setupGaps([]))).toStrictEqual(['no-entity']);
        });

        await it('an entity without accounts is a gap; one with accounts is not', async () => {
            const gaps = setupGaps([
                { id: 'eu', name: 'Erika Muster', accounts: [] },
                { id: 'gbr', name: 'Muster & Partner GbR', accounts: ['camt:*'] },
            ]);
            expect(gaps).toStrictEqual([{ kind: 'no-account', entityId: 'eu', entityName: 'Erika Muster' }]);
        });

        await it('demo entities are never a gap', async () => {
            expect(setupGaps([{ id: 'demo', name: 'Fischer & Weber GbR', accounts: [], demo: true }])).toHaveLength(0);
        });

        await it('a complete installation has no gaps', async () => {
            expect(setupGaps([{ id: 'eu', name: 'Erika Muster', accounts: ['qonto:x'] }])).toHaveLength(0);
        });
    });

    await describe('setup banner', async () => {
        const gaps = setupGaps(null);

        await it('shows after „Later" while something is missing', async () => {
            expect(shouldShowSetupBanner(deferred, gaps)).toBe(true);
        });

        await it('never without a gap', async () => {
            expect(shouldShowSetupBanner(deferred, [])).toBe(false);
        });

        await it('never for an installation without a settings file (Altbestand)', async () => {
            expect(shouldShowSetupBanner({ welcomeCompleted: false }, gaps)).toBe(false);
        });

        await it('never once the welcome was finished', async () => {
            expect(shouldShowSetupBanner({ ...deferred, welcomeCompleted: true }, gaps)).toBe(false);
        });

        await it('closing hides it for the same gaps, a new gap brings it back', async () => {
            const dismissed = { ...deferred, setupBannerDismissed: setupGapFingerprint(gaps) };
            expect(shouldShowSetupBanner(dismissed, gaps)).toBe(false);
            const later = setupGaps([{ id: 'eu', name: 'Erika Muster', accounts: [] }]);
            expect(shouldShowSetupBanner(dismissed, later)).toBe(true);
        });

        await it('a fixed gap drops out without bringing the banner back', async () => {
            const two = setupGaps([
                { id: 'a', name: 'A', accounts: [] },
                { id: 'b', name: 'B', accounts: [] },
            ]);
            const dismissed = { ...deferred, setupBannerDismissed: setupGapFingerprint(two) };
            expect(shouldShowSetupBanner(dismissed, setupGaps([{ id: 'a', name: 'A', accounts: [] }]))).toBe(false);
        });

        await it('the fingerprint is sorted and free of duplicates', async () => {
            const g = setupGaps([
                { id: 'b', name: 'B', accounts: [] },
                { id: 'a', name: 'A', accounts: [] },
            ]);
            expect(setupGapFingerprint([...g, ...g])).toStrictEqual(['no-account:a', 'no-account:b']);
        });
    });
};
