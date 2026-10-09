/**
 * <BhGlossaryHelp> — the native counterpart of the web `<bh-help>`: a small "?" Gtk.MenuButton that
 * opens a Gtk.Popover with a term's plain-German explanation (title in bold + text) from the shared
 * {@link GLOSSARY}. It is the Lernmodus affordance — VISIBLE only when Lernmodus is on AND the term
 * exists in the glossary, so a view can unconditionally attach one next to a label and it simply
 * stays hidden otherwise.
 *
 * The widget itself stays pure: the flag is passed in. {@link lernmodusOn} is the shared READ, so
 * ten views do not each re-derive "the setting, or the env hook when a screenshot needs it" — and
 * {@link helpFor} is the one-liner that attaches a "?" to a PreferencesGroup header, which is where
 * most technical terms in this app actually appear.
 *
 * The setting says "Zeigt in jeder Ansicht kurze Erklärungen der Fachbegriffe". It reached exactly
 * one view (the Übersicht) for its whole life, which made the setting's own description false —
 * the kind of promise an app cannot afford in the release it asks strangers to trust.
 */

import type Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import { GLOSSARY } from '../../../core/lib/glossary.ts';
import { loadAppSettings } from '../../../core/config/index.ts';
import { _ } from '../i18n.ts';

import Template from './glossary-help.blp';

export class BhGlossaryHelp extends Gtk.MenuButton {
    static {
        GObject.registerClass(
            { GTypeName: 'BhGlossaryHelp', Template, InternalChildren: ['title_label', 'text_label'] },
            this,
        );
    }

    declare private _title_label: Gtk.Label;
    declare private _text_label: Gtk.Label;
    private hasEntry = false;
    private lernmodus = false;

    /** @param term glossary key (e.g. `gewinn`); @param lernmodus whether Lernmodus is currently on. */
    constructor(term = '', lernmodus = false) {
        super();
        this.setTerm(term);
        this.setLernmodus(lernmodus);
    }

    /** Point the button at another glossary term (fills the popover; hides the button for unknown terms). */
    setTerm(term: string): void {
        const entry = GLOSSARY[term];
        this.hasEntry = !!entry;
        this._title_label.set_label(entry?.title ?? '');
        this._text_label.set_label(entry?.text ?? '');
        // One translatable sentence with a placeholder, not "word + ': ' + term" glued together:
        // a translator needs the whole sentence to choose its word order and its punctuation.
        this.set_tooltip_text(entry ? _('Explanation: %s').replace('%s', entry.title) : null);
        this.syncVisible();
    }

    /** Toggle the Lernmodus visibility gate (the button only ever shows when Lernmodus is on). */
    setLernmodus(on: boolean): void {
        this.lernmodus = on;
        this.syncVisible();
    }

    private syncVisible(): void {
        this.set_visible(this.lernmodus && this.hasEntry);
    }
}

/**
 * Whether Lernmodus is on — the setting, or `STEUER_APP_LERNMODUS` when a screenshot needs it.
 *
 * Read once per view build rather than watched: the setting changes in a different view, which
 * rebuilds this one anyway.
 */
export function lernmodusOn(): boolean {
    if (process.env.STEUER_APP_LERNMODUS) return true;
    try {
        return loadAppSettings().lernmodus;
    } catch {
        // No settings file yet (first run) is not Lernmodus — and not an error either.
        return false;
    }
}

/**
 * Attach a "?" to a PreferencesGroup's header. Returns the group, so a builder can wrap in place.
 *
 * A group header is where a technical term usually sits ("Umsatzsteuer", "Sonderbetriebsausgaben"),
 * and `header_suffix` is the slot Adwaita gives for exactly this.
 */
export function helpFor<T extends Adw.PreferencesGroup>(group: T, term: string, lernmodus = lernmodusOn()): T {
    const help = new BhGlossaryHelp(term, lernmodus);
    // Only claim the suffix slot when the button will actually show: an invisible widget in there
    // still reserves its space, which shifts every group header by a few pixels for no reason.
    if (help.get_visible()) group.set_header_suffix(help);
    return group;
}
