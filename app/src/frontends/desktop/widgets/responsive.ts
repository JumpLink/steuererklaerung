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

/**
 * Put a linked chip group behind a sideways scroller: minimum width ≈ one chip, natural width the
 * whole group. The scrollbar is an overlay, so it reserves no space and changes no desktop layout;
 * on a touch screen the chips are swipeable.
 */
export function chipScroller(chips: Gtk.Widget): Gtk.ScrolledWindow {
    return new Gtk.ScrolledWindow({
        child: chips,
        hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
        vscrollbarPolicy: Gtk.PolicyType.NEVER,
        // Without this the scroller asks for nothing and the chips collapse on the DESKTOP too.
        propagateNaturalWidth: true,
        valign: Gtk.Align.CENTER,
    });
}

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
        childSpacing: 6,
        lineSpacing: 6,
        align: 1, // lines sit at the END, where a suffix belongs
        valign: Gtk.Align.CENTER,
    });
    for (const child of children) box.append(child);
    return box;
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
    const apply = (next: boolean): void => {
        narrow = next;
        // Drop the old pin first, otherwise the measurement just reports it back.
        cluster.set_size_request(-1, -1);
        if (narrow) return;
        const [, natural] = cluster.measure(Gtk.Orientation.HORIZONTAL, -1);
        cluster.set_size_request(natural, -1);
    };
    // Before the widget is mapped it has no font metrics, and the measurement would be guesswork —
    // so a row built while the view is already on screen pins itself the moment it appears, with
    // whatever width state the view last told it about.
    cluster.connect('map', () => apply(narrow));
    return apply;
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
