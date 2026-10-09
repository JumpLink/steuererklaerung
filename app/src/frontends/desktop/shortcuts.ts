/**
 * Keyboard access — the whole app had exactly one shortcut, and it was Ctrl+Q from the shell.
 *
 * Everything else needed the mouse: switching view, reloading after a sync, reaching the search
 * box, opening settings. For someone who works by keyboard that is not "less convenient", it is
 * the difference between usable and not — and an app shipping without it is not finished, whatever
 * its feature list says.
 *
 * All of it goes through WINDOW ACTIONS rather than key handlers, for the reason `nav.ts` gives:
 * an action is named, discoverable (`ListActions` over devtools sees it), reachable from any nested
 * widget, and shows up in the shortcuts window automatically. A key handler is none of those.
 *
 * `Ctrl+F` needs a per-view seam because only some views have a search box; {@link Searchable} is
 * that seam, and the window asks the VISIBLE view rather than keeping a registry that would drift.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import type Gtk from '@girs/gtk-4.0';

import { NAV_ITEMS, type NavViewId } from './nav.ts';

/** A view that owns a search entry and can put the cursor in it. */
export interface Searchable {
    focusSearch(): void;
}

/** Whether a widget offers the search seam. */
export function isSearchable(widget: unknown): widget is Searchable {
    return typeof (widget as Searchable | null)?.focusSearch === 'function';
}

/** What the window must provide for the shortcuts to do anything. */
export interface ShortcutHost {
    navigate(view: NavViewId): void;
    reloadVisible(): void;
    /** The widget currently shown in the content stack, or null. */
    visibleView(): Gtk.Widget | null;
}

/** One row in the shortcuts window: an accel and what it does. */
interface ShortcutSpec {
    accel: string;
    title: string;
    /** Which group of the shortcuts window it belongs to. */
    group: 'Navigation' | 'Ansicht' | 'Allgemein';
}

const EXTRA_SHORTCUTS: ShortcutSpec[] = [
    { accel: '<primary>f', title: 'Suchen', group: 'Ansicht' },
    { accel: 'F5', title: 'Neu laden', group: 'Ansicht' },
    { accel: '<primary>comma', title: 'Einstellungen', group: 'Allgemein' },
    { accel: '<primary>question', title: 'Tastenkürzel', group: 'Allgemein' },
    { accel: '<primary>q', title: 'Beenden', group: 'Allgemein' },
];

/**
 * Install every window action and its accelerator.
 *
 * Ctrl+1…9 follow the SIDEBAR ORDER, not a hand-written table: the numbers a user counts down the
 * sidebar are the numbers they press, and a nav entry added later gets its shortcut for free
 * instead of quietly having none.
 *
 * Only the first nine, because Ctrl+0 is not a tenth in any toolkit's convention. With twelve nav
 * entries that leaves Projekte, Konten and Einstellungen without a number — Einstellungen has Ctrl+, as every
 * GNOME app does, Konten has none. The shortcuts dialog lists exactly what exists, so nobody hunts
 * for a Ctrl+10.
 */
export function installShortcuts(window: Gtk.ApplicationWindow, host: ShortcutHost): void {
    const app = window.get_application();
    if (!app) {
        // NOT silent. A quiet return here is how every shortcut in the app could be absent while
        // the code registering them looked fine — the same class nav.ts documents for navigate().
        console.error('[app] installShortcuts: window has no application yet — no accelerators bound');
        return;
    }

    const add = (name: string, run: () => void, accels: string[]): void => {
        const action = new Gio.SimpleAction({ name });
        action.connect('activate', run);
        window.add_action(action);
        app.set_accels_for_action(`win.${name}`, accels);
    };

    NAV_ITEMS.slice(0, 9).forEach((item, index) => {
        add(`goto-${item.view}`, () => host.navigate(item.view), [`<primary>${index + 1}`]);
    });

    add('reload', () => host.reloadVisible(), ['F5', '<primary>r']);
    add('settings', () => host.navigate('settings'), ['<primary>comma']);
    add(
        'search',
        () => {
            // No-op on a view without a search box — deliberately silent, unlike a failed navigate:
            // "this view has nothing to search" is the normal answer for most of them, not a defect.
            const view = host.visibleView();
            if (isSearchable(view)) view.focusSearch();
        },
        ['<primary>f'],
    );
    add('shortcuts', () => presentShortcuts(window), ['<primary>question']);
}

/**
 * The Ctrl+? dialog, built from the SAME nav list the accels come from — so a nav entry can never
 * have a working shortcut the help does not mention, or the reverse.
 *
 * `Adw.ShortcutsDialog`, not `Gtk.ShortcutsWindow`: the GTK one is deprecated since 4.18, and it is
 * a WINDOW, which on this app would open beside the window it documents instead of inside it.
 */
export function presentShortcuts(parent: Gtk.Widget): void {
    const dialog = new Adw.ShortcutsDialog();

    const navigation = Adw.ShortcutsSection.new('Navigation');
    NAV_ITEMS.slice(0, 9).forEach((item, index) => {
        navigation.add(Adw.ShortcutsItem.new(item.label, `<primary>${index + 1}`));
    });
    dialog.add(navigation);

    for (const group of ['Ansicht', 'Allgemein'] as const) {
        const section = Adw.ShortcutsSection.new(group);
        for (const spec of EXTRA_SHORTCUTS.filter((s) => s.group === group)) {
            section.add(Adw.ShortcutsItem.new(spec.title, spec.accel));
        }
        dialog.add(section);
    }

    dialog.present(parent);
}
