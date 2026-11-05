/**
 * The phone layout rules as arithmetic — see `widgets/phone-rules.ts`.
 *
 * These are the decisions of `docs/app/mobile-layout.md`, separated from the GTK calls that carry
 * them out so they can be checked without a display. The widget side is covered by
 * `dev/responsive-check.sh`, which measures the real window.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    TOUCH_GAP,
    TOUCH_TARGET,
    actionOverflow,
    chipScrollTarget,
    headerActionPlan,
    kpiColumns,
    undershoot,
} from '../../../src/frontends/desktop/widgets/phone-rules.ts';

/** @gjsify/unit's `toEqual` is `==`, so a pair of numbers is asserted field by field. */
const columns = (c: { min: number; max: number }): string => `${c.min}-${c.max}`;
const edges = (e: { start: boolean; end: boolean }): string => `${e.start ? 'start' : ''}|${e.end ? 'end' : ''}`;
const plan = (p: { button: number | null; menu: number[] }): string =>
    `${p.button === null ? '-' : p.button}|${p.menu.join(',')}`;

export default async () => {
    await describe('phone-rules: touch metrics', async () => {
        await it('keeps the HIG minimum and a gap a thumb cannot bridge', async () => {
            expect(TOUCH_TARGET).toBe(48);
            expect(TOUCH_GAP).toBe(12);
        });
    });

    await describe('phone-rules: kpiColumns', async () => {
        await it('leaves a wide window at its own maximum', async () => {
            expect(columns(kpiColumns(5, false, 4))).toBe('1-4');
            expect(columns(kpiColumns(1, false, 3))).toBe('1-3');
        });

        await it('puts several cards two-up on a phone', async () => {
            expect(columns(kpiColumns(5, true, 4))).toBe('2-2');
            expect(columns(kpiColumns(2, true, 4))).toBe('2-2');
        });

        await it('gives a lone card the full width', async () => {
            expect(columns(kpiColumns(1, true, 4))).toBe('1-1');
            expect(columns(kpiColumns(0, true, 4))).toBe('1-1');
        });

        await it('treats two-up as a ceiling, not just a floor', async () => {
            // A flow box left at max 4 fits three narrow cards at 360 px and makes none readable.
            expect(kpiColumns(4, true, 4).max).toBe(2);
        });
    });

    await describe('phone-rules: actionOverflow', async () => {
        await it('never collapses a wide row', async () => {
            expect(actionOverflow(['action', 'action', 'action'], false).length).toBe(0);
        });

        await it('leaves a single action as a button', async () => {
            expect(actionOverflow(['static', 'action'], true).length).toBe(0);
        });

        await it('collapses two or more actions, in order', async () => {
            expect(actionOverflow(['static', 'action', 'action'], true)).toEqualArray([1, 2]);
            expect(actionOverflow(['action', 'static', 'action', 'action'], true)).toEqualArray([0, 2, 3]);
        });

        await it('never moves an amount or a badge', async () => {
            expect(actionOverflow(['static', 'static'], true).length).toBe(0);
        });

        await it('handles an empty cluster', async () => {
            expect(actionOverflow([], true).length).toBe(0);
        });
    });

    await describe('phone-rules: chipScrollTarget', async () => {
        const row = { value: 0, page: 300, upper: 800 };

        await it('does nothing when everything fits', async () => {
            expect(chipScrollTarget({ start: 0, size: 100, value: 0, page: 300, upper: 300 })).toBeNull();
            expect(chipScrollTarget({ start: 0, size: 100, value: 0, page: 0, upper: 800 })).toBeNull();
        });

        await it('leaves a chip that is already visible alone', async () => {
            expect(chipScrollTarget({ ...row, start: 50, size: 100 })).toBeNull();
        });

        await it('scrolls a chip past the right edge into view, with slack', async () => {
            // Ends at 500, viewport ends at 300 → 500 + 12 - 300.
            expect(chipScrollTarget({ ...row, start: 400, size: 100 })).toBe(212);
        });

        await it('scrolls back to a chip past the left edge, with slack', async () => {
            expect(chipScrollTarget({ ...row, value: 400, start: 300, size: 80 })).toBe(288);
        });

        await it('clamps to the scrollable range instead of fighting the adjustment', async () => {
            // The slack would ask for -12 at the start and 512 at the end; the max value is 500.
            expect(chipScrollTarget({ ...row, value: 100, start: 0, size: 80 })).toBe(0);
            expect(chipScrollTarget({ ...row, start: 700, size: 100 })).toBe(500);
        });
    });

    await describe('phone-rules: undershoot', async () => {
        await it('fades nothing when the content fits', async () => {
            expect(edges(undershoot(0, 300, 300))).toBe('|');
            expect(edges(undershoot(0, 0, 800))).toBe('|');
        });

        await it('fades the end while there is content to the right', async () => {
            expect(edges(undershoot(0, 300, 800))).toBe('|end');
        });

        await it('fades both edges in the middle of a scroll', async () => {
            expect(edges(undershoot(200, 300, 800))).toBe('start|end');
        });

        await it('fades only the start at the far end', async () => {
            expect(edges(undershoot(500, 300, 800))).toBe('start|');
        });

        await it('does not flicker on a rounding error', async () => {
            // Adjustments land on 0.9999 often enough that a one-pixel tolerance is the point.
            expect(undershoot(0.5, 300, 800).start).toBe(false);
            expect(undershoot(499.5, 300, 800).end).toBe(false);
        });
    });

    await describe('phone-rules: headerActionPlan', async () => {
        await it('leaves a wide window alone — the view toolbar still has them', async () => {
            expect(plan(headerActionPlan(['primary', 'secondary'], false))).toBe('-|');
            expect(plan(headerActionPlan(['primary'], false))).toBe('-|');
        });

        await it('puts the creating action on the button and the rest in the menu', async () => {
            expect(plan(headerActionPlan(['primary', 'secondary'], true))).toBe('0|1');
            expect(plan(headerActionPlan(['secondary', 'primary'], true))).toBe('1|0');
        });

        await it('shows a lone primary without opening a menu', async () => {
            expect(plan(headerActionPlan(['primary'], true))).toBe('0|');
        });

        await it('menus everything when no action claims to be primary', async () => {
            expect(plan(headerActionPlan(['secondary', 'secondary'], true))).toBe('-|0,1');
        });

        await it('keeps a second primary rather than dropping it', async () => {
            // One button's worth of room; an action a view declared is never silently lost.
            expect(plan(headerActionPlan(['primary', 'primary', 'secondary'], true))).toBe('0|1,2');
        });

        await it('has nothing to place for a view that offers nothing', async () => {
            expect(plan(headerActionPlan([], true))).toBe('-|');
        });
    });
};
