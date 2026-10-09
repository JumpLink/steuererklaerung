/**
 * <BhEntitySwitcher> — the sidebar entity card (v3 design): colored-initials avatar (Adw.Avatar) +
 * name + role line, opening a popover with every workspace entity. Replaces the header-bar
 * DropDown; the design puts identity where the navigation lives.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import { markup } from '../views/util.ts';
import { _ } from '../i18n.ts';

import Template from './entity-switcher.blp';

export interface EntitySwitcherItem {
    id: string;
    name: string;
    /** Role line under the name, e.g. "Unternehmen" / "Privat". */
    sub: string;
}

/** Registry actions offered under the entity list. */
export type EntityManageAction = 'create' | 'rename' | 'remove';

export class BhEntitySwitcher extends Adw.Bin {
    static {
        GObject.registerClass(
            {
                GTypeName: 'BhEntitySwitcher',
                Template,
                InternalChildren: ['avatar', 'name_label', 'sub_label', 'chevron', 'button', 'popover'],
            },
            this,
        );
    }

    /** Fired after a USER choice. Programmatic setEntities() never fires it. */
    onChanged: ((id: string) => void) | null = null;

    /**
     * Fired for a registry action on the CURRENT entity (or, for `create`, on nothing in
     * particular). Left null by the storybook, where there is no manifest to manage.
     *
     * The switcher is where these belong: it is the only place in the app that already shows the
     * entity list, and before this the only way to add, rename or drop one was to hand-edit
     * steuererklaerung.json.
     */
    onManage: ((action: EntityManageAction, id: string) => void) | null = null;

    declare private _avatar: Adw.Avatar;
    declare private _name_label: Gtk.Label;
    declare private _sub_label: Gtk.Label;
    declare private _chevron: Gtk.Image;
    declare private _button: Gtk.MenuButton;
    declare private _popover: Gtk.Popover;
    private items: EntitySwitcherItem[] = [];
    private currentId = '';

    /** Rebuild the card + popover list and show `selectedId` as the active identity. */
    setEntities(items: EntitySwitcherItem[], selectedId: string): void {
        this.items = [...items];
        this.currentId = selectedId;
        const current = items.find((e) => e.id === selectedId) ?? items[0];
        if (!current) return;
        this._avatar.set_text(current.name);
        this._name_label.set_label(current.name);
        this._sub_label.set_label(current.sub);
        // The card stays clickable with a single entity as soon as management is wired up —
        // otherwise "add a second entity" would be unreachable precisely when you have one.
        const interactive = items.length > 1 || this.onManage !== null;
        this._button.set_sensitive(interactive);
        this._chevron.set_visible(interactive);
        this._popover.set_child(this.buildList());
    }

    private buildList(): Gtk.Widget {
        const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
        for (const item of this.items) {
            const row = new Adw.ActionRow({ title: markup(item.name), subtitle: markup(item.sub) });
            const avatar = new Adw.Avatar({ size: 28, showInitials: true, text: item.name });
            row.add_prefix(avatar);
            if (item.id === this.currentId)
                row.add_suffix(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['accent'] }));
            row.set_activatable(true);
            row.connect('activated', () => {
                this._popover.popdown();
                if (item.id === this.currentId) return;
                this.onChanged?.(item.id);
            });
            list.append(row);
        }
        if (!this.onManage) return list;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        box.append(list);
        box.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));

        const actions = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
        actions.append(this.manageRow(_('New entity …'), 'list-add-symbolic', 'create'));
        actions.append(this.manageRow(_('Rename …'), 'document-edit-symbolic', 'rename'));
        actions.append(this.manageRow(_('Remove …'), 'user-trash-symbolic', 'remove'));
        box.append(actions);
        return box;
    }

    private manageRow(title: string, icon: string, action: EntityManageAction): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: markup(title) });
        row.add_prefix(new Gtk.Image({ iconName: icon }));
        row.set_activatable(true);
        row.connect('activated', () => {
            this._popover.popdown();
            this.onManage?.(action, this.currentId);
        });
        return row;
    }
}
