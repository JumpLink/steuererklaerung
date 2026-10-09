/**
 * The origin line of a receipt's classification (Idee 11): which Dokumentregel set its fields.
 *
 * Built-in DMS: the rule is stored on the receipt (`ruleOrigin`), so the row states it as a fact —
 * „via Regel „Deutsche Telekom AG“ gesetzt: Dokumenttyp und Kategorie".
 *
 * Paperless: the matching is Paperless' own and it does not record which rule assigned a value, so
 * the row asks `paperlessZuordnung` (re-runs the rules against the document's text) and says
 * „vermutlich". It loads after the detail is on screen — three list calls must not hold it up.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { paperlessZuordnungForEntity } from '../../../core/actions/paperless/zuordnung.ts';
import { herkunftSatz } from '../../../core/dokumentregeln/regeln.ts';
import type { DmsDocument } from '../../../core/presenters/belege.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { markup } from './util.ts';

function baseRow(title: string, icon: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title: markup(title) });
    row.set_title_lines(0);
    row.set_subtitle_lines(0);
    row.add_prefix(new Gtk.Image({ iconName: icon, cssClasses: ['dim-label'] }));
    const help = new BhGlossaryHelp('dokumentregel', lernmodusOn());
    if (help.get_visible()) row.add_suffix(help);
    return row;
}

/** The „via Regel …" row of a built-in receipt a rule filled; null when none did. */
export function regelHerkunftRow(doc: Pick<DmsDocument, 'ruleOrigin'>): Adw.ActionRow | null {
    if (!doc.ruleOrigin) return null;
    return baseRow(herkunftSatz(doc.ruleOrigin), 'emblem-system-symbolic');
}

/** The Paperless row: a placeholder now, the explanation once Paperless has answered. */
export function paperlessZuordnungRow(entityId: string, doc: Pick<DmsDocument, 'id'>): Adw.ActionRow {
    const row = baseRow('Paperless-Zuordnung …', 'emblem-system-symbolic');
    row.set_subtitle('Prüfe, welche Paperless-Regel gegriffen hat');
    void paperlessZuordnungForEntity(entityId, Number(doc.id)).then(
        (result) => {
            row.set_title(markup(result.kopf));
            row.set_subtitle(markup(result.eintraege.map((e) => e.satz).join('\n')));
        },
        (err: unknown) => {
            row.set_title('Paperless-Zuordnung nicht verfügbar');
            row.set_subtitle(markup(err instanceof Error ? err.message : String(err)));
        },
    );
    return row;
}
