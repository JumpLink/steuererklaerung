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

import type { HomeCounts } from '../../../core/elster/home.ts';
import type { NavViewId } from '../nav.ts';

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

/** The largest number a nav badge spells out; above it the row says `99+`. */
export const BADGE_CAP = 99;

/**
 * The text of a nav row's badge, or `null` when the row shows none.
 *
 * Zero hides the badge: a row full of `0`s trains the eye to skip the column, and then the one `3`
 * that matters is skipped too. The cap keeps the badge a fixed, narrow width — on a phone the
 * subtitle beside it is the line that would otherwise lose a word to a four-digit count.
 */
export function badgeLabel(count: number): string | null {
    const n = Math.floor(count);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > BADGE_CAP ? `${BADGE_CAP}+` : String(n);
}

/**
 * Which nav row each of the Overview's open-work counts belongs to, summed per row.
 *
 * The mapping follows where the matching "Up next" task sends you: „Zu prüfen", refund candidates
 * and recurring costs all open Transactions; overdue invoices and suspected double payments open
 * Invoices; open declaration deadlines open Deadlines. A row with no open work is absent, so the
 * caller can clear every other row's badge by looking only at this result.
 *
 * Not mapped: Receipt inbox and Contracts. Their numbers are not part of the Overview's model, and a
 * second computation beside it would be exactly the drift the shared model exists to prevent.
 */
export function navBadgeCounts(counts: HomeCounts): Partial<Record<NavViewId, number>> {
    const all: Partial<Record<NavViewId, number>> = {
        transactions: counts.zuPruefen + counts.erstattungen + counts.laufendeKosten,
        rechnungen: counts.forderungen + counts.doppelzahlung,
        fristen: counts.fristenOffen,
    };
    const out: Partial<Record<NavViewId, number>> = {};
    for (const [view, n] of Object.entries(all) as [NavViewId, number][]) {
        if (n > 0) out[view] = n;
    }
    return out;
}

/**
 * Which wording the demo banner uses.
 *
 * The desktop banner is one line at 1280 px and two at 360, and the second line is a centred button
 * that costs 110 px on every page of the app. `Adw.Banner` already puts a one-word button beside
 * its title — what breaks that on a phone is the length of both texts, so the phone gets its own
 * short msgids (a second string, not a shortened translation: the translator sees both).
 */
export function demoBannerVariant(narrow: boolean): 'full' | 'short' {
    return narrow ? 'short' : 'full';
}

/** The blocks of the Overview, top to bottom. */
export type OverviewSection = 'kpis' | 'frei' | 'tasks' | 'bars' | 'split';

/**
 * The order of the Overview's blocks.
 *
 * On a desktop the two "Free to spend" cards follow the KPI row. On a phone the KPI block is capped
 * at its four cards and the two derived figures move below *Up next* — still reachable by scrolling,
 * but the list that tells you what to do starts around 400 px instead of after three rows of
 * numbers. `tasks` is dropped when there is nothing to do, so the caller can append in order.
 */
export function overviewSections(narrow: boolean, hasTasks: boolean): OverviewSection[] {
    const order: OverviewSection[] = narrow
        ? ['kpis', 'tasks', 'frei', 'bars', 'split']
        : ['kpis', 'frei', 'tasks', 'bars', 'split'];
    return hasTasks ? order : order.filter((s) => s !== 'tasks');
}

/** One part of the recurring-invoices summary line. */
export interface RecurringSummaryPart {
    kind: 'overdue' | 'soon' | 'total';
    n: number;
}

/**
 * The parts of the phone's recurring-invoices title, e.g. `2 overdue · 2 total`.
 *
 * The expander row is the whole block on a phone, so its title has to say what is inside without
 * opening it: zero counts are left out ("0 due soon" is noise next to the one number that is not
 * zero), and the total is always last so an empty-looking line still counts the schedules.
 */
export function recurringSummaryParts(overdue: number, soon: number, total: number): RecurringSummaryPart[] {
    const parts: RecurringSummaryPart[] = [];
    if (overdue > 0) parts.push({ kind: 'overdue', n: overdue });
    if (soon > 0) parts.push({ kind: 'soon', n: soon });
    parts.push({ kind: 'total', n: total });
    return parts;
}

/**
 * How many lines a list row's subtitle may use: two on a phone, unbounded elsewhere.
 *
 * A three-line subtitle makes a 40-row list unscannable at 360 px; on a desktop the row is wide
 * enough that the subtitle rarely wraps, and capping it there would only hide text.
 */
export function phoneSubtitleLines(narrow: boolean): number {
    return narrow ? 2 : 0;
}

/**
 * Where a page's explanatory paragraph lives: as the group's description, or folded into an
 * expander row that opens on demand.
 *
 * Contacts' four-paragraph text ate the top third of a phone screen; the text is context the
 * second time you open the page, not content. No text means nothing to fold.
 */
export function explainerPlacement(narrow: boolean, hasText: boolean): 'description' | 'expander' {
    return narrow && hasText ? 'expander' : 'description';
}

/**
 * Whether a view's KPI block is a flow of cards or one collapsed expander row.
 *
 * Only for list views, whose numbers are context rather than content (Transactions). Pages that
 * ARE their numbers keep the two-up cards.
 */
export function kpiBlockMode(narrow: boolean, cards: number): 'cards' | 'expander' {
    return narrow && cards > 0 ? 'expander' : 'cards';
}

/**
 * Whether the search entry shows.
 *
 * Always on a desktop. On a phone it hides until the header menu's `Search` asks for it — and stays
 * while it holds a query, because a hidden entry that is still filtering the list is a list that
 * looks broken.
 */
export function searchVisible(narrow: boolean, requested: boolean, query: string): boolean {
    return !narrow || requested || query.trim() !== '';
}

/**
 * How much of a group's description a phone shows before an expander takes over: two lines, counted
 * in characters. 40 per line is the measured running width of a group's text at 360 px (a 360 px
 * window, the phone's twelve of margin and the row's own padding) — generous enough not to split a
 * sentence that already fits, tight enough that the cap actually caps.
 */
export const DESCRIPTION_LINE_CHARS = 40;

/**
 * The split of a group's description at the phone's two-line cap.
 *
 * `shown` stays the group's description; `rest` moves behind an expander row — Deadlines' "Filed,
 * but not yet recorded as paid …" paragraph is four lines above the first deadline at 360 px, and
 * the list is the content, not the explanation of it. On a desktop nothing splits, so the widget
 * half of this ([`cappedDescription`](../views/util.ts)) can do no wrong either.
 *
 * The cut looks for the last sentence end inside the budget, because a sentence that is ABOUT to
 * finish reads worse than a shorter first bite; with no sentence end there, it falls back to the
 * word boundary before the budget and marks the ellipsis itself — the expander then opens with
 * exactly the words the description swallowed, not with a repeated prefix. A value already shorter
 * than the budget is returned whole.
 */
export function descriptionCap(
    description: string,
    narrow: boolean,
    lineChars = DESCRIPTION_LINE_CHARS,
): { shown: string; rest: string | null } {
    if (!narrow) return { shown: description, rest: null };
    const budget = lineChars * 2;
    if (description.length <= budget) return { shown: description, rest: null };

    const period = description.lastIndexOf('. ', budget);
    if (period >= 0) {
        const end = period + 1; // keep the sentence's own full stop
        return { shown: description.slice(0, end), rest: description.slice(end).trimStart() };
    }
    // No sentence end inside the budget: cut at a word boundary and say so.
    const space = description.lastIndexOf(' ', budget - 1);
    const end = space > 0 ? space : budget;
    return { shown: `${description.slice(0, end)}…`, rest: description.slice(end).trimStart() };
}

/**
 * How many characters of one value a phone row shows: those that fit on one line, same arithmetic
 * as {@link DESCRIPTION_LINE_CHARS} but ONE line — a path in a row subtitle, like Settings'
 * backup folder, has no expander to open.
 */
export const PATH_LINE_CHARS = 40;

/** The separator {@link middleEllipsis} writes into the cut. */
const ELLIPSIS = '…';

/**
 * A value too long for a phone row: both ends kept, cut through the middle.
 *
 * `ellipsize: middle` on a label does this while the window is sized; the widget half of it
 * ([`pathSubtitle`](../views/util.ts)) works on TEXT instead — the subtitle it replaces is
 * libadwaita's private label, and cutting in text is testable without a display. The head keeps
 * the first components, the tail keeps the timestamp: the only part that differs between backups.
 */
export function middleEllipsis(value: string, lineChars = PATH_LINE_CHARS): string {
    if (value.length <= lineChars) return value;
    // One character of which pays for the separator itself; the head gets the extra because the
    // first component of a path carries more orientation than the last.
    const keep = Math.max(1, lineChars - ELLIPSIS.length);
    const head = Math.ceil(keep / 2);
    // `slice(-0)` is `slice(0)` — the whole value — so a budget that leaves no tail just cuts
    // after the head.
    const tail = Math.floor(keep / 2);
    if (tail === 0) return `${value.slice(0, head)}${ELLIPSIS}`;
    return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

/**
 * Which BWA month a phone table opens on.
 *
 * A twelve-month grid cut off at March on a 360 px screen is useless if the user has to scroll from
 * January every time. The default is the current calendar month when it exists in the data, else the
 * nearest previous month, or the first month if the year has not reached the current month yet.
 */
export function bwaDefaultMonth(months: readonly number[], today: Date = new Date()): number {
    if (months.length === 0) return today.getMonth() + 1;
    const sorted = [...months].sort((a, b) => a - b);
    const current = today.getMonth() + 1;
    if (sorted.includes(current)) return current;
    const previous = sorted.filter((m) => m < current);
    if (previous.length > 0) return previous[previous.length - 1]!;
    return sorted[0]!;
}

/** Where to scroll a phone BWA table so a month column starts at the left edge of the viewport. */
export interface BwaMonthScroll {
    /** Column offset from the start of the scrollable content. */
    start: number;
    /** Current scroll position. */
    value: number;
    /** Visible width. */
    page: number;
    /** Total content width. */
    upper: number;
}

/**
 * Left edge of a BWA month column, given uniform column widths.
 *
 * A phone table makes the month columns homogeneous so every column has the same width; the scroll
 * target is then the column index times (width + spacing). Keeping the arithmetic here makes the
 * offset testable and avoids relying on `compute_bounds`, whose result depends on allocation timing
 * and can include the previous column's right edge when the label is right-aligned.
 */
export function bwaMonthColumnStart(index: number, columnWidth: number, columnSpacing: number): number {
    if (index <= 0) return 0;
    return index * (columnWidth + columnSpacing);
}

/**
 * Scroll target that aligns a BWA month column to the left edge.
 *
 * Unlike {@link chipScrollTarget} this does not merely bring the cell into view — tapping a month
 * chip should land that month at the start of the scrollable area, so the frozen item column stays
 * beside the month the user asked for.
 */
export function bwaMonthScrollTarget({ start, value, page, upper }: BwaMonthScroll): number | null {
    if (page <= 0 || upper <= page) return null;
    const max = upper - page;
    const target = Math.max(0, Math.min(max, start));
    if (target === value) return null;
    return target;
}

/** How the receipt inbox adapts its chrome at a given width. */
export interface ReceiptInboxLayout {
    /** Show the queue toggle in the window header. */
    showHeaderToggle: boolean;
    /** Pin the Check & confirm buttons in a bottom action bar. */
    pinActionBar: boolean;
    /** Re-open the queue after confirming a receipt. */
    reopenQueueAfterConfirm: boolean;
}

/**
 * Receipt-inbox mobile layout decisions.
 *
 * The view's own `Adw.OverlaySplitView` collapses at 500 px (content pane), so the queue toggle has
 * to be reachable whenever that happens — including the 481–500 px band where the window itself is
 * not yet phone-sized. The action bar and the auto-reopen are phone-only (≤480 px window), because
 * they change the desktop layout.
 */
export function receiptInboxPhoneLayout(narrow: boolean, splitCollapsed: boolean): ReceiptInboxLayout {
    return {
        showHeaderToggle: splitCollapsed,
        pinActionBar: narrow,
        reopenQueueAfterConfirm: narrow,
    };
}
