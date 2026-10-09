/**
 * Einstellungen — Klassifizierungsregeln: the counterparty knowledge that classifies a booking
 * without a receipt, and therefore without an AI.
 *
 * The block was writable by hand and by an agent, and by nothing else. That made the app's central
 * claim — usable without AI — false in the one place it mattered most: a person could reclassify
 * one booking at a time forever without the program ever learning anything.
 *
 * Editing is per list, in a dialog rather than inline. A `Adw.EntryRow` per needle inside the
 * settings page would put fifty rows between two unrelated settings, and these lists are read
 * rarely and changed rarely — the settings page shows what is configured and how many, the dialog
 * does the work.
 *
 * ⚠ Removing a needle re-classifies the bookings it used to catch, and thus the EÜR of a year that
 * may already be filed. The dialog says so where the deletion happens, not in a manual.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    NEEDLE_LIST_META,
    loadClassificationRules,
    saveAufwandRegeln,
    saveNeedleList,
    type ClassificationRules,
    type ElsterKlassifizierungRegel,
    type NeedleList,
} from '../../../../core/actions/classification-rules.ts';
import { loadDokumentRegeln, saveDokumentRegeln } from '../../../../core/actions/dokumentregeln.ts';
import type { DokumentRegel } from '../../../../core/dokumentregeln/regeln.ts';
import type { AppEntity } from '../../entities.ts';
import { markup } from '../util.ts';
import type { SettingsHost } from './rows.ts';
import { helpFor } from '../../widgets/glossary-help.ts';

/** The Klassifizierung group: one row per list, each opening its editor. */
export function buildKlassifizierungGroup(
    host: SettingsHost,
    entity: AppEntity,
    parent: Gtk.Widget,
): Adw.PreferencesGroup {
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Klassifizierung',
            description:
                'Wer deine Kunden sind, was für dich privat ist, welcher Lieferant wohin gebucht wird. ' +
                'Buchungen ohne Beleg werden hiernach eingeordnet — das ist der Teil, der die KI ersetzt.',
        }),
        'klassifizierung',
    );

    let rules: ClassificationRules;
    try {
        rules = loadClassificationRules(entity.id);
    } catch (err) {
        host.banner(`Klassifizierungsregeln konnten nicht gelesen werden: ${err instanceof Error ? err.message : err}`);
        return group;
    }

    const rebuild = (): void => {
        // Re-reading beats patching the widgets: the manifest is what the classifier reads, and a
        // row showing a count the file does not have is the drift this whole view guards against.
        host.reloadEntityGroups();
    };

    for (const key of Object.keys(NEEDLE_LIST_META) as NeedleList[]) {
        const meta = NEEDLE_LIST_META[key];
        const entries = rules.lists[key];
        const row = new Adw.ActionRow({
            title: markup(meta.title),
            subtitle: markup(entries.length > 0 ? `${entries.length} × · ${preview(entries)}` : meta.description),
        });
        const button = new Gtk.Button({ label: 'Bearbeiten', valign: Gtk.Align.CENTER });
        button.connect('clicked', () => {
            presentNeedleEditor(parent, meta.title, meta.description, entries, (next) => {
                host.saveWith(() => saveNeedleList(entity.id, key, next), { clearCache: true });
                rebuild();
            });
        });
        row.add_suffix(button);
        row.set_activatable_widget(button);
        group.add(row);
    }

    const rulesRow = new Adw.ActionRow({
        title: 'Lieferant → Kategorie',
        subtitle: markup(
            rules.aufwandRegeln.length > 0
                ? `${rules.aufwandRegeln.length} × · ${rules.aufwandRegeln
                      .slice(0, 2)
                      .map((r) => `${r.muster} → ${r.kategorie}`)
                      .join(' · ')}`
                : 'Eigene Regeln, die vor der eingebauten Stichwortliste greifen.',
        ),
    });
    const rulesButton = new Gtk.Button({ label: 'Bearbeiten', valign: Gtk.Align.CENTER });
    rulesButton.connect('clicked', () => {
        presentRuleEditor(parent, rules.aufwandRegeln, (next) => {
            host.saveWith(() => saveAufwandRegeln(entity.id, next), { clearCache: true });
            rebuild();
        });
    });
    rulesRow.add_suffix(rulesButton);
    rulesRow.set_activatable_widget(rulesButton);
    group.add(rulesRow);

    // Dokumentregeln (Idee 11) belong to the built-in DMS; Paperless does its own matching.
    if (entity.dmsType === 'builtin') {
        let belegRegeln: DokumentRegel[] = [];
        try {
            belegRegeln = loadDokumentRegeln(entity.id);
        } catch (err) {
            host.banner(`Dokumentregeln konnten nicht gelesen werden: ${err instanceof Error ? err.message : err}`);
        }
        const belegRow = new Adw.ActionRow({
            title: 'Beleg → Dokumenttyp, Kategorie',
            subtitle: markup(
                belegRegeln.length > 0
                    ? `${belegRegeln.length} × · ${belegRegeln
                          .slice(0, 2)
                          .map((r) => r.muster)
                          .join(' · ')}`
                    : 'Entstehen mit „Als Regel merken" im Beleg-Dialog; greifen beim Hinzufügen eines Belegs, vor jeder KI.',
            ),
        });
        const belegButton = new Gtk.Button({ label: 'Bearbeiten', valign: Gtk.Align.CENTER });
        belegButton.connect('clicked', () => {
            presentBelegRegelEditor(parent, belegRegeln, (next) => {
                host.saveWith(() => saveDokumentRegeln(entity.id, next), { clearCache: false });
                rebuild();
            });
        });
        belegRow.add_suffix(belegButton);
        belegRow.set_activatable_widget(belegButton);
        group.add(belegRow);
    }

    return group;
}

/** First two entries, so the row says something concrete rather than only a count. */
function preview(entries: readonly string[]): string {
    const shown = entries.slice(0, 2).join(' · ');
    return entries.length > 2 ? `${shown} …` : shown;
}

/** A dialog editing one needle list: one EntryRow per entry, plus an empty one to add. */
function presentNeedleEditor(
    parent: Gtk.Widget,
    title: string,
    description: string,
    entries: readonly string[],
    done: (next: string[]) => void,
): void {
    const dialog = new Adw.Dialog();
    dialog.set_title(title);
    dialog.set_content_width(560);
    dialog.set_content_height(600);

    const group = new Adw.PreferencesGroup({ description: markup(description) });
    const rows: Adw.EntryRow[] = [];

    const addRow = (text: string): Adw.EntryRow => {
        const row = new Adw.EntryRow({ title: 'Text im Buchungstext' });
        row.set_text(text);
        const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.set_tooltip_text('Eintrag entfernen — ändert die Einordnung bereits gebuchter Jahre');
        remove.connect('clicked', () => {
            row.set_text('');
            row.set_visible(false);
        });
        row.add_suffix(remove);
        rows.push(row);
        group.add(row);
        return row;
    };

    for (const e of entries) addRow(e);
    addRow('');

    const page = new Adw.PreferencesPage();
    page.add(group);

    const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
    scroller.set_child(page);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(scroller);
    toolbar.add_bottom_bar(
        bottomBar([
            { label: 'Zeile hinzufügen', run: () => addRow('').grab_focus() },
            {
                label: 'Speichern',
                suggested: true,
                run: () => {
                    done(rows.map((r) => r.get_text() ?? ''));
                    dialog.close();
                },
            },
        ]),
    );
    dialog.set_child(toolbar);
    dialog.present(parent);
}

/** A dialog editing the supplier→category rules: two fields per rule. */
function presentRuleEditor(
    parent: Gtk.Widget,
    rules: readonly ElsterKlassifizierungRegel[],
    done: (next: ElsterKlassifizierungRegel[]) => void,
): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Lieferant → Kategorie');
    dialog.set_content_width(620);
    dialog.set_content_height(640);

    const group = new Adw.PreferencesGroup({
        description: markup(
            'Diese Regeln greifen VOR der eingebauten Stichwortliste — eine eigene Regel gewinnt also ' +
                'über ein allgemeines Stichwort, das denselben Text fangen würde.',
        ),
    });
    const pairs: Array<{ muster: Adw.EntryRow; kategorie: Adw.EntryRow; ausnahmen: string[] }> = [];

    const addPair = (rule: ElsterKlassifizierungRegel | null): Adw.EntryRow => {
        const muster = new Adw.EntryRow({ title: 'Text im Buchungstext' });
        muster.set_text(rule?.muster ?? '');
        const kategorie = new Adw.EntryRow({ title: 'Kategorie (SKR03, wie in der EÜR)' });
        kategorie.set_text(rule?.kategorie ?? '');
        const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.set_tooltip_text('Regel entfernen — ändert die Einordnung bereits gebuchter Jahre');
        remove.connect('clicked', () => {
            muster.set_text('');
            kategorie.set_text('');
            muster.set_visible(false);
            kategorie.set_visible(false);
        });
        muster.add_suffix(remove);
        group.add(muster);
        group.add(kategorie);
        const pair = { muster, kategorie, ausnahmen: [...(rule?.ausnahmen ?? [])] };
        // The bookings deselected in „Regel aus Auswahl" — kept on save, and removable here, so the
        // exception list is never a field only a text editor can reach.
        if (pair.ausnahmen.length > 0) {
            const row = new Adw.ActionRow({
                title: `${pair.ausnahmen.length} Ausnahme(n)`,
                subtitle: 'Buchungen, die beim Anlegen abgewählt wurden — die Regel lässt sie aus.',
            });
            const clear = new Gtk.Button({ label: 'Aufheben', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
            clear.set_tooltip_text('Ausnahmen aufheben — die Regel erfasst diese Buchungen dann wieder');
            clear.connect('clicked', () => {
                pair.ausnahmen = [];
                row.set_visible(false);
            });
            row.add_suffix(clear);
            group.add(row);
        }
        pairs.push(pair);
        return muster;
    };

    for (const r of rules) addPair(r);
    addPair(null);

    const page = new Adw.PreferencesPage();
    page.add(group);
    const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
    scroller.set_child(page);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(scroller);
    toolbar.add_bottom_bar(
        bottomBar([
            { label: 'Regel hinzufügen', run: () => addPair(null).grab_focus() },
            {
                label: 'Speichern',
                suggested: true,
                run: () => {
                    done(
                        pairs.map((p) => ({
                            muster: p.muster.get_text() ?? '',
                            kategorie: p.kategorie.get_text() ?? '',
                            ...(p.ausnahmen.length ? { ausnahmen: p.ausnahmen } : {}),
                        })),
                    );
                    dialog.close();
                },
            },
        ]),
    );
    dialog.set_child(toolbar);
    dialog.present(parent);
}

const RICHTUNG_CHOICES: Array<{ id: DokumentRegel['richtung'] | null; label: string }> = [
    { id: null, label: '—' },
    { id: 'incoming', label: 'Eingang (Ausgabe)' },
    { id: 'outgoing', label: 'Ausgang (Einnahme)' },
];

/**
 * A dialog editing the Dokumentregeln: pattern, sender, document type, category and direction per rule.
 * Unlike the booking rules above, deleting one is harmless for filed years — the values already sit on
 * the receipts the rule filled; only future receipts are no longer covered.
 */
function presentBelegRegelEditor(
    parent: Gtk.Widget,
    rules: readonly DokumentRegel[],
    done: (next: DokumentRegel[]) => void,
): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Beleg → Dokumenttyp, Kategorie');
    dialog.set_content_width(620);
    dialog.set_content_height(680);

    const group = new Adw.PreferencesGroup({
        description: markup(
            'Beim Hinzufügen eines Belegs setzt die erste passende Regel, was noch leer ist — vor der KI. ' +
                'Eine Regel zu entfernen ändert keinen vorhandenen Beleg.',
        ),
    });
    const sets: Array<{
        muster: Adw.EntryRow;
        korrespondent: Adw.EntryRow;
        dokumenttyp: Adw.EntryRow;
        kategorie: Adw.EntryRow;
        richtung: Adw.ComboRow;
        ausnahmen: string[];
    }> = [];

    const addSet = (rule: DokumentRegel | null): Adw.EntryRow => {
        const muster = new Adw.EntryRow({ title: 'Text im Beleg (Absender, Titel, Dateiname)' });
        muster.set_text(rule?.muster ?? '');
        const korrespondent = new Adw.EntryRow({ title: 'Korrespondent' });
        korrespondent.set_text(rule?.korrespondent ?? '');
        const dokumenttyp = new Adw.EntryRow({ title: 'Dokumenttyp' });
        dokumenttyp.set_text(rule?.dokumenttyp ?? '');
        const kategorie = new Adw.EntryRow({ title: 'Kategorie (SKR03, wie in der EÜR)' });
        kategorie.set_text(rule?.kategorie ?? '');
        const richtung = new Adw.ComboRow({
            title: 'Richtung',
            model: Gtk.StringList.new(RICHTUNG_CHOICES.map((c) => c.label)),
        });
        richtung.set_selected(
            Math.max(
                0,
                RICHTUNG_CHOICES.findIndex((c) => c.id === (rule?.richtung ?? null)),
            ),
        );
        const all: Gtk.Widget[] = [muster, korrespondent, dokumenttyp, kategorie, richtung];
        const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.set_tooltip_text('Regel entfernen — vorhandene Belege behalten ihre Werte');
        remove.connect('clicked', () => {
            muster.set_text('');
            for (const w of all) w.set_visible(false);
        });
        muster.add_suffix(remove);
        for (const w of all) group.add(w);
        sets.push({ muster, korrespondent, dokumenttyp, kategorie, richtung, ausnahmen: [...(rule?.ausnahmen ?? [])] });
        return muster;
    };

    for (const r of rules) addSet(r);
    addSet(null);

    const page = new Adw.PreferencesPage();
    page.add(group);
    const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
    scroller.set_child(page);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(scroller);
    toolbar.add_bottom_bar(
        bottomBar([
            { label: 'Regel hinzufügen', run: () => addSet(null).grab_focus() },
            {
                label: 'Speichern',
                suggested: true,
                run: () => {
                    const text = (row: Adw.EntryRow): string | undefined => row.get_text()?.trim() || undefined;
                    done(
                        sets.map((p) => ({
                            muster: p.muster.get_text() ?? '',
                            korrespondent: text(p.korrespondent),
                            dokumenttyp: text(p.dokumenttyp),
                            kategorie: text(p.kategorie),
                            richtung: RICHTUNG_CHOICES[p.richtung.get_selected()]?.id ?? undefined,
                            ausnahmen: p.ausnahmen,
                        })),
                    );
                    dialog.close();
                },
            },
        ]),
    );
    dialog.set_child(toolbar);
    dialog.present(parent);
}

function bottomBar(buttons: Array<{ label: string; run: () => void; suggested?: boolean }>): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
        marginTop: 10,
        marginBottom: 12,
        marginStart: 12,
        marginEnd: 12,
    });
    for (const b of buttons) {
        const button = new Gtk.Button({ label: b.label });
        button.add_css_class('pill');
        if (b.suggested) button.add_css_class('suggested-action');
        button.connect('clicked', b.run);
        box.append(button);
    }
    return box;
}
