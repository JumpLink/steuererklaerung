/**
 * Unit tests for the pure forwarding logic in `views/tab-hub-logic.ts`.
 *
 * The GTK side lives in `views/tab-hub.ts` and is covered by `dev/responsive-check.sh`; this file
 * only tests the parts that can run without a display.
 */

import { describe, expect, it } from '@gjsify/unit';

import { forwardHeaderToggle } from '../../../src/frontends/desktop/views/tab-hub-logic.ts';

export default async () => {
    await describe('tab-hub-logic: header toggle forwarding', async () => {
        await it('returns the visible tab toggle', async () => {
            const toggle = { label: 'Queue', active: () => true, setActive: () => {} };
            const views = new Map([
                ['a', { headerToggle: () => toggle }],
                ['b', { headerToggle: () => undefined }],
            ]);
            expect(forwardHeaderToggle(views, 'a')).toBe(toggle);
        });

        await it('returns undefined when no tab is visible', async () => {
            expect(forwardHeaderToggle(new Map(), null)).toBeUndefined();
        });

        await it('returns undefined when the visible tab has no toggle', async () => {
            expect(forwardHeaderToggle(new Map([['a', {}]]), 'a')).toBeUndefined();
        });

        await it('returns undefined for an unknown visible tab id', async () => {
            expect(
                forwardHeaderToggle(
                    new Map([['a', { headerToggle: () => ({ active: () => false, setActive: () => {} }) }]]),
                    'z',
                ),
            ).toBeUndefined();
        });
    });
};
