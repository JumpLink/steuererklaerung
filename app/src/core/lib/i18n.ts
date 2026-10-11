/**
 * Translation for strings the CORE hands to a person — without the core importing gettext.
 *
 * The core also runs where GJS's built-in `gettext` module does not exist (the Node build, the
 * web bundle), so it cannot bind a catalogue itself. Instead a frontend that has one registers its
 * translator once at startup (`frontends/desktop/i18n-init.ts`); until then `_` returns the msgid,
 * which is the English source text — exactly what gettext returns for a missing catalogue.
 *
 * `_` is the keyword `dev/i18n.sh extract` collects, so a core msgid lands in `po/*.pot` like any
 * frontend one. Call it when the string is BUILT, not at module level: a module-level call runs
 * before any frontend could register.
 */

let translate: (msgid: string) => string = (msgid) => msgid;

/** Register the frontend's translator (null restores the identity). */
export function setCoreTranslator(translator: ((msgid: string) => string) | null): void {
    translate = translator ?? ((msgid) => msgid);
}

/** Translate one string through the registered translator. */
export function _(msgid: string): string {
    return translate(msgid);
}
