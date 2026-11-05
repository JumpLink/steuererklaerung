/**
 * The phone's context sheet — the entity and year switchers, one tap from every content header.
 *
 * On a phone the sidebar that normally holds `BhEntitySwitcher` and `BhYearSwitcher` is a page
 * away (`docs/app/mobile-layout.md` → "A context button in every content header"). The header's
 * context button opens this `Adw.Dialog` instead, which is a bottom sheet at that width.
 *
 * The sidebar's two widgets are NOT reparented: they are template children of the window and a
 * reparent would leave the sidebar with a hole the moment the window grows past the breakpoint.
 * A fresh pair is built per opening and fed the window's current state, which is all the switchers
 * ever hold — so there is no second copy of any switching logic, only a second view of it.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { _ } from '../i18n.ts';
import { BhEntitySwitcher, type EntityManageAction, type EntitySwitcherItem } from './entity-switcher.ts';
import { BhYearSwitcher } from './year-switcher.ts';

/** What the switchers show — the window's `workspace` / `currentEntity` / `currentYear`, flattened. */
export interface ContextState {
    entities: EntitySwitcherItem[];
    entityId: string;
    years: number[];
    year: number;
}

/** The window's own handlers, so a choice here lands exactly where a choice in the sidebar does. */
export interface ContextHandlers {
    onEntity: (id: string) => void;
    onYear: (year: number) => void;
    onManage: (action: EntityManageAction, id: string) => void;
}

export function presentContextDialog(parent: Gtk.Widget, state: ContextState, handlers: ContextHandlers): void {
    const dialog = new Adw.Dialog({
        // TRANSLATORS: Title of the phone sheet holding the entity and year switchers (also the context button's tooltip)
        title: _('Entity and year'),
        contentWidth: 360,
    });

    const entity = new BhEntitySwitcher();
    const year = new BhYearSwitcher();
    // Closing first, then acting: the choice reloads the whole window, and a sheet left open over
    // that would show the old state for as long as it takes.
    entity.onChanged = (id) => {
        dialog.close();
        handlers.onEntity(id);
    };
    entity.onManage = (action, id) => {
        dialog.close();
        handlers.onManage(action, id);
    };
    year.onChanged = (value) => {
        dialog.close();
        handlers.onYear(value);
    };
    entity.setEntities(state.entities, state.entityId);
    year.setYears(state.years, state.year);

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        marginTop: 12,
        marginBottom: 18,
        marginStart: 12,
        marginEnd: 12,
    });
    box.append(entity);
    box.append(year);

    const toolbar = new Adw.ToolbarView({ content: box });
    toolbar.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbar);
    dialog.present(parent);
}
