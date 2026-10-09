/**
 * Reusable Einstellungen row builders + list helpers, shared by the section modules
 * (dms-invoicing · betrieb-ust · abschluss · privat).
 *
 * Every editing row applies on Enter/checkmark or value/selection change and persists through the
 * host's save contract — but only when the view is NOT programmatically populating rows (a fill must
 * not persist). That guard is the {@link SettingsHost.isFilling} flag the shell owns; each builder
 * consults it before invoking its `onApply`/`onChange`, exactly as the original God-view did.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

/**
 * The slice of the Einstellungen view a section needs to persist + report. The shell implements it
 * (bound to `_filling` / the banner / `saveWith`), so the sections stay free of the view class.
 */
export interface SettingsHost {
    /** True while programmatically populating rows — suppresses the notify/apply-driven persist. */
    isFilling(): boolean;
    /** Surface a message in the save banner (never crashes). */
    banner(message: string): void;
    /**
     * Run a config write with the shared success/error contract: on success clear the banner, drop the
     * EÜR aggregate cache (est/elster writes only) so the tax views recompute, and toast; on any error
     * surface it in the banner and keep running.
     */
    saveWith(fn: () => void, opts?: { clearCache?: boolean }): void;
    /**
     * Rebuild the per-entity groups from the manifest.
     *
     * For a section whose rows SUMMARISE stored data (how many rules, which ones) rather than
     * mirroring one field: after a write, patching the widgets would leave a row showing a count
     * the file does not have — the exact drift the staleness guard in saveWith exists to catch.
     */
    reloadEntityGroups(): void;
}

/** A text row with an apply button that persists on Enter/checkmark (not on every keystroke). */
export function entryRow(
    host: SettingsHost,
    title: string,
    text: string,
    onApply: (text: string) => void,
): Adw.EntryRow {
    const row = new Adw.EntryRow({ title });
    row.set_show_apply_button(true);
    row.set_text(text);
    row.connect('apply', () => {
        if (!host.isFilling()) onApply(row.get_text() ?? '');
    });
    return row;
}

/** A numeric/money row (digits 2 = money, 0 = counts) persisting on value change. */
export function spinRow(
    host: SettingsHost,
    title: string,
    value: number,
    opts: { digits: number; lower: number; upper: number },
    onChange: (value: number) => void,
): Adw.SpinRow {
    const adjustment = new Gtk.Adjustment({
        value,
        lower: opts.lower,
        upper: opts.upper,
        stepIncrement: opts.digits > 0 ? 0.01 : 1,
        pageIncrement: opts.digits > 0 ? 100 : 10,
    });
    const row = new Adw.SpinRow({ title, adjustment, digits: opts.digits }); // value already set → no init notify
    // DEBOUNCED, because `notify::value` fires per step: holding the + button for a second produced
    // a chain of ~20 whole-manifest writes and 20 stacked "Gespeichert" toasts, each one a full
    // read-modify-write of the config file. Only the value the user stopped on is worth writing.
    const persist = debounced(() => {
        if (!host.isFilling()) onChange(row.get_value());
    });
    row.connect('notify::value', persist);
    return row;
}

/**
 * Run `fn` once the calls stop, not once per call.
 *
 * 350 ms: long enough to swallow auto-repeat from a held spin button, short enough that letting go
 * and immediately closing the window still writes. A pending call fires against config, not against
 * widgets, so a view torn down in between costs nothing — the value the user set is still the value
 * that gets saved.
 */
function debounced(fn: () => void, delayMs = 350): () => void {
    let pending = 0;
    return () => {
        if (pending) GLib.Source.remove(pending);
        pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            pending = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    };
}

/** An enum row (Gtk.StringList) persisting the selected index on change. */
export function comboRow(
    host: SettingsHost,
    title: string,
    options: string[],
    selected: number,
    onChange: (index: number) => void,
): Adw.ComboRow {
    const model = new Gtk.StringList();
    for (const o of options) model.append(o);
    const row = new Adw.ComboRow({ title, model });
    row.set_selected(Math.max(0, selected)); // set before connecting so this doesn't persist
    row.connect('notify::selected', () => {
        if (!host.isFilling()) onChange(row.get_selected());
    });
    return row;
}

/** A boolean row persisting on toggle (the per-entity counterpart of the shell's global switchRow). */
export function toggleRow(
    host: SettingsHost,
    title: string,
    subtitle: string | null,
    active: boolean,
    onChange: (on: boolean) => void,
): Adw.SwitchRow {
    const row = new Adw.SwitchRow({ title });
    if (subtitle) row.set_subtitle(subtitle);
    row.set_active(active); // set before connecting so this doesn't persist
    row.connect('notify::active', () => {
        if (!host.isFilling()) onChange(row.get_active());
    });
    return row;
}

/** A destructive "Entfernen" ButtonRow for a list expander. */
export function removeRow(title: string, onRemove: () => void): Adw.ButtonRow {
    const btn = new Adw.ButtonRow({ title });
    btn.add_css_class('destructive-action');
    btn.connect('activated', onRemove);
    return btn;
}

/** Drop one list row from its tracking array and from its group. */
export function spliceRow<T>(rows: T[], w: T, group: Adw.PreferencesGroup, row: Adw.ExpanderRow): void {
    const i = rows.indexOf(w);
    if (i >= 0) rows.splice(i, 1);
    group.remove(row);
}
