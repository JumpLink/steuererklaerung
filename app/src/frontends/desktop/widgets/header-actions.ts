/**
 * The content header bar's phone actions — the widget half of `headerActionPlan`.
 *
 * On a phone a view's creating action moves out of its own toolbar and into the header bar, where
 * it costs no content height (the header is there either way) and always sits under the same
 * thumb. `docs/app/mobile-layout.md` → "Primary action — one header-bar button".
 *
 * The window owns the two widgets and the views own the actions, so neither side imports the
 * other: a view hands over a `ViewAction[]`, `window.ts` hands over its header children, and this
 * module is the only place that knows what a `+` button and an overflow menu look like.
 */

import Gtk from '@girs/gtk-4.0';

import type { ViewAction } from '../view.ts';
import { headerActionPlan } from './phone-rules.ts';
import { menuItem } from './responsive.ts';

/** What `window.ts` passes in, so this module never has to know the window's field names. */
export interface HeaderActionSlots {
    /** The `+` button. */
    button: Gtk.Button;
    /** The overflow menu beside it. */
    menu: Gtk.MenuButton;
}

/**
 * The `clicked` handler currently on each `+` button.
 *
 * The button is a template child and outlives every view, so the handler for the view that just
 * went away has to go with it — otherwise switching from Contracts to Invoices would leave a
 * button that creates a contract from the Invoices page.
 */
const wired = new WeakMap<Gtk.Button, number>();

/**
 * Put `actions` into the header, or clear it when there is nothing to show.
 *
 * Idempotent and called often — on every view switch, every breakpoint change and whenever a view
 * says its actions changed — so it rebuilds rather than diffing: a popover of at most a handful of
 * flat buttons is cheaper to make than to reconcile.
 */
export function renderHeaderActions(slots: HeaderActionSlots, actions: readonly ViewAction[], narrow: boolean): void {
    const plan = headerActionPlan(
        actions.map((action) => (action.primary ? 'primary' : 'secondary')),
        narrow,
    );

    const previous = wired.get(slots.button);
    if (previous) {
        slots.button.disconnect(previous);
        wired.delete(slots.button);
    }

    const lead = plan.button === null ? undefined : actions[plan.button];
    slots.button.set_visible(lead !== undefined);
    if (lead) {
        slots.button.set_icon_name(lead.iconName ?? 'list-add-symbolic');
        // The only words the button has: it is icon-only, so this is its accessible name too.
        slots.button.set_tooltip_text(lead.label);
        wired.set(
            slots.button,
            slots.button.connect('clicked', () => lead.run()),
        );
    }

    const rest = plan.menu.flatMap((index) => actions[index] ?? []);
    slots.menu.set_visible(rest.length > 0);
    slots.menu.set_popover(rest.length > 0 ? actionPopover(rest) : null);
}

function actionPopover(actions: readonly ViewAction[]): Gtk.Popover {
    const popover = new Gtk.Popover({ hasArrow: true, cssClasses: ['menu'] });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    popover.set_child(box);
    for (const action of actions)
        box.append(menuItem(popover, { label: action.label, iconName: action.iconName, run: () => action.run() }));
    return popover;
}

/** The slice of `MainWindow` this module needs; importing the class itself would be circular. */
interface HeaderActionRoot {
    refreshHeaderActions(): void;
}

/**
 * Tell the window to ask the visible view for its actions again.
 *
 * For state a view learns late: Invoices only knows whether the back-end can create a draft after
 * it has loaded the entity's capabilities, and a tab hub's actions are whichever tab is showing.
 * Without this the header would be correct only until the first such change.
 *
 * Duck-typed on the root for the same reason as [`narrow.ts`](./narrow.ts): the window imports the
 * views, so the views cannot import it back. A widget in a dialog (its own root) or a test harness
 * simply has no window to tell, and the call does nothing.
 */
export function headerActionsChanged(widget: Gtk.Widget): void {
    const root = widget.get_root() as unknown as Partial<HeaderActionRoot> | null;
    if (typeof root?.refreshHeaderActions === 'function') root.refreshHeaderActions();
}
