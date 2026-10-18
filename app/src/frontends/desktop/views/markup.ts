import GLib from '@girs/glib-2.0';

/**
 * Escape a plain string for the Pango-markup labels Adwaita rows / status pages use.
 *
 * Every `Adw.PreferencesRow` (ActionRow, ExpanderRow …) parses `title` / `subtitle` as markup by
 * default, so a data string like "1&1 Telecom GmbH" is rejected by GTK and the label stays empty.
 * Data goes through this, or the row is built with `useMarkup: false` (`check:gtk-markup`).
 */
export function markup(text: string): string {
    return GLib.markup_escape_text(text, -1);
}
