/**
 * The contract every ported native view satisfies.
 *
 * A ported view IS a GTK widget (it goes straight into the content stack) that knows how to
 * (re)load itself for a given entity + reporting year. The window calls `reload()` when the view
 * becomes visible and whenever the entity/year switchers change. Views that aren't ported yet fall
 * back to a placeholder status page (see window.ts) and simply don't appear in the registry.
 */

import type Gtk from '@girs/gtk-4.0';
import type { AppEntity } from './entities.ts';

/**
 * One action a view offers from the content header bar while the window is phone-sized.
 *
 * A declaration, not a widget: the view says what it can do and what to call, and the window
 * decides where that lands — the `+` button or the overflow menu. Keeping it declarative is what
 * lets one view's actions be rendered by something that has never heard of that view, and what
 * lets `headerActionPlan` be tested without a display.
 */
export interface ViewAction {
    /** Translated; the menu entry's text, and the header button's tooltip. */
    label: string;
    /** Symbolic icon. The primary action defaults to `list-add-symbolic`. */
    iconName?: string;
    /**
     * The one creating action of this view — `New invoice`, `Add a contact`.
     *
     * Exactly one per view: the header has room for one button, and a screen with two equally
     * primary actions has not decided what it is for. A second one is not an error, it simply
     * joins the menu (see `headerActionPlan`).
     */
    primary?: boolean;
    run(): void;
}

export type PortedView = Gtk.Widget & {
    reload(entity: AppEntity, year: number): void;
    /**
     * What this view offers from the content header bar on a phone, newest state each call.
     *
     * Asked (never cached) whenever the visible view, the window width or the view's own state
     * changes — a view whose actions depend on something it loads calls `headerActionsChanged`
     * from `widgets/header-actions.ts` once it knows. Views with nothing to create omit it.
     */
    headerActions?(): ViewAction[];
};

/** Builds a fresh instance of a ported view. */
export type ViewFactory = () => PortedView;
