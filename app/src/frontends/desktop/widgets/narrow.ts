/**
 * "Are we on a phone?", asked from inside a view.
 *
 * The answer lives on the window: a `narrow` property fed by the `max-width: 480px` rung of the
 * breakpoint ladder in `window.blp` (see `window.ts`). This module is only the subscription — one
 * call, and the view is told the current answer now and every later change.
 *
 * Why not read `window.narrow` directly: a view is BUILT BEFORE IT IS ROOTED. The factory in
 * `views/registry.ts` constructs the widget, `window.ts` adds it to the stack afterwards, and
 * `get_root()` returns null for everything in between — so a one-off read at construction time
 * reports "desktop" on a phone, every time, and never corrects itself. {@link onNarrow} waits for
 * the root instead and re-binds if the widget is ever moved.
 *
 * Why not a registry like `toast.ts`'s `registerToastOverlay`: that one exists because a toast has
 * no widget to start from. Here there always is one, and walking up from it keeps the answer tied
 * to the window the view is actually in rather than to whichever window registered last.
 */

import type GObject from '@girs/gobject-2.0';
import type Gtk from '@girs/gtk-4.0';

/** The slice of `MainWindow` this module needs; importing the class itself would be circular. */
interface NarrowRoot extends GObject.Object {
    readonly narrow: boolean;
}

function narrowRoot(widget: Gtk.Widget): NarrowRoot | null {
    const root = widget.get_root();
    if (!root) return null;
    // Duck-typed on purpose: `MainWindow` imports the views, so the views cannot import it back.
    // An `Adw.Window` without the property (a dialog's own root, a test harness) is simply not a
    // narrow source, and the view stays on its wide layout.
    return typeof (root as unknown as Partial<NarrowRoot>).narrow === 'boolean'
        ? (root as unknown as NarrowRoot)
        : null;
}

/**
 * Call `apply` with the window's current `narrow` state, and again whenever it changes.
 *
 * `apply` runs synchronously for the state at call time — `false` while the widget is unrooted —
 * so a view can treat it as the single place its layout is decided instead of setting a wide
 * default and then waiting for a correction.
 *
 * The subscriptions die with the widget: both are made on objects the widget outlives or owns, and
 * GJS drops them when it is finalized.
 */
export function onNarrow(widget: Gtk.Widget, apply: (narrow: boolean) => void): void {
    let source: NarrowRoot | null = null;
    let handler = 0;

    const rebind = () => {
        if (source && handler) source.disconnect(handler);
        source = narrowRoot(widget);
        handler = source ? source.connect('notify::narrow', () => apply(source?.narrow ?? false)) : 0;
        apply(source?.narrow ?? false);
    };

    widget.connect('notify::root', rebind);
    rebind();
}
