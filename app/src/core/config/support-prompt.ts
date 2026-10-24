/**
 * The support prompt: one friendly, dismissible note after a successful ELSTER filing, once per tax
 * year, and only where the distribution channel allows donation UI at all.
 *
 * Support is business income (a Betriebseinnahme) for the maker — NEVER a "Spende", never with a
 * receipt, and nothing in the wording may suggest it is tax-deductible. The year it was shown for is
 * kept in the per-user settings, written when the prompt appears rather than when it is answered:
 * a crash or a force-quit must not turn one missed prompt into a prompt on every start.
 */

import { donationsAllowed } from '@gjsify/distribution';

import { loadUserSettings, updateUserSettings } from './user-settings.ts';

/** Where the support page lives, per language of the site (`de` or `en`). */
export function supportUrl(lang: SupportLang): string {
    return `https://jumplink.eu/steuererklaerung/${lang}/support/`;
}

export type SupportLang = 'de' | 'en';

/** A legal page of the project site, per language: the privacy statement or the legal notice. */
export function sitePageUrl(page: 'privacy' | 'legal-notice', lang: SupportLang): string {
    return `https://jumplink.eu/steuererklaerung/${lang}/${page}/`;
}

/**
 * `de` for a German session, `en` for everything else — the same rule `initLocale()` applies to the
 * catalogue, so the page matches the language of the dialog that links to it. `names` is
 * `GLib.get_language_names()`: the preferred one first (`de_DE.UTF-8`, `de_DE`, `de`, `C`).
 */
export function supportLang(names: readonly string[]): SupportLang {
    return names[0]?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/**
 * Whether to ask now: the channel allows it (`allowed`, i.e. {@link donationsAllowed}) and this tax
 * year has not been asked about yet. Pure, so the decision is testable without a settings file.
 */
export function shouldPromptSupport(
    allowed: boolean,
    shownYears: readonly number[] | undefined,
    year: number,
): boolean {
    return allowed && !(shownYears ?? []).includes(year);
}

/**
 * Decide for the real settings file and, when the answer is yes, record the year immediately. Returns
 * whether the caller should show the prompt. Never throws: a settings file that cannot be written
 * must not break a filing, it only means the prompt may come again.
 */
export function claimSupportPrompt(year: number, allowed: boolean = donationsAllowed()): boolean {
    try {
        if (!shouldPromptSupport(allowed, loadUserSettings().supportPromptYears, year)) return false;
        updateUserSettings((s) => {
            s.supportPromptYears = [...new Set([...(s.supportPromptYears ?? []), year])].sort((a, b) => a - b);
        });
        return true;
    } catch (err) {
        console.error(`[support] could not record the prompt: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
