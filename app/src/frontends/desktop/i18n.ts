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
 *
 * Which language: `setlocale(LC_ALL, "")` inside `initLocale()` reads the usual POSIX chain —
 * `LANGUAGE` (a priority list, ignored while the locale itself is `C`), then `LC_ALL`,
 * `LC_MESSAGES`, `LANG`. A `de_*` session therefore gets `de.po`, everything else English.
 */

import GLib from '@girs/glib-2.0';
import { initLocale } from '@gjsify/adwaita-app';
import Gettext from 'gettext';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The gettext domain. Deliberately a literal — see the note above about `STEUER_APP_ID`. */
export const TEXT_DOMAIN = 'eu.jumplink.Steuererklaerung';

/**
 * Bind the catalogue directory and make {@link TEXT_DOMAIN} the default domain.
 *
 * Call once, before any widget is built: a label already realised keeps the string it was given.
 */
export function initI18n(): string | undefined {
    return initLocale(TEXT_DOMAIN, { fallbackDir: devLocaleDir() }).localeDir;
}

/**
 * `<app>/dist/locale` when the app runs straight from the build tree, else `undefined`.
 *
 * `gjsify run dist/app/…` sets no `GJSIFY_LOCALE_DIR` (only the `gjsify ship` launcher does), so
 * without this the binding fell through to `/usr/share/locale`, where nothing of ours lives — and a
 * German developer saw every converted string in English while the shipped package was correct.
 * Checked for existence, so an installed copy without the tree keeps the system default.
 */
function devLocaleDir(): string | undefined {
    const fileUrl = import.meta.url;
    if (!fileUrl.startsWith('file:') || !fileUrl.includes('/dist/')) return undefined;
    // bundled: <app>/dist/app/steuer-app.gjs.mjs → <app>/dist/locale
    const dir = join(dirname(fileURLToPath(fileUrl)), '..', 'locale');
    return GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : undefined;
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

/**
 * Fill `{name}` placeholders in an already translated string.
 *
 * Named, not `%s`, so a translation can reorder them — German puts the verb last and the count
 * elsewhere than English. `dev/check-i18n.js` verifies that every msgstr keeps the msgid's names.
 */
export function fmt(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/**
 * The language the active catalogue speaks: `en` with no catalogue, else the translator's answer.
 *
 * For content that is not a msgid but a whole text set — the glossary — so it follows the UI
 * language exactly, including the case "German session, catalogue not compiled" (English UI,
 * English glossary) that a look at `LANG` would get wrong.
 */
export function uiLanguage(): string {
    // TRANSLATORS: Not shown. The two-letter code of THIS catalogue's language ("de" in de.po);
    // it picks the matching glossary of tax terms.
    return _p('language code', 'en');
}
