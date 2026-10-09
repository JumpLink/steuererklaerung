/**
 * Translation entry point for the native front-end.
 *
 * English is the source language: every msgid in this app is English, and German arrives as a
 * catalogue (`po/de.po`). That direction is deliberate — it is the one that lets a stranger read
 * the code, and the one gettext is built for.
 *
 * TWO calls, not one, and the second is the one that is easy to miss:
 *
 *   · `bindtextdomain` tells gettext WHERE the catalogues are.
 *   · `textdomain` sets the DEFAULT domain, which is what GtkBuilder uses. Every
 *     `translatable="yes"` string — that is, everything coming out of a `.blp` file — is resolved
 *     inside GTK, where this app never gets to pass a domain name. Binding only through
 *     `dgettext` would translate the TypeScript strings and leave every Blueprint one in English,
 *     which reads as a half-finished translation rather than as a missing call.
 *
 * The domain is the LITERAL application id, not {@link APP_ID}: that one is overridable through
 * `STEUER_APP_ID` so a devtools instance can run beside a normal one, and a devtools instance
 * looking up a domain nobody ships would silently show English.
 *
 * Missing catalogue is not an error state. `dgettext` returns the msgid when nothing resolves, so
 * an installation without `de.po` compiled shows correct English rather than empty labels.
 *
 * The binding itself is `initLocale()` from `@gjsify/adwaita-app`, which also owns the
 * empty-`GJSIFY_LOCALE_DIR` guard and the system-directory default.
 */

import { initLocale } from '@gjsify/adwaita-app';
import Gettext from 'gettext';

/** The gettext domain. Deliberately a literal — see the note above about `STEUER_APP_ID`. */
export const TEXT_DOMAIN = 'eu.jumplink.Steuererklaerung';

/**
 * Bind the catalogue directory and make {@link TEXT_DOMAIN} the default domain.
 *
 * Call once, before any widget is built: a label already realised keeps the string it was given.
 */
export function initI18n(): string | undefined {
    return initLocale(TEXT_DOMAIN).localeDir;
}

/** Translate one string. */
export function _(msgid: string): string {
    return Gettext.dgettext(TEXT_DOMAIN, msgid);
}

/**
 * Translate a counted string, letting the target language pick its own plural form.
 *
 * Never build this from an `n === 1` check: German agrees with English here, but the rule is a
 * property of the language and belongs in the catalogue, not in a call site.
 */
export function _n(singular: string, plural: string, n: number): string {
    return Gettext.dngettext(TEXT_DOMAIN, singular, plural, n);
}

/**
 * Translate with a disambiguating context.
 *
 * For the case where one English word is two different German ones — "Export" the noun and
 * "Export" the button — which a translator cannot resolve from the string alone.
 */
export function _p(context: string, msgid: string): string {
    return Gettext.dpgettext(TEXT_DOMAIN, context, msgid);
}
