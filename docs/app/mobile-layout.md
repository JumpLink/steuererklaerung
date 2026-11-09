# Phone layout — design specification

How the GTK-4/libadwaita front-end (`app/src/frontends/desktop`) should behave on a phone-sized
window: roughly **360 × 760 logical pixels**, the GNOME reference for mobile.

This is a **design document, not a change log**. It describes the target; nothing here is
implemented yet unless a section says so. The desktop layout at wide widths is unchanged by every
proposal below — each one hangs off a breakpoint that never fires on a desktop window.

- **Measured against the real app.** Every finding comes from a screenshot of the demo entity at
  360 × 760 and the same view at 1280 × 860, taken with `app/dev/screenshot.sh`. Reproduce them
  with `STEUER_SHOT_SIZE="360 760"`; see [the screenshot section of the tour](README.md#die-bilder-neu-erzeugen).
- **Binding reference:** the [GNOME HIG](https://developer.gnome.org/hig/) and the libadwaita
  adaptive widgets (1.9 is what we build against). Where the HIG leaves a question open, this
  document borrows a settled answer from iOS or Material 3 and **translates it into Adwaita
  vocabulary** — the idea, never the platform's chrome.
- **Related:** the architecture of the front-end is in
  [`app/src/frontends/desktop/README.md`](../../app/src/frontends/desktop/README.md), the
  screen-by-screen tour in [README.md](README.md), the string rules in
  [i18n-status.md](i18n-status.md).

## The breakpoint ladder

Four widths, and only four. A new breakpoint needs a reason that one of these cannot carry.

| Name | Condition | What changes |
|------|-----------|--------------|
| **Wide** | `min-width: 1180px` | The assistant docks beside the content at 390 px. *(exists today)* |
| **Desktop** | — (default) | Sidebar beside content, assistant as an overlay. |
| **Collapsed** | `max-width: 720px` | The `Adw.NavigationSplitView` collapses: the section list becomes the root page of a navigation stack. *(exists today)* |
| **Phone** | `max-width: 480px` | Everything Collapsed does, **restated**, plus: one column everywhere; KPI cards become a two-up grid; row actions collapse into a menu; the view's own toolbar scrolls. *(exists today, step 1)* |

**The ladder is not cumulative, and the order in `window.blp` is load-bearing.** This table used to
read bottom-up and imply that Phone stacks on top of Collapsed. It does not:
`adw_breakpoint_bin_size_allocate` walks the breakpoints in **reverse order of addition** and stops
at the **first** whose condition holds, so exactly one rung is ever in force and
`current-breakpoint` is a single breakpoint. Two consequences, both now enforced by
`gjsify run check:breakpoints` (`app/dev/check-breakpoints.js`, unit-tested in
`tests/unit/desktop/breakpoint-order.test.ts`):

- **Every rung restates what it needs.** Phone repeats `split_view.collapsed: true`; Collapsed's
  setters do not reach it.
- **`max-width` rungs are declared widest first, narrowest last** (and `min-width` rungs the other
  way round). The phone rung written above the 720 px one compiles, builds and runs — and a 360 px
  window simply matches `max-width: 720px` first and keeps the wider layout, which reads like a bug
  in the view rather than in the template.

Views do not re-derive this. The window exposes a read-only **`narrow`** property, fed by the named
`phone_breakpoint` rung, and a view subscribes with `onNarrow()` from
[`widgets/narrow.ts`](../../app/src/frontends/desktop/widgets/narrow.ts) — which waits for the
widget to be rooted, because a view is built before it is added to the window.

**The in-view breakpoints are a different measurement and keep their own numbers.** The
`Adw.BreakpointBin` conditions inside the views (`max-width: 450px` in most `.blp` files) measure
the **content pane**, which is only 537 px wide inside a 1280 px desktop window — not the window.
A view-local condition of 560 px would fire on a perfectly ordinary desktop. Whenever a rule below
says "phone", it means the **window** is narrow; whenever it names a view-local pane width, it
means the pane. Mixing the two is the single easiest way to break the desktop from a mobile
change.

## The navigation model

### Decision

**The phone keeps the collapsed `Adw.NavigationSplitView`: the thirteen-item section list becomes
the root page of the navigation stack, and a section is a page pushed on top of it.** No bottom
tab bar. The work goes into making that root page worth landing on, and into giving every content
page the context the sidebar used to supply.

### Why not a bottom tab bar

An `Adw.ViewSwitcherBar` across the bottom is the obvious transfer from iOS's tab bar and
Material's navigation bar, and it is the wrong shape here:

- **Thirteen sections do not fit five slots.** A tab bar tops out at five before the labels
  ellipsize, so eight sections would land behind a "More" entry — and they are not the forgettable
  eight. Deadlines, Tax and Contracts are exactly the sections that carry a date you must not
  miss. Burying the dated work behind a generic label to keep the undated work one tap away
  inverts the app's own priorities.
- **The set is not fixed.** `visibleNavItems` in [`nav.ts`](../../app/src/frontends/desktop/nav.ts)
  hides the purely business sections for a `privat` entity, and shows **Tax** only when an ELSTER
  or income-tax configuration exists. A tab bar whose tabs appear and disappear when you switch
  entity is a tab bar you cannot build muscle memory for; a list that grows and shrinks is just a
  list.
- **It would cost a structural rewrite for nothing.** `Adw.ViewSwitcherBar` needs an
  `Adw.ViewStack`; the window holds a plain `Gtk.Stack` (`window.blp`), and the views are added
  imperatively from `window.ts`. Converting that is a real refactor of the part of the window that
  three other workstreams touch — and it buys one tap.
- **The HIG already answers this.** The collapsed split view *is* the GNOME pattern for a sidebar
  with many sections, and it is what every GNOME app with a long sidebar does. Bottom switchers
  are for the handful-of-peers case (Clocks, Weather), not for an index.

### What the decision costs, and the three things that pay for it

Collapsing has a real price, visible in the screenshots: **a content page on a phone shows a back
arrow and nothing else of the app's structure.** The entity card and the year selector live in the
sidebar, so on a phone the answer to "whose books, which year?" is one page away from every number
on screen. Three additions settle that.

**1. The section list becomes a real home, not a menu.** Rows keep their title and subtitle and
gain a **badge on the right** with the number that makes the section urgent: receipts to check,
bookings to review, overdue invoices, deadlines inside the notice period. The count is what
`home-view` already computes for *Up next*; here it just sits where you choose. This is Material's
navigation-drawer badge and iOS's inset-grouped list with trailing detail text, in an Adwaita
`Adw.ActionRow` with a `.numeric` suffix label — no new widget, no new colour.

**2. A context button in every content header.** Where the desktop header shows the view title, the
phone header's title widget becomes a `Gtk.MenuButton` reading `Fischer & Weber GbR · 2025`, which
opens an `Adw.Dialog` (a bottom sheet at this width) holding the same `BhEntitySwitcher` and
`BhYearSwitcher` widgets the sidebar uses. One tap to see the scope, two to change it, from
anywhere. This is the iOS "title as a picker" idea; the Adwaita form is the dropdown title, which
GNOME apps already use for a document or a mailbox.

**3. The app reopens where you left it.** With the list as root, a cold start that always lands on
*Overview* means one extra tap on every launch for anyone who lives in *Receipt inbox*. Persist
the last `NavViewId` per entity in `GSettings` and push that page on top of the list at startup —
back still goes to the list, so nothing is hidden.

**Gestures.** `Adw.NavigationView` gives back-swipe from the left edge for free once the split
view is collapsed; it needs no code and must not be disabled by a horizontally scrolling child at
the edge. Sub-tab pages inside a section (Receipt inbox, Tax) are **not** navigation pages — they
stay in their `Adw.ViewStack`, so the back gesture always means "leave this section", never
"previous tab". That consistency is worth more than the swipe-between-tabs gesture iOS offers.

## Shared building blocks

These recur on most pages. Each is one helper, built once, used everywhere — the alternative is
thirteen slightly different answers to the same question.

### KPI cards — two-up, not one-up

Today `kpiFlow` ([`views/util.ts`](../../app/src/frontends/desktop/views/util.ts)) wraps
`kpiCard`s in a `Gtk.FlowBox`. At 360 px every card takes the full width, so a view with five
cards (Overview) spends **the entire first screen and then some** on numbers before any list
appears — the phone shots of Overview, Transactions, Contracts and Reports all show it.

On a phone, cards go **two per row** and the caption wraps instead of being clipped. Four cards
then cost ~180 px instead of ~500, and the list below them starts above the fold. The mechanism
is the flow box's own `min-children-per-line: 2` under the phone breakpoint; no new widget.

Where a view has a single headline figure (Time's running timer, Receipt inbox's count), it stays
full width — one card per row is right when there is one card.

*Built, with two corrections to the paragraph above.* The value step `title-1` → `title-2` was
already stale when this was written: `kpiCard` has used `title-2` since the app shipped, so there
is nothing to scale down. And clipping the caption is the wrong half of the pair — an ellipsizing
label has a tiny minimum but keeps its full NATURAL width, which is what sets the flow box's
column. Overview's captions go through `wrappingLabel` instead; with clipping the window still
demanded 486 px and the view cut off at 360.

Overview needed one further change to reach two-up: the 90 px sparkline in the revenue card is
**hidden while the window is narrow**. It is a trend at a glance, not a number, and at half width
it is the single widest thing in the card.

*Borrowed from:* iOS's two-column widget grid and Material's compact metric tiles. Both settled on
two columns at this width for the same reason: a number plus a short caption needs about 160 px,
and 360 minus margins gives you exactly two of those.

### Row actions — menu, not buttons

`rowActions` already puts suffix buttons in an `Adw.WrapBox` so they wrap instead of clipping.
Wrapping is the right desktop answer and the wrong phone answer: the Contacts shot shows every row
grown to three lines because `Supplier` and `Delete` stacked under each other, and the Accounts
shot shows a full-width `Sync` button sitting inside a card.

On a phone, a row with **more than one** action collapses its actions into a single
`Gtk.MenuButton` with `view-more-symbolic`, 48 × 48, opening a `Gtk.PopoverMenu`. The row then has
one line of text, one trailing control, and a predictable height. A row with exactly one action
keeps it as a button — a menu containing one item is a tax on the common case.

`pinnableCluster` already carries the narrow/wide switch; this is the same switch with a third
state, so the call sites do not change.

*Built, with three deviations.* **The popover is a plain `Gtk.Popover` of flat buttons with the
`.menu` style class, not a `Gtk.PopoverMenu`.** A `Gtk.PopoverMenu` needs a `Gio.MenuModel`, which
needs every entry to be a named `Gio.Action`; all five call sites connect closures to `clicked`.
Rewriting five views' row actions into action groups is a change of its own, and the plain popover
is visually identical.

**The collapse is not driven by the view's `narrow` flag** but by the window's `narrow` property
via `onNarrow`. The flag the call sites pass comes from an in-view `Adw.BreakpointBin`, which
measures the content pane — 537 px inside a 1280 px window — so a desktop user with a narrow
sidebar would get a phone's menu.

**Rows with no desktop pinning call the phone half directly.** `pinnableCluster` is about keeping a
multi-button cluster on one line; Contacts rows have a single `Delete` button and never needed it,
so the 48 px target would never have been applied there. The phone half is exported as
`phoneRowActions` for exactly that case.

*Borrowed from:* iOS's trailing ellipsis button and Material's overflow menu. Deliberately **not**
borrowed: swipe-to-delete. There is no Adwaita idiom for it, it hides destructive actions behind
an undiscoverable gesture, and the rows here delete tax-relevant records.

### Filter chips — one scrolling row

`chipScroller` ([`widgets/responsive.ts`](../../app/src/frontends/desktop/widgets/responsive.ts))
already wraps chip rows in a horizontally scrolling box. On a phone that stays, with two
corrections visible in the shots: the Contracts row (`All · Active · Deadline near · Archived`)
and the Transactions row both reach the right edge with no sign that more exists, and neither
shows the selected chip first when the selection is off-screen.

The phone rule: chips scroll horizontally in **one** row, never wrap to two; the scroller gets a
fade at both edges when content overflows; and selecting a chip scrolls it into view. The row sits
**directly above the list it filters** and scrolls away with the content — a filter row pinned to
a 760 px viewport spends screen space on a control you touch once.

*Borrowed from:* Material 3's filter chips, which are the same shape and the same scroll
behaviour. The fade is Adwaita's own (`.undershoot-start` / `.undershoot-end`).

### Primary action — one header-bar button

Several views end their toolbar with a full-width suggested-action button: `New contract`,
`New invoice`, `Add a contact`, `Add account`. Stacked with the chips and the export button above
them, the Contracts shot spends 140 px of a 760 px screen on buttons before the first contract.

On a phone, the **single most important creating action** of a view becomes an
`Adw.HeaderBar` end button with a `+` icon — not a floating overlay. GNOME puts the primary
creating action in the header bar, and the header bar is already there, already 48 px tall,
already reachable. Secondary actions (`Export deadlines`, `Import`) move into the header's
`view-more-symbolic` menu.

*Borrowed from:* the FAB's **premise** — one action per screen deserves permanent placement — not
its form. An Adwaita app with a circular overlay button would look like a port.

*Built, with five deviations.* **A view declares, it does not build.** `PortedView` grows an
optional `headerActions(): ViewAction[]`, where a `ViewAction` is a label, an optional icon, a
`primary` flag and a closure. The window asks and renders; `headerActionPlan` in
[`widgets/phone-rules.ts`](../../app/src/frontends/desktop/widgets/phone-rules.ts) decides which
one becomes the `+` button and which go to the menu, and is testable without a display. A view
handing over widgets would make that decision untestable and put the header's look in thirteen
places.

**The toolbar buttons are hidden, not moved** — `hideOnPhone` in `responsive.ts`, the same
subscription shape as the row collapse, for the same reason: a toolbar is rebuilt on reload, not
on resize, so a build-time skip would leave a window dragged narrow with whatever width it was
born with. The secondary menu entries then *drive those hidden buttons* rather than calling the
action a second time: `Import` and `Check connections` disable themselves while they run and
re-enable on failure, and a copy of that state machine for the menu is the copy that drifts.

**A hub forwards to its visible tab.** The window only ever talks to the nav entry, and four of
the nine entries are `BhTabHub`s — so Invoices, the one overlap this step is named after, could
not reach the header at all without `BhTabHub.headerActions()` passing the active tab's answer
through and firing `headerActionsChanged` on a tab switch. That helper exists for the same class
of problem: Invoices only knows whether the back-end can create a draft after it has loaded the
entity's capabilities, so the answer has to be re-asked rather than cached.

**Accounts keeps the `Add account` button in its empty state.** The rule removes buttons that
crowd a list; a page with no accounts is nothing but that invitation. The menu is a plain
`Gtk.Popover` with `.menu` again, sharing one `menuItem` factory with the row overflow — the two
menus are the same surface at two sizes.

**Contacts gets its section title back.** `kontakte-view.blp` carried a `max-width: 450px` rung
that blanked `All contacts`, because the title shared that row with `Add a contact` and `Import`
and lost — it was allocated its ellipsis and nothing else, so the section read "…". With both
actions in the window header the row is the title's alone, and blanking it leaves a 70 px empty
band instead. The rung is gone; the `Adw.BreakpointBin` stays for its size request.

### Dialogs — already right, two fixes

Every dialog the app opens is an `Adw.Dialog`, which libadwaita presents as a **bottom sheet**
below 450 px on its own. The seven phone dialog shots confirm it: Transaction detail, Edit
receipt, Invoice detail, Add account and Set up entity all arrive as sheets with a drag handle and
swipe-down dismissal, with no mobile-specific code.

Two things need attention:

1. **The sheet opens at full height.** `Add account` has three rows and still covers the screen.
   Short dialogs should size to their content and leave the page visible behind them, which is
   what the sheet's own `content-height: -1` does once the inner `Gtk.ScrolledWindow` stops
   claiming `vexpand`.
2. **Header buttons clip.** `Classificatio…` in the Transaction-detail shot is a header label
   losing to two buttons beside it. Inside a sheet, a group header and its actions follow the same
   rule as rows: one line of text, actions in a menu.

### Touch targets and spacing

- **48 × 48 minimum** for anything tappable, per the HIG. Today's icon-only suffix buttons
  (`Delete` trash, `Edit` pencil) render at 32 px. On a phone they get `48` width/height requests.
- **12 px** between adjacent targets so a thumb cannot hit both.
- **Side margins 12 px**, not the desktop's 18 — at 360 px, 36 px of margin is a tenth of the
  screen.
- `Adw.Clamp` stays at its desktop maximum; it simply never clamps at this width.

## Page by page

Each entry: what the 360 px shot shows today, what the phone layout should be, and which widget
carries it. Sections marked *no change* already behave; they are listed so the sweep is complete.

### 1. Overview (`home`)

**Today:** five KPI cards one-up fill the whole viewport; *Up next* — the list that tells you what
to do — starts below the fold, after the demo banner has taken 110 px.

**Phone:** cards two-up (above); the KPI block capped at **four** cards with the rest reachable by
scrolling, so *Up next* begins around 400 px. *Up next* rows keep their warning icon, title and
one-line subtitle and get the 48 px chevron.

The **demo banner** is the other half of this: at 1280 px it is one line, at 360 px it wraps to
two and adds a centred button, costing 110 px on every page of the app. On a phone it becomes a
one-line `Adw.Banner` with its button as the banner's own action ("Use my own data" → "My data").

*Borrowed from:* iOS's widget stack — the summary is two-up and the actionable list is the page.

### 2. Receipt inbox (`review`)

**Today:** the best-behaved view. The inner `Adw.OverlaySplitView` collapses, the queue hides
behind a toggle button, and the detail fills the page. The `Adw.InlineViewSwitcher`
(`Inbox · Open receipts · All receipts`) scrolls.

**Phone:** keep the structure; two corrections. The queue toggle is a bare 32 px icon floating
above the content with no label — it becomes a header-bar toggle with `sidebar-show-symbolic` at
48 px. And when a receipt is confirmed, the overlay should **re-open the queue** so the next item
is in reach, which is the one-handed version of the desktop's "the list is always there".

The `Check & confirm` action area at the bottom of the detail becomes a pinned
`Gtk.ActionBar` — this is the one place where pinning is right, because it is the action the page
exists for and the page scrolls past it.

*Borrowed from:* Mail's list/detail collapse on iOS, which is also what `OverlaySplitView` is.

### 3. Transactions (`transactions`)

**Today:** switcher, four KPI cards one-up, search entry, four filter chips — the first
transaction is roughly 900 px down, past the bottom of the screen.

**Phone:** KPI cards two-up and **collapsed into an `Adw.ExpanderRow`** labelled with the balance,
closed by default. Transactions is a list view; its numbers are context, not content. Search stays
a `Gtk.SearchEntry` but moves into a `Gtk.SearchBar` toggled from the header bar, which is the
GNOME pattern and reclaims 60 px. Chips directly above the list.

Row text (`Jahresabschluss` / `31.12.2025 · AfA · 4830 Abschreibungen`) already wraps via
`boundRowText`; on a phone the subtitle is capped at two lines with ellipsis — a three-line
subtitle makes a 40-row list unscannable.

### 4. Invoices (`rechnungen`)

**Today:** the worst overlap in the sweep — the `New invoice` button floats over the filter chips,
hiding `Overdue`. Three KPI cards, a recurring-invoices block with two full-width
`Create draft` buttons, then the list.

**Phone:** `New invoice` moves to the header bar (above), which removes the overlap outright.
KPI cards two-up. The recurring block becomes an `Adw.ExpanderRow` titled with its summary
("2 overdue · 2 total"), so the page opens on the invoice list.

### 5. Time (`zeiten`)

**Today:** already close. The timer reads 00:00:00 at `title-1`, the `Adw.WrapBox` form stacks its
four controls into three rows, unbilled entries and tracked time follow.

**Phone:** the timer block is the one full-width card. The form keeps wrapping but the project
dropdown and the label entry share a row at 360 px (they fit: 140 + 190). The play button stays 48
px and moves to the end of the description row, which it already does.

`Invoice` buttons on unbilled rows are a single action — they stay buttons, per the row rule.

### 6. Contacts (`kontakte`)

**Today:** a four-paragraph explanatory text eats the top third; `Add a contact` and `Import` sit
above the list; every row is three lines tall because `Supplier` and `Delete` stacked.

**Phone:** the explanation becomes a `Gtk.Label` inside an `Adw.ExpanderRow` ("What is this?"),
collapsed. `Add a contact` to the header bar, `Import` to its menu *(done, step 3 — and `All contacts` stays,
see there)*. Row actions to a menu (above),
which returns rows to two lines with the avatar, name, and the open amount as a suffix.

*Borrowed from:* iOS Contacts — avatar, name, one detail, nothing else.

### 7. Reports (`auswertungen`)

**Today:** four KPI cards, then the BWA table — a twelve-month grid that is **cut off at March**
with no indication that nine more months exist.

**Phone:** the table is the hard case, and a 12 × 10 grid genuinely does not fit 360 px. Two
changes, in order:

1. The table scrolls horizontally with the **item column frozen** (`Gtk.ScrolledWindow` plus a
   sticky first column), so a row stays identifiable while you scroll months.
2. Above it, a month `chipScroller` jumps the scroll position, and the default position is the
   **current month**, not January.

The insights list below needs nothing beyond the row rules.

*Borrowed from:* Material's data-table guidance for compact widths (freeze the identifying column,
scroll the rest) — the only honest answer for a wide table on a narrow screen.

*Built (step 8), with deviations.* The desktop table stays a single horizontally-scrolling card;
the phone path builds two `Gtk.Grid`s inside a horizontal box, with the left grid frozen and the
right grid inside a `Gtk.ScrolledWindow`. Row heights are kept in sync with a vertical
`Gtk.SizeGroup`. The month chip row uses the existing `chipScroller`; tapping a chip scrolls the
table so that month starts at the left edge of the viewport, via `bwaMonthScrollTarget()` in
`widgets/phone-rules.ts`. The default month rule (current month, nearest previous, or first) is
likewise in `phone-rules.ts` as `bwaDefaultMonth()` and is unit-tested.

### 8. Deadlines (`fristen`)

**Today:** works. Three grouped lists, each row with a date, a relative hint and one action.

**Phone:** *no structural change.* Only the shared rules: 48 px for `Paid` / `Filed`, and the
group descriptions ("Filed, but not yet recorded as paid. Amounts and dates are estimated …")
capped at two lines with the rest behind the expander, because at 360 px that paragraph is four
lines above the first deadline.

### 9. Tax (`steuer`)

**Today:** four sub-tabs in a scrolling switcher; the EÜR tab is a clean boxed list; the USt-VA
tab is readable. The unclassified-bookings banner wraps to two centred lines.

**Phone:** keep the tabs in the `Adw.ViewStack`. The EÜR figure rows are already
title-plus-value-plus-chevron, which is the right phone row. The download icon next to
"Anlage EÜR 2025" is 32 px and moves to the header bar.

Long notice texts in USt-VA ("1 payment to Serverhaus … went to an IBAN never paid before") stay full
— this is the one place where truncation would hide the reasoning, and the HIG's advice to
summarise loses to the app's own rule that every figure carries its derivation.

### 10. Projects (`projekte`)

**Today:** explanation paragraph, one KPI card, `+ Add a project` beside a heading, two rows.
Half the screen is empty.

**Phone:** explanation into an expander, `Add a project` to the header bar. With two projects the
page is short — the empty state below the list is the right place for the explanation, via the
existing `emptyState` helper.

### 11. Contracts (`vertraege`)

**Today:** four KPI cards one-up (500 px), chips, `Export deadlines`, `New contract` — **not a
single contract is visible on the first screen.**

**Phone:** the sharpest case for the shared rules, and they are enough: cards two-up (180 px),
`New contract` to the header bar, `Export deadlines` to the header menu, chips directly above the
list. The first contract then sits around 320 px, above the fold.

### 12. Accounts (`konten`)

**Today:** `Add account` is a full-width pill under the heading; each connection card carries a
full-width `Sync` button and a 32 px trash icon on its own line.

**Phone:** `Add account` to the header bar. Connection cards keep their two-line identity (name,
owner · account) with the balance as a suffix; `Sync` and `Delete` go into the row menu. The
`live` / `File` badge stays — it is the one piece of state that tells you whether the number is
current.

### 13. Settings (`einstellungen`)

**Today:** the most phone-ready view — boxed lists of `Adw.ActionRow`s throughout.

**Phone:** *no structural change.* Two row-level fixes: paths like
`/home/jumplink/.local/share/eu.jumplink.Steuererklaerung/backups/2026-10-20T09-37-41-476Z` wrap
to four lines, so they get `ellipsize: middle` with the full value in the tooltip and on long
press; and `Back up now` stays full width, because it is this page's primary action and there is
no list for it to crowd.

**Built (step 6), with deviations.** Contracts needed only the banner; steps 2 and 3 had already
given it two-up KPIs, chips and header actions. Overview keeps all blocks but reorders them on a
phone (KPI cards, Up next, then the two "Free to spend" cards) via `overviewSections()`; nothing is
hidden. Invoices folds the recurring block into one `Adw.ExpanderRow` titled with its summary, driven
by the window's `narrow`, and its two row buttons fold into the row menu (`pinnableCluster`). The
banner gets a short title (`Demo data`) as well as `My data`, because the long title cannot share a
line with the button. The 48 px chevron on Up next rows was not added: the rows are fully
activatable and already at least 56 px tall.

**Built (step 7), with deviations.** Transactions folds its KPI cards into one closed
`Adw.ExpanderRow` (`Figures`, subtitled with the balance). Search hides behind the header menu's
`Search`, but through a `Gtk.Revealer` rather than a `Gtk.SearchBar`, so the desktop look stays
identical; the entry stays revealed while it holds a query. Contacts and Projects fold their
explainer into a `What is this?` expander (`explainerRow`), and all three lists cap row subtitles at
two lines (`phoneSubtitleLines`). Projects moves `Add a project` into the header bar and gives Delete
a 48 px target. Contacts rows keep their single Delete button (one action stays a button). Accounts
did not get the full row restructure (balance as suffix): live connection cards keep their layout
and get a phone-only overflow menu with Sync and Disconnect beside the balance; a file-source card
keeps its lone trash button at 48 px.

**Built (step 8b), with deviations.** Time needed no `.blp` change — the form's `Adw.WrapBox`
already puts the project dropdown and the label entry on one line at 360 px; only the Play button
gets a 48 px target on `narrow` (and `-1` again on wide). Deadlines caps each group description at
the two-line budget with `descriptionCap` (cut at the last sentence end inside the budget, word
boundary as fallback): the shown text stays as the description, the rest opens the
`More about this` expander (`explainerRow` gained a title parameter), and the `Paid`/`Filed`
suffixes sit in a `rowActions` cluster for their 48 px target. Tax (the EÜR tab) hides its
"Check PDF" header-suffix button on a phone and re-exposes it through `headerActions()` — as a
labelled item in the header menu, not a second 28 px icon; the USt/GewSt/Feststellung buttons
keep their places. Settings subtitles the backup paths through `pathSubtitle`: the cut is applied
to TEXT (`middleEllipsis`, both ends kept) because libadwaita's subtitle label is private, and the
row additionally gets `subtitle-lines: 1` — a 40-character cut still wraps at 360. The full value
lives in the row's tooltip (plain text, not markup).

**Built (step 9), with deviations.** The receipt inbox keeps the existing `Adw.OverlaySplitView`
collapse, but the queue toggle moves from the detail pane into the window header. It is shown
whenever the view's own split view is collapsed (≤500 px content pane), not only when the window
hits the 480 px phone breakpoint, because a 481–500 px window would otherwise leave the queue
inaccessible. The `Check & confirm` buttons and the keyboard hint are reparented into a
`Gtk.ActionBar` pinned at the bottom of the detail pane, but only while the window itself is
phone-sized (≤480 px); on desktop the buttons stay inline above the form. Re-opening the queue
after a confirm is also phone-only, so a desktop user keeps the always-visible list. The layout
decisions are isolated in `receiptInboxPhoneLayout()` and tested without GTK.

**Built (step 10), with deviations.** Dialogs that already had group-header actions got the same
overflow treatment as list rows in earlier commits (`phoneRowActions` on the suffix box). The
remaining work was sheet sizing for `BhWelcome`, `BhSetupAssistant` and `BhAddAccountDialog`:
`phoneSizeDialog(dialog, desktopHeight, parent)` sets `content-height: -1` while the window is
narrow, and `phoneDialogScroller(scroller, parent)` stops the inner `Gtk.ScrolledWindow` from
claiming `vexpand` on a phone so the sheet opens at its content height instead of full height.
The presenting main-window widget is passed as `narrowSource` so `onNarrow()` follows the real
window; the dialog's own root has no `narrow` property. These three dialogs use primary-action
bottom bars rather than group-header suffixes, so no further overflow folding was needed.

**Built (step 11), with deviations.** The last `NavViewId` is persisted per entity and restored
both on a cold start and when the active entity changes. Storage is a real `GSettings` schema
(`eu.jumplink.Steuererklaerung`) when it is compiled and installed; in development or any other
situation where the schema is unavailable the code falls back to the existing JSON user-settings
file. The store is accessed through a tiny interface in `last-section.ts`, so the resolver logic
is unit-tested without GTK. Unknown, empty or no-longer-visible stored values fall back to
`home`; the dev/testing hook `STEUER_APP_VIEW` still overrides the restore when it names a view
that is visible for the entity. No layout changed — the only window change is saving the current
view on every row selection and running a restore pass after the nav is rebuilt.

## Implementation plan

Ordered so each step is a reviewable PR that leaves the app working, and so the steps that help
every page come before the ones that help one.

| # | PR | Scope | Why here |
|---|----|-------|----------|
| 1 | **Breakpoint ladder** *(done)* | Add the `max-width: 480px` phone breakpoint to `window.blp` and expose it to views as a `narrow` property on the window, so no view invents its own window-width condition. | Everything below needs one place to ask "are we on a phone?". |
| 2 | **Shared helpers** *(done)* | `kpiFlow` two-up, `rowActions` → menu, 48 px targets, `chipScroller` fade + scroll-to-selection, in `views/util.ts` and `widgets/responsive.ts`, with tests. | One change fixes thirteen pages; every later PR gets smaller. |
| 3 | **Header-bar primary action** *(done)* | A per-view declaration of "the one creating action" and "the secondary ones"; `window.ts` renders them into the content header on a phone. Removes the Invoices button/chip overlap. | Unblocks the per-view PRs, which otherwise each re-solve it. |
| 4 | **Context button** *(done)* | Title widget becomes a `Gtk.MenuButton` on a phone, opening an `Adw.Dialog` with the existing entity and year switchers. | The one real gap the collapse leaves; independent of the view work. |
| 5 | **Section list as home** *(done)* | Badges on the nav rows, fed by the counts `home-view` already computes. | Makes the root page worth landing on. Needs 1, nothing else. |
| 6 | **Overview, Contracts, Invoices** *(done)* | Apply 2 + 3; demo banner one-line on a phone. | The three worst pages in the sweep, and they need no new mechanism. |
| 7 | **Transactions, Contacts, Projects, Accounts** *(done)* | Expander for KPI/explanation blocks, search bar, row menus. | Same pattern, four pages. |
| 8 | **Reports table** *(done)* | Frozen item column, horizontal scroll, month chips defaulting to the current month. | The only genuinely new widget work; isolated, so it can take its time. |
| 8b | **Time, Deadlines, Tax, Settings** *(done)* | One-row timer form + 48 px Play button; sentence-capped group descriptions behind an expander + 48 px `Paid`/`Filed`; EÜR PDF button into the header menu; middle-cut path subtitles. | Helper-only work on four small pages — slotted in before the reports table. |
| 9 | **Receipt inbox polish** *(done)* | Queue toggle into the header, re-open the queue after confirming, `Check & confirm` in a pinned `Gtk.ActionBar`. | Behavioural, needs the review flow's own tests. |
| 10 | **Dialog sizing** *(done)* | Sheets size to content; group headers follow the row rule. | Small, affects every dialog, safest last. |
| 11 | **Remember the last section** *(done)* | Persist `NavViewId` per entity in `GSettings`. | Pure convenience; worth nothing until 5 exists. |
| 12 | **Mobile screenshots** | Extend `app/dev/metainfo-screenshots.sh` to cover the reworked pages; add the 360 px pass to the screenshot docs. | Proves the result and feeds the Flathub listing. |

**Verification for every step:** `gjsify run check` in `app/`, plus a 360 × 760 screenshot of each
touched page under `scripts/headless-run`, compared against the same page at 1280 × 860 to show
the desktop is untouched.

## What this costs in strings

New user-visible strings are English msgids with a German catalogue entry, per
[i18n-status.md](i18n-status.md) and `CONTRIBUTING.md`. The German stays **gender-neutral**: no
`der Nutzer`, no `Benutzer:innen` — address the reader directly (`Sie`/imperative) or name the
thing, which is what the existing catalogue already does.

| Where | English msgid | German | Note |
|-------|---------------|--------|------|
| Row overflow button | `More actions` | `Weitere Aktionen` | Tooltip; one string for all thirteen pages. |
| Context button a11y | `Entity and year` | `Entität und Jahr` | Accessible name of the title menu button. |
| Demo banner title, short | `Demo data` | `Demodaten` | The full sentence plus the button wraps to two lines at 360 px, so the phone gets a title of its own. |
| Recurring summary | `{n} overdue` / `{n} due soon` | `{n} überfällig` / `{n} bald fällig` | Parts of the expander row's title on a phone; `{n} total` already existed. |
| Demo banner, short | `My data` | `Eigene Daten` | Phone variant of `Use my own data`; a second msgid, not a shortened translation, because only the phone wants it. |
| Contacts / Projects explainer | `What is this?` | `Was ist das?` | Expander title. |
| Transactions KPI expander | `Figures` | `Zahlen` | Expander title over the collapsed KPI block. |
| Reports month chips | *(none)* | — | Month names come from the locale, not the catalogue. |
| Nav row badges | *(none)* | — | Numbers only; the count's meaning is the row's existing subtitle. |

Three strings change context rather than text: the primary creating actions (`New invoice`,
`New contract`, `Add a contact`, `Add account`) become icon buttons on a phone and need a
`tooltip-text` with the same msgid — no new entries, but the `TRANSLATORS` comment should say the
label is also used as a tooltip, since German tooltips and buttons differ in register elsewhere.

**No string may be shortened for the phone by truncating the German.** Where a phone needs a
shorter label, it gets its own msgid (as `My data` does), so the translator sees both and can
choose per language.
