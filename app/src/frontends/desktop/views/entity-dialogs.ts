/**
 * Renaming and removing an entity from the GUI.
 *
 * Adding one arrived with the setup assistant; these are the other two thirds of the registry, and
 * until now the only way to either was to hand-edit `steuererklaerung.json` — a gitignored file
 * holding real Steuernummern, which is the last file anyone should be opening in a text editor to
 * fix a typo in a display name.
 *
 * Removal is confirmed and rename is not, and that asymmetry is deliberate rather than habit: a
 * name is one field and typing the old one back costs nothing, while removal takes an entity out of
 * the registry with no undo in this app. The confirmation therefore also says what removal does
 * NOT do — the data stays — because "Entfernen" next to a firm name reads like "delete my books".
 */

import Adw from '@girs/adw-1';
import type Gtk from '@girs/gtk-4.0';

import { lockedYearsFor, removeEntity, updateEntity } from '../../../core/actions/entities.ts';
import { markup } from './util.ts';

/** Report the outcome to the caller (which toasts it and reloads). */
export type EntityDialogResult = (message: string, changed: boolean) => void;

/** Rename an entity's display name. The id stays put — things reference it by value. */
export function presentRenameEntity(
    parent: Gtk.Widget,
    entity: { id: string; name: string },
    done: EntityDialogResult,
): void {
    const dialog = new Adw.AlertDialog({
        heading: 'Entität umbenennen',
        body: markup(`Neuer Anzeigename für „${entity.name}".`),
    });

    const group = new Adw.PreferencesGroup();
    const row = new Adw.EntryRow({ title: 'Name' });
    row.set_text(entity.name);
    group.add(row);
    dialog.set_extra_child(group);

    dialog.add_response('cancel', 'Abbrechen');
    dialog.add_response('save', 'Umbenennen');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');

    dialog.connect('response', (_d, response) => {
        if (response !== 'save') return;
        const name = (row.get_text() ?? '').trim();
        if (!name || name === entity.name) return;
        try {
            // Only the display name. The id is carried by ledger rows, filing records and
            // `elster.entity_id`, so changing it here would silently orphan them; the assistant
            // derives it once at creation and it stays.
            updateEntity(entity.id, { name });
            done(`Entität umbenannt: ${name}`, true);
        } catch (err) {
            done(`Umbenennen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, false);
        }
    });
    dialog.present(parent);
}

/** Take an entity out of the registry. Its data is kept. */
export function presentRemoveEntity(
    parent: Gtk.Widget,
    entity: { id: string; name: string },
    done: EntityDialogResult,
): void {
    // Ask the ledger BEFORE offering the action, so a locked entity gets an explanation instead of
    // a refusal after the user has already committed to the decision.
    const locked = lockedYearsFor(entity.id);
    if (locked.length > 0) {
        const blocked = new Adw.AlertDialog({
            heading: 'Entfernen gesperrt',
            body: markup(
                `„${entity.name}" hat festgeschriebene Jahre (${locked.join(', ')}). Festgeschriebene Bücher ` +
                    'müssen der Entität zugeordnet bleiben, unter der sie abgegeben wurden (GoBD).',
            ),
        });
        blocked.add_response('close', 'Verstanden');
        blocked.present(parent);
        return;
    }

    const dialog = new Adw.AlertDialog({
        heading: markup(`„${entity.name}" entfernen?`),
        body: markup(
            'Die Entität verschwindet aus der Liste. Buchungen, Belege, Rechnungen und Abgaben bleiben ' +
                'erhalten — entfernt wird nur der Eintrag, nicht die Daten.',
        ),
    });
    dialog.add_response('cancel', 'Abbrechen');
    dialog.add_response('remove', 'Entfernen');
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_close_response('cancel');

    dialog.connect('response', (_d, response) => {
        if (response !== 'remove') return;
        try {
            removeEntity(entity.id);
            done(`Entität entfernt: ${entity.name}`, true);
        } catch (err) {
            // The last-entity and GoBD refusals both land here; both messages are already written
            // for a human, so pass them through rather than paraphrasing.
            done(err instanceof Error ? err.message : String(err), false);
        }
    });
    dialog.present(parent);
}
