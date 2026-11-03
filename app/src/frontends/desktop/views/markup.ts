const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
};

/**
 * Escape a plain string for the Pango-markup labels Adwaita rows / status pages use.
 *
 * Every `Adw.PreferencesRow` (ActionRow, ExpanderRow …) parses `title` / `subtitle` as markup by
 * default, so a data string like "1&1 Telecom GmbH" is rejected by GTK and the label stays empty.
 * Data goes through this, or the row is built with `useMarkup: false` (`check:gtk-markup`).
 *
 * Same output as `GLib.markup_escape_text`, written out by hand: on `--app node` a bundle whose only
 * platform reach is an `@girs` import is not recognised as a GJS source, so `GLib` is an empty
 * module there and the call does not exist (gjsify "known narrowness", `app/node.ts`).
 */
export function markup(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
