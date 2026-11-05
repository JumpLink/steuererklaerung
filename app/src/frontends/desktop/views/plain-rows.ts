import Adw from '@girs/adw-1';

type ActionRowProps = Partial<Adw.ActionRow.ConstructorProps>;
type ExpanderRowProps = Partial<Adw.ExpanderRow.ConstructorProps>;

/**
 * Adwaita rows parse `title` / `subtitle` as Pango markup unless `use-markup` is off. Passing
 * `useMarkup: false` TOGETHER with the text to the constructor does not help: the text can be set
 * before the flag lands, GTK parses "Fon&Net Telecom GmbH" as markup and logs `Failed to set text …
 * from markup` (the final label is right, the warning is not — libadwaita 1.9, `check:gtk-markup`).
 * So the flag goes in at construction and the text follows through the setters.
 */
function applyText(row: Adw.ActionRow | Adw.ExpanderRow, title?: string | null, subtitle?: string | null): void {
    if (title != null) row.set_title(title);
    if (subtitle != null) row.set_subtitle(subtitle);
}

/** An `Adw.ActionRow` whose title and subtitle are plain text, whatever characters they hold. */
export function plainActionRow({ title, subtitle, ...rest }: ActionRowProps = {}): Adw.ActionRow {
    const row = new Adw.ActionRow({ ...rest, useMarkup: false });
    applyText(row, title, subtitle);
    return row;
}

/** An `Adw.ExpanderRow` whose title and subtitle are plain text, whatever characters they hold. */
export function plainExpanderRow({ title, subtitle, ...rest }: ExpanderRowProps = {}): Adw.ExpanderRow {
    const row = new Adw.ExpanderRow({ ...rest, useMarkup: false });
    applyText(row, title, subtitle);
    return row;
}
