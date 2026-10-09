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
import { _, fmt } from '../i18n.ts';

/** Report the outcome to the caller (which toasts it and reloads). */
export type EntityDialogResult = (message: string, changed: boolean) => void;

/** Rename an entity's display name. The id stays put — things reference it by value. */
export function presentRenameEntity(
    parent: Gtk.Widget,
    entity: { id: string; name: string },
    done: EntityDialogResult,
): void {
    const dialog = new Adw.AlertDialog({
        heading: _('Rename entity'),
        body: markup(fmt(_('New display name for “{name}”.'), { name: entity.name })),
    });

    const group = new Adw.PreferencesGroup();
    const row = new Adw.EntryRow({ title: _('Name') });
    row.set_text(entity.name);
    group.add(row);
    dialog.set_extra_child(group);

    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('save', _('Rename'));
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
            done(fmt(_('Entity renamed: {name}'), { name }), true);
        } catch (err) {
            done(fmt(_('Rename failed: {error}'), { error: err instanceof Error ? err.message : String(err) }), false);
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
            heading: _('Removal blocked'),
            body: markup(
                fmt(
                    _(
                        '“{name}” has locked years ({years}). Locked books must stay with the entity ' +
                            'under which they were filed (GoBD).',
                    ),
                    { name: entity.name, years: locked.join(', ') },
                ),
            ),
        });
        blocked.add_response('close', _('Got it'));
        blocked.present(parent);
        return;
    }

    const dialog = new Adw.AlertDialog({
        heading: markup(fmt(_('Remove “{name}”?'), { name: entity.name })),
        body: markup(
            _(
                'The entity disappears from the list. Transactions, receipts, invoices and filings are ' +
                    'kept — only the entry is removed, not the data.',
            ),
        ),
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('remove', _('Remove'));
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_close_response('cancel');

    dialog.connect('response', (_d, response) => {
        if (response !== 'remove') return;
        try {
            removeEntity(entity.id);
            done(fmt(_('Entity removed: {name}'), { name: entity.name }), true);
        } catch (err) {
            // The last-entity and GoBD refusals both land here; both messages are already written
            // for a human, so pass them through rather than paraphrasing.
            done(err instanceof Error ? err.message : String(err), false);
        }
    });
    dialog.present(parent);
}
