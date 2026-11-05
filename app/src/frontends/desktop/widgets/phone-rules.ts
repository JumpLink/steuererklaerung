/**
 * The phone layout rules from `docs/app/mobile-layout.md`, as arithmetic.
 *
 * No `gi://` import belongs in this file, and that is not tidiness — `dev/check-test-bundle.js`
 * fails the build if a test drags `Gtk` or `Adw` into the bundle, because CI runs the suite in a
 * container with no desktop stack. The widget side of each rule lives in `responsive.ts` and
 * `views/util.ts`; the decision lives here, where it can be tested on numbers.
 *
 * Every rule answers the same shape of question: given what is in a container and whether the
 * window is phone-sized, what should the container do? Keeping that separate from the GTK calls
 * also means a rule can be read without knowing GTK — which is the point of writing them down in
 * a design document in the first place.
 */

/**
 * The HIG's minimum for anything tappable, in logical pixels.
 *
 * Today's icon-only suffix buttons (the trash, the pencil) render at 32 — fine for a pointer, and
 * a quarter of a thumb too small. Only applied on a phone: a 48 px button in a desktop list row
 * would change every row's height.
 */
export const TOUCH_TARGET = 48;

/** Minimum gap between two adjacent targets, so a thumb cannot hit both. */
export const TOUCH_GAP = 12;

/**
 * How many KPI cards per line.
 *
 * At 360 px a one-up card takes the full width, so Overview's five cards fill the first screen and
 * then some before any list appears. Two-up costs ~180 px for four cards instead of ~500, and a
 * number with a short caption needs about 160 px — which is exactly what 360 minus margins gives
 * you twice.
 *
 * A single card stays full width: one per row is right when there is one. Two-up is a floor AND a
 * ceiling on a phone (`min === max`), because a flow box with a higher maximum will happily fit
 * three narrow cards and make the numbers unreadable.
 */
export function kpiColumns(count: number, narrow: boolean, max: number): { min: number; max: number } {
    if (!narrow) return { min: 1, max };
    if (count <= 1) return { min: 1, max: 1 };
    return { min: 2, max: 2 };
}

/**
 * Which children of a row's action cluster move into an overflow menu.
 *
 * `kinds` is the cluster's children in order: `'action'` for something you press, `'static'` for an
 * amount or a badge that is only there to be read. Returns the indices to collapse, in order, and
 * an empty array when nothing should move.
 *
 * Two actions is the threshold. Wrapping is the right desktop answer and the wrong phone answer —
 * Contacts grew every row to three lines because `Supplier` and `Delete` stacked under each other
 * — but a menu holding a single item is a tax on the common case, so one action stays a button.
 *
 * Static children never move. An amount in a menu is an amount nobody reads, and the badges are
 * what make a contact row scannable.
 */
export function actionOverflow(kinds: readonly ('action' | 'static')[], narrow: boolean): number[] {
    if (!narrow) return [];
    const actions = kinds.flatMap((kind, index) => (kind === 'action' ? [index] : []));
    return actions.length > 1 ? actions : [];
}

/** A chip's extent inside the scrolled content, and the window currently shown. */
export interface ChipScroll {
    /** Chip offset from the start of the content. */
    start: number;
    /** Chip width. */
    size: number;
    /** Current scroll position. */
    value: number;
    /** Visible width. */
    page: number;
    /** Total content width. */
    upper: number;
}

/**
 * Where to scroll so a chip is fully visible, or `null` when it already is.
 *
 * Selecting a filter off-screen is the case this exists for: Contracts' row
 * (`All · Active · Deadline near · Archived`) is wider than 360 px, and a selection made by any
 * route other than tapping — restoring a view, following a link — left the active chip out of
 * sight with nothing to suggest it existed.
 *
 * The chip is brought in with {@link TOUCH_GAP} of slack, so the neighbour beside it peeks into
 * view: a chip flush against the edge looks like the end of the row even when it is not. The
 * result is clamped to the scrollable range, which also means the slack silently disappears at
 * either end rather than fighting the adjustment.
 */
export function chipScrollTarget({ start, size, value, page, upper }: ChipScroll): number | null {
    if (page <= 0 || upper <= page) return null;
    const max = upper - page;
    const clamp = (v: number): number => Math.max(0, Math.min(max, v));

    if (start < value) return clamp(start - TOUCH_GAP);
    const end = start + size;
    if (end > value + page) return clamp(end + TOUCH_GAP - page);
    return null;
}

/**
 * Which edges of a scroller should fade, given its adjustment.
 *
 * The chip rows reach the right edge of the screen with nothing to say more exists — the single
 * most common way a horizontal scroller goes unnoticed. A fade on the side that has content off
 * screen is Adwaita's own answer (`.undershoot-start` / `.undershoot-end`).
 *
 * One pixel of tolerance, because an adjustment lands on 0.9999 often enough: a fade that flickers
 * at the end of a scroll is worse than no fade.
 */
export function undershoot(value: number, page: number, upper: number): { start: boolean; end: boolean } {
    if (page <= 0 || upper <= page + 1) return { start: false, end: false };
    return { start: value > 1, end: value < upper - page - 1 };
}

/** Where each of a view's declared header actions goes. */
export interface HeaderActionPlan {
    /** Index of the action that becomes the header's `+` button, or `null` for none. */
    button: number | null;
    /** Indices of the actions that go into the header's overflow menu, in declared order. */
    menu: number[];
}

/**
 * Which of a view's declared actions the content header shows, and as what.
 *
 * `kinds` is the view's actions in declared order. The FIRST `'primary'` becomes the `+` button;
 * everything else — including any further `'primary'` — goes to the menu, because the header has
 * one button's worth of room and silently dropping an action a view declared is worse than putting
 * it one tap deeper.
 *
 * Nothing at all on a desktop: the actions are still in the view's own toolbar there, where they
 * read with their captions, and a second copy in the header would be two ways to do one thing.
 */
export function headerActionPlan(kinds: readonly ('primary' | 'secondary')[], narrow: boolean): HeaderActionPlan {
    if (!narrow) return { button: null, menu: [] };
    const button = kinds.indexOf('primary');
    return {
        button: button === -1 ? null : button,
        menu: kinds.flatMap((_kind, index) => (index === button ? [] : [index])),
    };
}

/**
 * The text of the phone header's context button, or `null` when the header keeps its view title.
 *
 * On a phone the entity card and the year selector live a page away in the sidebar, so a content
 * page would otherwise never say whose books and which year its numbers belong to. The button
 * answers that in the header's own space: `Fischer & Weber GbR · 2025`.
 *
 * `null` on a desktop (the sidebar is on screen, so repeating it would only crowd the title) and
 * while no entity is loaded yet (a button reading ` · 0` would be worse than the plain title).
 */
export function contextTitle(entityName: string | null | undefined, year: number, narrow: boolean): string | null {
    if (!narrow || !entityName) return null;
    return year > 0 ? `${entityName} · ${year}` : entityName;
}
