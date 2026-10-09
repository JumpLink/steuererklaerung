/**
 * <BhKontaktFormDialog> — create / edit a contact (party), the native counterpart to the web
 * add/edit flow in <bh-kontakte-view>. An Adw.PreferencesDialog with a Stammdaten group
 * (Anzeigename/Firma, Vorname, Nachname, E-Mail, USt-IdNr. + an "Art" combo) and a Rollen group
 * (Kunde / Lieferant switches). Writes go through the data layer's `saveContact` (store only, no
 * network); `open(parent, entity, existing|null, onSaved)` mirrors rechnung-form-dialog so the view
 * can refresh on save. Fields the form does not expose (taxId/iban/address/…) are omitted from the
 * input so upsertContact preserves them on edit — an imported Qonto contact keeps its address.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { type Contact, type ContactInput, saveContact } from '../data/contacts.ts';
import type { AppEntity } from '../entities.ts';
import { errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';

/** Contact kinds in combo-row order; the combo's selected index maps back to these. */
const KINDS: ContactInput['kind'][] = ['company', 'individual', 'freelancer', 'organization'];

/** German combo labels, parallel to KINDS. */
const KIND_LABELS = ['Firma', 'Person', 'Freiberuflich', 'Organisation'];

export class BhKontaktFormDialog {
    private readonly dialog = new Adw.PreferencesDialog();
    private entity!: AppEntity;
    /** The contact being edited (null → create); its non-form fields survive a save. */
    private existing: Contact | null = null;
    private onSaved: (() => void) | null = null;

    private nameRow!: Adw.EntryRow;
    private firstNameRow!: Adw.EntryRow;
    private lastNameRow!: Adw.EntryRow;
    private emailRow!: Adw.EntryRow;
    private vatRow!: Adw.EntryRow;
    private kindRow!: Adw.ComboRow;
    private customerRow!: Adw.SwitchRow;
    private supplierRow!: Adw.SwitchRow;
    private saveButton!: Adw.ButtonRow;

    open(parent: Gtk.Widget, entity: AppEntity, existing: Contact | null, onSaved: () => void): void {
        this.entity = entity;
        this.existing = existing;
        this.onSaved = onSaved;
        this.build(parent);
    }

    private build(parent: Gtk.Widget): void {
        const c = this.existing;
        this.dialog.set_title(c ? 'Kontakt bearbeiten' : 'Neuer Kontakt');

        const page = new Adw.PreferencesPage();

        // Stammdaten.
        const master = new Adw.PreferencesGroup({ title: 'Stammdaten' });
        this.nameRow = new Adw.EntryRow({ title: 'Anzeigename / Firma', text: c?.name ?? '' });
        this.firstNameRow = new Adw.EntryRow({ title: 'Vorname', text: c?.firstName ?? '' });
        this.lastNameRow = new Adw.EntryRow({ title: 'Nachname', text: c?.lastName ?? '' });
        this.emailRow = new Adw.EntryRow({ title: 'E-Mail', text: c?.email ?? '' });
        this.vatRow = new Adw.EntryRow({ title: 'USt-IdNr.', text: c?.vatNumber ?? '' });
        const kinds = new Gtk.StringList();
        for (const l of KIND_LABELS) kinds.append(l);
        this.kindRow = new Adw.ComboRow({ title: 'Art', model: kinds });
        this.kindRow.set_selected(Math.max(0, KINDS.indexOf(c?.kind ?? 'company')));
        for (const r of [this.nameRow, this.firstNameRow, this.lastNameRow, this.emailRow, this.vatRow, this.kindRow])
            master.add(r);
        page.add(master);

        // Rollen.
        const roles = new Adw.PreferencesGroup({ title: 'Rollen' });
        this.customerRow = new Adw.SwitchRow({ title: 'Kunde', subtitle: 'Rechnungen → Qonto' });
        this.customerRow.set_active(c?.isCustomer ?? false);
        this.supplierRow = new Adw.SwitchRow({ title: 'Lieferant', subtitle: 'Belege → Paperless' });
        this.supplierRow.set_active(c?.isSupplier ?? false);
        roles.add(this.customerRow);
        roles.add(this.supplierRow);
        page.add(roles);

        // Speichern.
        const actions = new Adw.PreferencesGroup();
        this.saveButton = new Adw.ButtonRow({ title: 'Speichern' });
        this.saveButton.add_css_class('suggested-action');
        this.saveButton.connect('activated', () => void this.save());
        actions.add(this.saveButton);
        page.add(actions);

        this.dialog.add(page);
        this.dialog.present(parent);
    }

    private async save(): Promise<void> {
        const text = (row: Adw.EntryRow): string => row.get_text()?.trim() ?? '';
        // Only the 8 form fields go in; the rest are omitted so upsertContact preserves them on edit.
        const input: ContactInput = {
            entityId: this.entity.id,
            ...(this.existing ? { id: this.existing.id } : {}),
            kind: KINDS[this.kindRow.get_selected()] ?? 'company',
            name: text(this.nameRow),
            firstName: text(this.firstNameRow),
            lastName: text(this.lastNameRow),
            email: text(this.emailRow),
            vatNumber: text(this.vatRow),
            isCustomer: this.customerRow.get_active(),
            isSupplier: this.supplierRow.get_active(),
        };
        this.saveButton.set_sensitive(false);
        this.saveButton.set_title('Speichere …');
        try {
            // saveContact is a synchronous store write; awaiting a plain value is harmless and keeps
            // the shape identical to the invoice form should this ever move off the store.
            saveContact(input);
            this.dialog.close();
            showToast(this.existing ? 'Kontakt aktualisiert' : 'Kontakt angelegt');
            this.onSaved?.();
        } catch (err) {
            this.saveButton.set_sensitive(true);
            this.saveButton.set_title('Speichern');
            await errorDialog(
                this.dialog,
                'Speichern fehlgeschlagen',
                err instanceof Error ? err.message : String(err),
            );
        }
    }
}
