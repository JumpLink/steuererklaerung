/**
 * Pure gettext helpers without GTK/adwaita dependencies. Used by headless-safe modules and tests.
 * Locale binding lives in {@link i18n.ts} because only the running app needs to set it.
 */
import Gettext from 'gettext';

export const TEXT_DOMAIN = 'eu.jumplink.Steuererklaerung';

/** Translate one string. */
export function _(msgid: string): string {
    return Gettext.dgettext(TEXT_DOMAIN, msgid);
}

/**
 * Translate a counted string, letting the target language pick its own plural form.
 */
export function _n(singular: string, plural: string, n: number): string {
    return Gettext.dngettext(TEXT_DOMAIN, singular, plural, n);
}

/**
 * Translate with a disambiguating context.
 */
export function _p(context: string, msgid: string): string {
    return Gettext.dpgettext(TEXT_DOMAIN, context, msgid);
}

/**
 * Fill `{name}` placeholders in an already translated string.
 */
export function fmt(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
