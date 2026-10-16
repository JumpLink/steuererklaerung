/**
 * Translation for strings the CORE hands to a person — without the core importing gettext.
 *
 * The core also runs where GJS's built-in `gettext` module does not exist (the Node build, the
 * web bundle), so it cannot bind a catalogue itself. Instead a frontend that has one registers its
 * translator once at startup (`frontends/desktop/i18n-init.ts`); until then `_` returns the msgid,
 * which is the English source text — exactly what gettext returns for a missing catalogue.
 *
 * `_`, `_n` and `_p` are keywords `dev/i18n.sh extract` collects, so a core msgid lands in `po/*.pot`
 * like any frontend one. Call them when the string is BUILT, not at module level: a module-level
 * call runs before any frontend could register.
 *
 * Which frontends have one: the desktop app registers in `frontends/desktop/i18n-init.ts`. The CLI
 * and the web server do not — they bind no catalogue at all — so they read these strings in the
 * English source, which is the state `docs/app/i18n-status.md` records as the open gap.
 */

/**
 * The three gettext calls the core needs, mirroring `dgettext` / `dngettext` / `dpgettext`.
 *
 * One object rather than three arguments: a frontend registers all of them or none, and a later
 * fourth does not change the call site of the one that exists.
 */
export interface CoreTranslator {
    gettext: (msgid: string) => string;
    /** Both English forms go in — the CATALOGUE decides which one a count needs. */
    ngettext: (singular: string, plural: string, n: number) => string;
    pgettext: (context: string, msgid: string) => string;
}

/** What a missing catalogue gives: the msgid, under the source language's own plural rule. */
const SOURCE: CoreTranslator = {
    gettext: (msgid) => msgid,
    ngettext: (singular, plural, n) => (n === 1 ? singular : plural),
    pgettext: (_context, msgid) => msgid,
};

let current: CoreTranslator = SOURCE;

/** Register the frontend's translator (null restores the English source strings). */
export function setCoreTranslator(translator: CoreTranslator | null): void {
    current = translator ?? SOURCE;
}

/** Translate one string through the registered translator. */
export function _(msgid: string): string {
    return current.gettext(msgid);
}

/**
 * Translate a counted string, letting the target language pick its own plural form.
 *
 * Never replace this with an `n === 1` check at the call site: that hard-codes English's rule into
 * every language the catalogue may later carry.
 */
export function _n(singular: string, plural: string, n: number): string {
    return current.ngettext(singular, plural, n);
}

/**
 * Translate with a disambiguating context — for the case where one English string is two different
 * German ones, which a translator cannot resolve from the string alone.
 */
export function _p(context: string, msgid: string): string {
    return current.pgettext(context, msgid);
}

/** Fill `{name}` placeholders in an already translated string (named, so a translation may reorder them). */
export function fmt(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
