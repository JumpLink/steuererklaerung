/**
 * The phone layout rules as arithmetic — see `widgets/phone-rules.ts`.
 *
 * These are the decisions of `docs/app/mobile-layout.md`, separated from the GTK calls that carry
 * them out so they can be checked without a display. The widget side is covered by
 * `dev/responsive-check.sh`, which measures the real window.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    BADGE_CAP,
    DESCRIPTION_LINE_CHARS,
    PATH_LINE_CHARS,
    TOUCH_GAP,
    TOUCH_TARGET,
    actionOverflow,
    badgeLabel,
    bwaDefaultMonth,
    bwaMonthColumnStart,
    bwaMonthScrollTarget,
    chipScrollTarget,
    contextTitle,
    demoBannerVariant,
    descriptionCap,
    dialogContentHeight,
    explainerPlacement,
    headerActionPlan,
    kpiBlockMode,
    kpiColumns,
    middleEllipsis,
    navBadgeCounts,
    overviewSections,
    phoneSubtitleLines,
    receiptInboxPhoneLayout,
    recurringSummaryParts,
    searchVisible,
    undershoot,
} from '../../../src/frontends/desktop/widgets/phone-rules.ts';

/** @gjsify/unit's `toEqual` is `==`, so a pair of numbers is asserted field by field. */
const columns = (c: { min: number; max: number }): string => `${c.min}-${c.max}`;
const edges = (e: { start: boolean; end: boolean }): string => `${e.start ? 'start' : ''}|${e.end ? 'end' : ''}`;
const plan = (p: { button: number | null; menu: number[] }): string =>
    `${p.button === null ? '-' : p.button}|${p.menu.join(',')}`;
const text = (parts: { kind: string; n: number }[]): string => parts.map((p) => `${p.n} ${p.kind}`).join(' · ');

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

    await describe('phone-rules: contextTitle', async () => {
        await it('keeps the view title on a desktop — the sidebar already says it', async () => {
            expect(contextTitle('Fischer & Weber GbR', 2025, false) === null).toBe(true);
        });

        await it('reads entity and year on a phone', async () => {
            expect(contextTitle('Fischer & Weber GbR', 2025, true)).toBe('Fischer & Weber GbR · 2025');
        });

        await it('drops an unknown year rather than printing 0', async () => {
            expect(contextTitle('Fischer & Weber GbR', 0, true)).toBe('Fischer & Weber GbR');
        });

        await it('falls back to the plain title while no entity is loaded', async () => {
            expect(contextTitle(null, 2025, true) === null).toBe(true);
            expect(contextTitle('', 2025, true) === null).toBe(true);
        });
    });

    await describe('phone-rules: badgeLabel', async () => {
        await it('hides zero, negative and non-finite counts', async () => {
            expect(badgeLabel(0) === null).toBe(true);
            expect(badgeLabel(-2) === null).toBe(true);
            expect(badgeLabel(Number.NaN) === null).toBe(true);
        });

        await it('spells small counts out', async () => {
            expect(badgeLabel(1)).toBe('1');
            expect(badgeLabel(BADGE_CAP)).toBe('99');
        });

        await it('caps large counts', async () => {
            expect(badgeLabel(BADGE_CAP + 1)).toBe('99+');
            expect(badgeLabel(12345)).toBe('99+');
        });
    });

    await describe('phone-rules: navBadgeCounts', async () => {
        const none = {
            zuPruefen: 0,
            erstattungen: 0,
            laufendeKosten: 0,
            forderungen: 0,
            doppelzahlung: 0,
            fristenOffen: 0,
        };

        await it('is empty when nothing is open', async () => {
            expect(Object.keys(navBadgeCounts(none)).length).toBe(0);
        });

        await it('sums everything that opens Transactions', async () => {
            const b = navBadgeCounts({ ...none, zuPruefen: 4, erstattungen: 2, laufendeKosten: 1 });
            expect(b.transactions).toBe(7);
            expect(b.rechnungen === undefined).toBe(true);
        });

        await it('sums overdue invoices and double payments for Invoices', async () => {
            expect(navBadgeCounts({ ...none, forderungen: 3, doppelzahlung: 1 }).rechnungen).toBe(4);
        });

        await it('maps open deadlines to Deadlines', async () => {
            expect(navBadgeCounts({ ...none, fristenOffen: 2 }).fristen).toBe(2);
        });
    });

    await describe('phone-rules: demoBannerVariant', async () => {
        await it('keeps the full wording on a desktop', async () => {
            expect(demoBannerVariant(false)).toBe('full');
        });

        await it('shortens it on a phone', async () => {
            expect(demoBannerVariant(true)).toBe('short');
        });
    });

    await describe('phone-rules: overviewSections', async () => {
        await it('keeps the desktop order', async () => {
            expect(overviewSections(false, true).join()).toBe('kpis,frei,tasks,bars,split');
        });

        await it('moves the derived figures below Up next on a phone', async () => {
            expect(overviewSections(true, true).join()).toBe('kpis,tasks,frei,bars,split');
        });

        await it('drops Up next when there is nothing to do', async () => {
            expect(overviewSections(true, false).join()).toBe('kpis,frei,bars,split');
            expect(overviewSections(false, false).join()).toBe('kpis,frei,bars,split');
        });
    });

    await describe('phone-rules: recurringSummaryParts', async () => {
        await it('leaves zero counts out', async () => {
            expect(text(recurringSummaryParts(2, 0, 2))).toBe('2 overdue · 2 total');
            expect(text(recurringSummaryParts(0, 1, 4))).toBe('1 soon · 4 total');
        });

        await it('names all three when all are open', async () => {
            expect(text(recurringSummaryParts(1, 2, 5))).toBe('1 overdue · 2 soon · 5 total');
        });

        await it('always ends on the total', async () => {
            expect(text(recurringSummaryParts(0, 0, 3))).toBe('3 total');
        });
    });

    await describe('phone-rules: receipt inbox (step 9)', async () => {
        const layout = (narrow: boolean, collapsed: boolean) => {
            const l = receiptInboxPhoneLayout(narrow, collapsed);
            return `${l.showHeaderToggle ? 'toggle' : '-'}/${l.pinActionBar ? 'bar' : '-'}/${l.reopenQueueAfterConfirm ? 'reopen' : '-'}`;
        };

        await it('shows the queue toggle whenever the split view is collapsed', async () => {
            expect(layout(false, false)).toBe('-/-/-');
            expect(layout(false, true)).toBe('toggle/-/-');
            expect(layout(true, true)).toBe('toggle/bar/reopen');
        });

        await it('pins the action bar and reopens the queue only on a phone window', async () => {
            expect(layout(true, false)).toBe('-/bar/reopen');
        });
    });

    await describe('phone-rules: dialog content height (step 10)', async () => {
        await it('sizes dialogs to content on a phone', async () => {
            expect(dialogContentHeight(true, 680)).toBe(-1);
            expect(dialogContentHeight(true, 720)).toBe(-1);
        });

        await it('keeps the fixed desktop height on a wide window', async () => {
            expect(dialogContentHeight(false, 680)).toBe(680);
            expect(dialogContentHeight(false, 720)).toBe(720);
        });
    });

    await describe('phone-rules: step 7 list pages', async () => {
        await it('caps a row subtitle at two lines on a phone only', async () => {
            expect(phoneSubtitleLines(true)).toBe(2);
            expect(phoneSubtitleLines(false)).toBe(0);
        });

        await it('folds an explainer into an expander only on a phone with text', async () => {
            expect(explainerPlacement(true, true)).toBe('expander');
            expect(explainerPlacement(true, false)).toBe('description');
            expect(explainerPlacement(false, true)).toBe('description');
        });

        await it('collapses a KPI block on a phone when there are cards', async () => {
            expect(kpiBlockMode(true, 4)).toBe('expander');
            expect(kpiBlockMode(true, 0)).toBe('cards');
            expect(kpiBlockMode(false, 4)).toBe('cards');
        });

        await it('keeps the search entry visible on a desktop and while it filters', async () => {
            expect(searchVisible(false, false, '')).toBe(true);
            expect(searchVisible(true, false, '')).toBe(false);
            expect(searchVisible(true, true, '')).toBe(true);
            expect(searchVisible(true, false, ' x ')).toBe(true);
            expect(searchVisible(true, false, '   ')).toBe(false);
        });
    });

    await describe('phone-rules: step 13 recurring-invoice overflow (#76)', async () => {
        await it('caps the recurring row subtitle at two lines on a phone', async () => {
            // boundRowText(row, { narrowSubtitleLines: phoneSubtitleLines(true) }) in rechnungen-view.ts
            expect(phoneSubtitleLines(true)).toBe(2);
        });

        await it('leaves the recurring row subtitle unbounded on desktop', async () => {
            expect(phoneSubtitleLines(false)).toBe(0);
        });

        await it('titles the phone expander with the recurring summary', async () => {
            expect(text(recurringSummaryParts(2, 0, 2))).toBe('2 overdue · 2 total');
            expect(text(recurringSummaryParts(0, 1, 4))).toBe('1 soon · 4 total');
            expect(text(recurringSummaryParts(1, 2, 5))).toBe('1 overdue · 2 soon · 5 total');
            expect(text(recurringSummaryParts(0, 0, 3))).toBe('3 total');
        });
    });

    await describe('phone-rules: descriptionCap (step 8b group descriptions)', async () => {
        const zahlungen =
            'Filed, but not yet recorded as paid. Amounts and dates are estimated from the rules — ' +
            'check them against the notice and the bank statement.';

        await it('returns the whole text on a desktop', async () => {
            expect(descriptionCap(zahlungen, false).rest).toBe(null);
            expect(descriptionCap(zahlungen, false).shown).toBe(zahlungen);
        });

        await it('returns the whole text when two lines already fit', async () => {
            expect(descriptionCap('Standard deadlines from the entities’ master data.', true).rest).toBe(null);
        });

        await it('splits a long description at a sentence end on a phone', async () => {
            const cap = descriptionCap(zahlungen, true);
            expect(cap.shown).toBe('Filed, but not yet recorded as paid.');
            expect(cap.rest).toBe(
                'Amounts and dates are estimated from the rules — check them against the notice and the bank statement.',
            );
        });

        await it('keeps both halves inside the budget', async () => {
            const cap = descriptionCap(zahlungen, true);
            expect(cap.shown.length).toBeLessThanOrEqual(DESCRIPTION_LINE_CHARS * 2);
            expect(cap.rest?.length).toBeGreaterThan(0);
        });

        await it('falls back to a word boundary with its own ellipsis when no sentence ends there', async () => {
            const text = `${'word '.repeat(20)}tail-more`;
            const cap = descriptionCap(text, true);
            expect(text.length).toBeGreaterThan(DESCRIPTION_LINE_CHARS * 2);
            expect(cap.shown.endsWith('…')).toBe(true);
            expect(cap.rest?.startsWith('word')).toBe(true); // cut at a space, never mid-word
            expect(cap.rest?.endsWith('tail-more')).toBe(true);
        });
    });

    await describe('phone-rules: middleEllipsis (step 8b path rows)', async () => {
        const path = '/home/jumplink/.local/share/eu.jumplink.Steuererklaerung/backups/2026-10-20T09-37-41-476Z';

        await it('leaves a value that fits on one line whole', async () => {
            expect(middleEllipsis('/home/demo/backups')).toBe('/home/demo/backups');
        });

        await it('keeps both ends of a long path', async () => {
            const cut = middleEllipsis(path);
            expect(cut.length).toBeLessThanOrEqual(PATH_LINE_CHARS);
            expect(cut.startsWith('/home/jumplink')).toBe(true);
            expect(cut.endsWith('-476Z')).toBe(true);
            expect(cut.includes('…')).toBe(true);
        });

        await it('stays within one line for any budget', async () => {
            for (const budget of [4, 5, 6, 20, PATH_LINE_CHARS]) {
                expect(middleEllipsis(path, budget).length).toBeLessThanOrEqual(budget);
            }
        });
    });

    await describe('phone-rules: step 8 reports table', async () => {
        const june = new Date(2025, 5, 15);

        await it('starts the first month column at zero', async () => {
            expect(bwaMonthColumnStart(0, 80, 24)).toBe(0);
        });

        await it('spaces month columns by width plus spacing', async () => {
            expect(bwaMonthColumnStart(1, 80, 24)).toBe(104);
            expect(bwaMonthColumnStart(2, 80, 24)).toBe(208);
            expect(bwaMonthColumnStart(6, 80, 24)).toBe(624);
        });

        await it('defaults to the current month when it exists in the data', async () => {
            expect(bwaDefaultMonth([1, 3, 6, 12], june)).toBe(6);
        });

        await it('falls back to the nearest previous month', async () => {
            expect(bwaDefaultMonth([1, 3, 5, 12], june)).toBe(5);
            expect(bwaDefaultMonth([1, 2, 3], june)).toBe(3);
        });

        await it('falls back to the first month when the year has not reached the current one', async () => {
            expect(bwaDefaultMonth([7, 8, 9], june)).toBe(7);
        });

        await it('falls back to the current month for empty data', async () => {
            expect(bwaDefaultMonth([], june)).toBe(6);
        });

        await it('sorts unsorted month lists', async () => {
            expect(bwaDefaultMonth([12, 6, 1], june)).toBe(6);
        });

        await it('aligns a month column to the left edge of the viewport', async () => {
            expect(bwaMonthScrollTarget({ start: 400, value: 0, page: 300, upper: 800 })).toBe(400);
        });

        await it('does nothing when the column is already aligned', async () => {
            expect(bwaMonthScrollTarget({ start: 400, value: 400, page: 300, upper: 800 })).toBeNull();
        });

        await it('does nothing when the content fits', async () => {
            expect(bwaMonthScrollTarget({ start: 100, value: 0, page: 300, upper: 300 })).toBeNull();
            expect(bwaMonthScrollTarget({ start: 100, value: 0, page: 0, upper: 800 })).toBeNull();
        });

        await it('clamps to the scrollable range', async () => {
            const max = 800 - 300;
            expect(bwaMonthScrollTarget({ start: -50, value: 100, page: 300, upper: 800 })).toBe(0);
            expect(bwaMonthScrollTarget({ start: 900, value: 0, page: 300, upper: 800 })).toBe(max);
        });
    });
};
