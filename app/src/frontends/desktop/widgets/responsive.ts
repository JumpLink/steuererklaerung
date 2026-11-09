/**
 * Helpers that turn "this toolbar insists on 600 px" into "this toolbar prefers 600 px".
 *
 * Why the distinction matters: a `Gtk.Box` measures as the SUM of its children, and the window's
 * minimum width is the MAXIMUM over every page in the view stack — a `Gtk.Stack` measures the
 * pages nobody is looking at too. So one filter bar that cannot go below 605 px made the whole
 * app 605 px wide, on every view, and a 360 px phone window then drew its content clipped: the
 * header bar lost its buttons, the banner lost its text, and every list ran off the right edge.
 *
 * Every helper here leaves the NATURAL size alone, so a desktop window is laid out exactly as
 * before — they only give GTK a way down when the space really is not there.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import { _ } from '../i18n.ts';
import { onNarrow } from './narrow.ts';
import {
    TOUCH_GAP,
    TOUCH_TARGET,
    actionOverflow,
    chipScrollTarget,
    dialogContentHeight,
    undershoot,
} from './phone-rules.ts';

/** The direct children of a container, in order — GTK4 offers a sibling chain, not a list. */
function childrenOf(widget: Gtk.Widget): Gtk.Widget[] {
    const out: Gtk.Widget[] = [];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) out.push(child);
    return out;
}

/**
 * Put a linked chip group behind a sideways scroller: minimum width ≈ one chip, natural width the
 * whole group. The scrollbar is an overlay, so it reserves no space and changes no desktop layout;
 * on a touch screen the chips are swipeable.
 *
 * Two things the scroller alone does not do, both from the phone shots: the row runs off the right
 * edge with nothing to say more exists, and a chip selected by any route other than tapping it —
 * restoring a view, an empty-state's "show all" button — stays off screen. So the edges fade while
 * there is content behind them ({@link undershoot}), and the active chip is scrolled into view
 * ({@link chipScrollTarget}). Both are free on a desktop, where the row fits and never scrolls.
 */
export function chipScroller(chips: Gtk.Widget): Gtk.ScrolledWindow {
    const scroller = new Gtk.ScrolledWindow({
        child: chips,
        hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
        vscrollbarPolicy: Gtk.PolicyType.NEVER,
        // Without this the scroller asks for nothing and the chips collapse on the DESKTOP too.
        propagateNaturalWidth: true,
        valign: Gtk.Align.CENTER,
    });

    const adjustment = scroller.get_hadjustment();
    const fade = (): void => {
        const edges = undershoot(adjustment.get_value(), adjustment.get_page_size(), adjustment.get_upper());
        for (const [cls, on] of [
            ['undershoot-start', edges.start],
            ['undershoot-end', edges.end],
        ] as const) {
            if (on) scroller.add_css_class(cls);
            else scroller.remove_css_class(cls);
        }
    };
    // `changed` fires when the content or the viewport is resized, `value-changed` while scrolling.
    adjustment.connect('changed', fade);
    adjustment.connect('value-changed', fade);

    const reveal = (chip: Gtk.Widget): void => {
        const [ok, bounds] = chip.compute_bounds(chips);
        if (!ok) return; // not allocated yet — the idle pass below comes back for it
        const target = chipScrollTarget({
            start: bounds.get_x(),
            size: bounds.get_width(),
            value: adjustment.get_value(),
            page: adjustment.get_page_size(),
            upper: adjustment.get_upper(),
        });
        if (target !== null) adjustment.set_value(target);
    };
    // A toggle flips its group partner off in the same turn, so react to the one that went ON.
    const toggles = childrenOf(chips).filter((c): c is Gtk.ToggleButton => c instanceof Gtk.ToggleButton);
    for (const toggle of toggles) {
        toggle.connect('notify::active', () => {
            if (toggle.get_active()) reveal(toggle);
        });
    }
    // The group's initial selection is made BEFORE the row is handed to us, and nothing is
    // allocated at that point — so catch up once the first layout has happened.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        fade();
        const active = toggles.find((t) => t.get_active());
        if (active) reveal(active);
        return GLib.SOURCE_REMOVE;
    });

    return scroller;
}

/** Gap between the parts of a row's action cluster on a desktop; a phone uses {@link TOUCH_GAP}. */
const CLUSTER_SPACING = 6;

/**
 * The amount + buttons cluster on the right of a list row, as ONE suffix that may wrap.
 *
 * `Adw.ActionRow` lays its title and its suffixes out in a single horizontal box, so three labelled
 * buttons set a hard floor for the whole row — the Laufende-Kosten rows demanded 395 px for the
 * suffixes alone, which pushed the list to 446 px inside a 360 px window and simply cut it off at
 * the right edge. Worse, the row kept what was left for the title, which then wrapped one character
 * per line.
 *
 * Wrapped, the cluster drops under itself when the row is narrow. A desktop row has the width for
 * one line, so it lays out exactly as the plain suffix box did.
 */
export function rowActions(children: Gtk.Widget[]): Adw.WrapBox {
    const box = new Adw.WrapBox({
        childSpacing: CLUSTER_SPACING,
        lineSpacing: CLUSTER_SPACING,
        align: 1, // lines sit at the END, where a suffix belongs
        valign: Gtk.Align.CENTER,
    });
    for (const child of children) box.append(child);
    return box;
}

/**
 * Bound a row's title and subtitle to a fixed number of lines, so the text column can always give
 * the suffixes their room.
 *
 * An `Adw.ActionRow` whose subtitle wraps freely (`subtitle-lines: 0`, the default) can push its own
 * suffixes out of the card: the recurring-invoice rows drew "Entwurf erstellen" past the right edge
 * of the window at 1000 px while the row beside them, with a LONGER subtitle, laid out fine (#76).
 *
 * The mechanism is the two-step request of a horizontal `GtkBox`. The row's height is settled first,
 * from the children's NATURAL widths — a subtitle that fits on one unwrapped line therefore gets a
 * one-line row. `gtk_box_layout_allocate` then measures each child's width FOR THAT HEIGHT, and a
 * wrapping label that may not wrap has no width below its full single line: the text column reports
 * 509 px as its MINIMUM, the box hands it that, and the 298 px of suffixes go over the edge. The
 * neighbouring row escaped because its subtitle was long enough to wrap even at natural width, which
 * bought the row a second line and with it a way down.
 *
 * `title-lines`/`subtitle-lines` > 0 switch the labels to `ellipsize: END`, and an ellipsizing label
 * has a small minimum at ANY height — so the column gives way instead of overflowing.
 *
 * Only while there IS room, though: giving way is how the column survives a desktop row, and how it
 * starves on a phone, where the same ellipsis turned a 360 px row's title into a bare "…". So this
 * returns a switch, like {@link pinnableCluster}, and a narrow view hands the lines back: free
 * wrapping makes the column unshrinkable again, which leaves the cluster below it as the row's only
 * way down — exactly the layout wrapping was introduced for.
 */
export function boundRowText(
    row: Adw.ActionRow | Adw.ExpanderRow,
    opts: { titleLines?: number; subtitleLines?: number } = {},
): (narrow: boolean) => void {
    const apply = (narrow: boolean): void => {
        row.set_title_lines(narrow ? 0 : (opts.titleLines ?? 1));
        row.set_subtitle_lines(narrow ? 0 : (opts.subtitleLines ?? 1));
    };
    apply(false);
    return apply;
}

/**
 * Keep a {@link rowActions} cluster on ONE line as long as the view is wide, and let it wrap below
 * that. Returns the switch; call it with `true` when the view is narrow.
 *
 * Needed because wrapping is not free in the other direction: GTK takes a short allocation out of
 * whichever child CAN give, and an `Adw.WrapBox` always can. The plain suffix box it replaced could
 * not, so the row squeezed its title instead — which is exactly the layout a desktop row had, and
 * exactly the layout that came back once the cluster started absorbing the shortfall (the amount
 * dropped under the buttons on rows that used to fit). Requesting the natural width restores the
 * old rigidity without touching the natural size, so a wide row lays out as it always did; dropping
 * the request hands the row back its only way down to a phone width.
 */
export function pinnableCluster(cluster: Adw.WrapBox): (narrow: boolean) => void {
    let narrow = false;

    const pin = (): void => {
        // Drop the old pin first, otherwise the measurement just reports it back.
        cluster.set_size_request(-1, -1);
        if (narrow) return;
        const [, natural] = cluster.measure(Gtk.Orientation.HORIZONTAL, -1);
        cluster.set_size_request(natural, -1);
    };
    const apply = (next: boolean): void => {
        narrow = next;
        pin();
    };
    // Before the widget is mapped it has no font metrics, and the measurement would be guesswork —
    // so a row built while the view is already on screen pins itself the moment it appears, with
    // whatever width state the view last told it about.
    cluster.connect('map', () => apply(narrow));
    // Collapsing changes how wide the cluster wants to be, so the pin is taken again afterwards.
    phoneRowActions(cluster, pin);
    return apply;
}

/**
 * Make a row's action cluster usable with a thumb: fold its buttons into one overflow menu, and
 * give a lone button a {@link TOUCH_TARGET} hit area.
 *
 * Called for free by {@link pinnableCluster}; call it DIRECTLY from a view whose rows have nothing
 * to pin — `kontakte-view.ts` has a single Delete button per row, so it never needed the desktop
 * half, and without this call its rows would keep a 32 px target on a phone.
 *
 * Deliberately NOT driven by the `narrow` flag the view passes in. That flag comes from an in-view
 * `Adw.BreakpointBin`, which measures the content pane — 537 px inside a 1280 px window — so a
 * desktop user who drags the sidebar wide enough trips it and would get a phone's menu on a
 * 1200 px screen. The window's own `narrow` property is the only thing that means "this is a
 * phone", hence {@link onNarrow}.
 *
 * Collapsing hides the buttons where they are and puts a proxy for each in the popover, rather
 * than reparenting them. Reparenting would mean restoring the exact child order later, which no
 * two call sites agree on — `laufende-kosten-view.ts` PREPENDS into its cluster because an
 * `Adw.ExpanderRow` packs suffixes from the end. A hidden child keeps its place for free.
 *
 * The call sites add their buttons AFTER calling this, so the first pass runs in an idle
 * callback; later passes come from the window's breakpoint and from `map`.
 *
 * @param cluster the row's action cluster
 * @param after work to run after every collapse or expand
 */
export function phoneRowActions(cluster: Adw.WrapBox, after: () => void = () => {}, source?: Gtk.Widget): void {
    let phone = false;
    let scheduled = false;
    let menu: Gtk.MenuButton | null = null;
    /** The buttons WE hid — a button the view hid itself must stay hidden when we expand. */
    let hidden: Gtk.Button[] = [];

    const expand = (): void => {
        for (const button of hidden) {
            button.set_visible(true);
            button.set_size_request(-1, -1);
        }
        hidden = [];
        if (menu) cluster.remove(menu);
        menu = null;
        cluster.set_child_spacing(CLUSTER_SPACING);
    };

    const collapse = (actions: Gtk.Button[]): void => {
        const popover = new Gtk.Popover({ hasArrow: true, cssClasses: ['menu'] });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        popover.set_child(box);
        for (const action of actions) {
            box.append(overflowItem(action, popover));
            action.set_visible(false);
            hidden.push(action);
        }
        menu = new Gtk.MenuButton({
            iconName: 'view-more-symbolic',
            popover,
            valign: Gtk.Align.CENTER,
            // `row-overflow` / `row-action` are markers for dev/responsive-check.sh, no styling hangs on them.
            cssClasses: ['flat', 'row-overflow'],
            tooltipText: _('More actions'),
            widthRequest: TOUCH_TARGET,
            heightRequest: TOUCH_TARGET,
        });
        cluster.append(menu);
    };

    const refresh = (): void => {
        expand();
        const visible = childrenOf(cluster).filter((c) => c.get_visible());
        const kinds = visible.map((c) => (c instanceof Gtk.Button ? ('action' as const) : ('static' as const)));
        for (const [i, kind] of kinds.entries()) if (kind === 'action') visible[i]?.add_css_class('row-action');
        const indices = actionOverflow(kinds, phone);
        if (indices.length > 0) {
            cluster.set_child_spacing(TOUCH_GAP);
            collapse(indices.map((i) => visible[i] as Gtk.Button));
        } else if (phone) {
            // One action stays a button — but a 32 px icon button is still a quarter of a thumb.
            cluster.set_child_spacing(TOUCH_GAP);
            for (const [i, kind] of kinds.entries())
                if (kind === 'action') visible[i]?.set_size_request(TOUCH_TARGET, TOUCH_TARGET);
        }
        after();
    };

    const schedule = (): void => {
        if (scheduled) return;
        scheduled = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            scheduled = false;
            refresh();
            return GLib.SOURCE_REMOVE;
        });
    };

    onNarrow(
        cluster,
        (next) => {
            phone = next;
            schedule();
        },
        source,
    );
    cluster.connect('map', schedule);
}

/**
 * A menu entry standing in for one action button.
 *
 * The spec asks for a `Gtk.PopoverMenu`, which needs a `Gio.MenuModel`, which needs every action
 * to be a `Gio.Action` with a name. The call sites connect closures to `clicked` instead, and
 * rewriting five views' actions into action groups is a different change from this one — so this
 * is a plain `Gtk.Popover` of flat buttons, which looks the same and keeps the call sites intact.
 *
 * The entry re-emits `clicked` on the original rather than borrowing its handlers: whatever the
 * view connected still runs, including anything connected after this menu was built.
 */
function overflowItem(action: Gtk.Button, popover: Gtk.Popover): Gtk.Button {
    const item = menuItem(popover, {
        label: overflowText(action),
        iconName: action.get_icon_name(),
        // `zeiten-view.ts` disables both row buttons once an entry is invoiced.
        cssClasses: ['destructive-action', 'suggested-action'].filter((css) => action.has_css_class(css)),
        run: () => action.emit('clicked'),
    });
    // Mirrored, not copied — see above; the binding keeps the entry in step with later changes.
    action.bind_property('sensitive', item, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    return item;
}

/**
 * One entry of a `.menu` popover: a flat, thumb-high button with an optional icon and a left-aligned
 * caption.
 *
 * Shared by the row overflow above and the content header's own menu
 * ([`header-actions.ts`](./header-actions.ts)), which is the point — the two menus are the same
 * surface at two sizes, and a user who learns one has learned the other.
 */
export function menuItem(
    popover: Gtk.Popover,
    opts: { label: string; iconName?: string | null; cssClasses?: readonly string[]; run: () => void },
): Gtk.Button {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
    if (opts.iconName) box.append(new Gtk.Image({ iconName: opts.iconName }));
    box.append(new Gtk.Label({ label: opts.label, xalign: 0, hexpand: true }));
    const item = new Gtk.Button({
        cssClasses: ['flat', ...(opts.cssClasses ?? [])],
        heightRequest: TOUCH_TARGET,
        child: box,
    });
    item.connect('clicked', () => {
        popover.popdown();
        opts.run();
    });
    return item;
}

/**
 * Hide a control while the window is phone-sized, because the content header bar carries it there.
 *
 * Hidden rather than skipped at build time: the toolbar is rebuilt on reload, not on resize, so a
 * window dragged narrow after the view was built would keep whatever width state it was born with.
 * The subscription dies with the widget — see {@link onNarrow}.
 */
export function hideOnPhone<T extends Gtk.Widget>(widget: T): T {
    onNarrow(widget, (narrow) => widget.set_visible(!narrow));
    return widget;
}

/**
 * Size an `Adw.Dialog` to its content on a phone while keeping a fixed height on desktop.
 *
 * Dialogs are rooted in their own `Adw.DialogHost`, not in the main window, so {@link onNarrow} is
 * told to follow the widget the dialog was presented from.
 */
export function phoneSizeDialog(dialog: Adw.Dialog, desktopHeight: number, parent: Gtk.Widget): void {
    onNarrow(dialog, (narrow) => dialog.set_content_height(dialogContentHeight(narrow, desktopHeight)), parent);
}

/**
 * Stop a dialog's inner `Gtk.ScrolledWindow` from claiming the full sheet height on a phone.
 *
 * A `vexpand` scroller makes the sheet open at full height even when `content_height` is `-1`;
 * on a desktop the scroller should still fill the fixed dialog height.
 */
export function phoneDialogScroller(scroller: Gtk.ScrolledWindow, parent: Gtk.Widget): void {
    onNarrow(scroller, (narrow) => scroller.set_vexpand(!narrow), parent);
}

/**
 * What an action reads as in the menu: its own label, else the label a view registered with
 * {@link overflowLabel}, else its tooltip.
 *
 * An icon-only button has no text at all, and its tooltip is often qualified for the row it sits
 * in — "Correct: Stadtwerke" is a fine tooltip and a bad menu entry, because the menu already
 * belongs to that row.
 */
function overflowText(action: Gtk.Button): string {
    return action.get_label() ?? overflowLabels.get(action) ?? action.get_tooltip_text() ?? '';
}

const overflowLabels = new WeakMap<Gtk.Button, string>();

/**
 * Give an icon-only button the words it needs when it ends up in a row's overflow menu.
 *
 * Kept beside the button instead of inside it because there is nowhere in `Gtk.Button` to put it:
 * `label` would replace the icon, and the tooltip has a different job.
 */
export function overflowLabel<T extends Gtk.Button>(action: T, label: string): T {
    overflowLabels.set(action, label);
    return action;
}

/**
 * Pin a widget to its own natural width, so a scroller around it really scrolls.
 *
 * A `Gtk.ScrolledWindow` wraps a non-scrollable child in a viewport, and that viewport allocates the
 * child its MINIMUM width when the space is tight. For a row of plain buttons minimum = natural (a
 * `Gtk.Label` without `ellipsize` cannot shrink), so the row overflows and scrolls — which is why
 * {@link chipScroller} works. `Adw.InlineViewSwitcher` ellipsizes instead: its minimum is tiny, so
 * the viewport squeezed the six tax tabs into 360 px as "Erkl… EÜR Anl… USt… Ste…" rather than
 * letting them scroll. Measuring once and pinning that width turns the squeeze back into a scroll.
 *
 * Only the child is pinned, never the scroller — the window's own minimum width is unaffected, and a
 * desktop window (which has the natural width anyway) lays out exactly as before.
 *
 * Returns a callback to re-pin after the content changed, e.g. when tabs are shown or hidden.
 */
export function pinNaturalWidth(widget: Gtk.Widget): () => void {
    const pin = (): void => {
        // Drop the old pin first, otherwise the measurement just reports it back.
        widget.set_size_request(-1, -1);
        const [, natural] = widget.measure(Gtk.Orientation.HORIZONTAL, -1);
        widget.set_size_request(natural, -1);
    };
    // Before the widget is mapped it has no font metrics, and the measurement would be guesswork.
    if (widget.get_mapped()) pin();
    widget.connect('map', pin);
    return pin;
}

/**
 * A label that MAY wrap but does not ASK to — minimum width ≈ its longest word, natural width the
 * unwrapped single line.
 *
 * `wrap: true` alone changes both ends at once: with the default `natural-wrap-mode: inherit` a
 * wrapping label reports the wrapped width as its natural width too, so every caption this branch
 * taught to wrap also stopped asking for the room it used to get. On the desktop that was visible
 * — the assistant panel collapsed from 424 px to 320 px because its suggestion pills no longer
 * claimed a line each. `NONE` keeps the natural size exactly where it was before the wrap, which
 * is the whole point: a wide window must lay out as it always did.
 */
export function wrappingLabel(props: Partial<Gtk.Label.ConstructorProps>): Gtk.Label {
    return new Gtk.Label({ wrap: true, naturalWrapMode: Gtk.NaturalWrapMode.NONE, ...props });
}

/**
 * Let a button's caption wrap instead of demanding its full width on one line. `Gtk.Button`'s own
 * `label` never wraps, so "Bestätigen und weiter" is a hard 190 px floor; the same text in a
 * wrapping `Gtk.Label` falls to its longest word when crowded and stays one line when it fits.
 */
export function wrapButtonLabel(button: Gtk.Button): Gtk.Button {
    const label = button.get_label();
    if (label === null) return button;
    button.set_child(wrappingLabel({ label, justify: Gtk.Justification.CENTER }));
    return button;
}
