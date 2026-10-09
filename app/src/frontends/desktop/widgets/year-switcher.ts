/**
 * <BhYearSwitcher> — the sidebar year picker (v3 design): linked toggle segments while the list is
 * small enough to scan at a glance, automatically a Gtk.DropDown beyond that — equal-width segments
 * stop working past a handful of years, so the widget degrades instead of the layout.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './year-switcher.blp';

/** Beyond this many years the segments become a DropDown. */
const MAX_SEGMENTS = 4;

export class BhYearSwitcher extends Adw.Bin {
    static {
        GObject.registerClass(
            {
                GTypeName: 'BhYearSwitcher',
                Template,
                InternalChildren: ['stack', 'segments', 'dropdown'],
            },
            this,
        );
    }

    declare private _stack: Gtk.Stack;
    declare private _segments: Gtk.Box;
    declare private _dropdown: Gtk.DropDown;

    /** Fired after a USER choice. Programmatic setYears() never fires it. */
    onChanged: ((year: number) => void) | null = null;

    private years: number[] = [];
    private current = 0;
    private filling = false;

    constructor() {
        super();
        // Connected ONCE, on a dropdown that outlives every `setYears()`. The `filling` guard is
        // what makes that safe: swapping the model fires `notify::selected`, and a rebuild must not
        // read as a user choice.
        this._dropdown.connect('notify::selected', () => {
            if (this.filling) return;
            const year = this.years[this._dropdown.get_selected()];
            if (year == null || year === this.current) return;
            this.current = year;
            this.onChanged?.(year);
        });
    }

    get year(): number {
        return this.current;
    }

    /** Rebuild for the given years (ascending) and select `selected`. */
    setYears(years: number[], selected: number): void {
        this.filling = true;
        this.years = [...years];
        this.current = years.includes(selected) ? selected : (years[years.length - 1] ?? selected);
        if (years.length > MAX_SEGMENTS) {
            this._dropdown.set_model(Gtk.StringList.new(this.years.map(String)));
            this._dropdown.set_selected(Math.max(0, this.years.indexOf(this.current)));
            this._stack.set_visible_child_name('dropdown');
        } else {
            this.fillSegments();
            this._stack.set_visible_child_name('segments');
        }
        this.filling = false;
    }

    /** Replace the chips. One toggle per year, grouped so they behave as radio buttons. */
    private fillSegments(): void {
        let child = this._segments.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._segments.remove(child);
            child = next;
        }
        let radio: Gtk.ToggleButton | null = null;
        for (const year of this.years) {
            const button = new Gtk.ToggleButton({ label: String(year), active: year === this.current });
            if (radio) button.set_group(radio);
            else radio = button;
            button.connect('toggled', () => {
                if (this.filling || !button.get_active() || year === this.current) return;
                this.current = year;
                this.onChanged?.(year);
            });
            this._segments.append(button);
        }
        this._segments.set_sensitive(this.years.length > 1);
    }
}
