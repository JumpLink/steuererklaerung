/**
 * <BhToggleTabs> — the design's segmented chip switcher over a non-homogeneous Gtk.Stack.
 *
 * WHY not Adw.ViewSwitcher/Adw.ViewStack: Adw.ViewStack sizes HOMOGENEOUSLY — every page is
 * allocated the tallest page's height, so a short page leaves a large empty gap under its content
 * (the reported Steuererklärungs-Wizard bug). This widget pairs the design's linked ToggleButton
 * chips (equal-width segments, optional status icon) with a plain `Gtk.Stack` whose height follows
 * the VISIBLE page. Use it wherever variable-height step/tab content lives inside a scrolling page;
 * full-height view containers (the nav hubs) keep Adwaita's stock switchers.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import Pango from '@girs/pango-1.0';

import Template from './toggle-tabs.blp';

export class BhToggleTabs extends Gtk.Box {
    static {
        GObject.registerClass({ GTypeName: 'BhToggleTabs', Template, InternalChildren: ['bar', 'stack'] }, this);
    }

    declare private _bar: Gtk.Box;
    declare private _stack: Gtk.Stack;
    private readonly buttons = new Map<string, Gtk.ToggleButton>();
    private radio: Gtk.ToggleButton | null = null;
    /** True while select() drives the chips — the toggled handler must not re-fire onChanged. */
    private selecting = false;

    /** Fired after a USER chip choice switched the visible page. */
    onChanged: ((id: string) => void) | null = null;

    /** Append one tab: chip (label + optional status icon) + its stack page. First tab starts active. */
    add(id: string, label: string, child: Gtk.Widget, opts: { iconName?: string } = {}): void {
        const btn = new Gtk.ToggleButton();
        btn.set_child(
            opts.iconName
                ? new Adw.ButtonContent({ label, iconName: opts.iconName })
                : new Gtk.Label({ label, ellipsize: Pango.EllipsizeMode.END }),
        );
        if (this.radio) btn.set_group(this.radio);
        else {
            this.radio = btn;
            btn.set_active(true);
        }
        btn.connect('toggled', () => {
            if (this.selecting || !btn.get_active()) return;
            this._stack.set_visible_child_name(id);
            this.onChanged?.(id);
        });
        this._bar.append(btn);
        this.buttons.set(id, btn);
        this._stack.add_named(child, id);
    }

    /** Programmatically activate a tab (no onChanged). */
    select(id: string): void {
        const btn = this.buttons.get(id);
        if (!btn) return;
        this.selecting = true;
        btn.set_active(true);
        this._stack.set_visible_child_name(id);
        this.selecting = false;
    }

    get selected(): string | null {
        return this._stack.get_visible_child_name();
    }
}
