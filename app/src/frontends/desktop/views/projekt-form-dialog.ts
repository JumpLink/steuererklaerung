/**
 * <BhProjektFormDialog> — create / edit a project, the native counterpart to `projects add|edit`.
 *
 * An Adw.PreferencesDialog: the project's own fields on top (Name, Kunde as a contact picker,
 * Domains), then the Kontaktperson the cover letters address (Anrede, Vorname, Anredeform) and a
 * note. Writes go through the project actions, so the same checks as the CLI apply — a customer that
 * does not exist, or a change of customer while a contract belongs to the project, comes back as a
 * message instead of a half-saved state.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { contactDisplayName } from '@steuererklaerung/store';
import type { MailTemplate } from '../../../core/config/index.ts';
import { addProject, type Contact, type Project, updateProject } from '../data/projects.ts';
import { loadInvoicing } from '../data/settings.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';

/** Anredeform options in combo order: unset falls through to the contract, then to `du`. */
const FORMALITY_OPTIONS: Array<{ label: string; value: 'du' | 'sie' | null }> = [
    { label: 'wie im Vertrag', value: null },
    { label: 'Du', value: 'du' },
    { label: 'Sie', value: 'sie' },
];

export class BhProjektFormDialog {
    private readonly dialog = new Adw.PreferencesDialog();
    private entity!: AppEntity;
    private existing: Project | null = null;
    private onSaved: (() => void) | null = null;
    /** The contacts offered as customer, in combo order. */
    private customers: Contact[] = [];

    private nameRow!: Adw.EntryRow;
    private customerRow!: Adw.ComboRow;
    private domainsRow!: Adw.EntryRow;
    private greetingRow!: Adw.EntryRow;
    private firstNameRow!: Adw.EntryRow;
    private formalityRow!: Adw.ComboRow;
    private notesRow!: Adw.EntryRow;
    private templateRow!: Adw.ComboRow;
    private templates: MailTemplate[] = [];
    private saveButton!: Adw.ButtonRow;

    open(
        parent: Gtk.Widget,
        entity: AppEntity,
        contacts: Contact[],
        existing: Project | null,
        onSaved: () => void,
    ): void {
        this.entity = entity;
        this.existing = existing;
        this.onSaved = onSaved;
        // Customers, plus the project's current contact even when it is no longer flagged as one —
        // otherwise opening the form would silently re-point the project at the first customer.
        this.customers = contacts
            .filter((c) => c.isCustomer || c.id === existing?.contactId)
            .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b), 'de'));
        this.build(parent);
    }

    private build(parent: Gtk.Widget): void {
        const p = this.existing;
        this.dialog.set_title(p ? 'Projekt bearbeiten' : 'Neues Projekt');
        const page = new Adw.PreferencesPage();

        const master = new Adw.PreferencesGroup({ title: 'Projekt' });
        this.nameRow = new Adw.EntryRow({ title: 'Name', text: p?.name ?? '' });
        this.customerRow = new Adw.ComboRow({
            title: 'Kunde',
            model: Gtk.StringList.new(this.customers.map((c) => contactDisplayName(c))),
        });
        this.customerRow.set_selected(
            Math.max(
                0,
                this.customers.findIndex((c) => c.id === p?.contactId),
            ),
        );
        if (this.customers.length === 0) {
            this.customerRow.set_subtitle('Zuerst unter Kontakte einen Kunden anlegen');
            this.customerRow.set_sensitive(false);
        }
        this.domainsRow = new Adw.EntryRow({
            title: 'Domains (mit Komma getrennt)',
            text: (p?.domains ?? []).join(', '),
        });
        for (const row of [this.nameRow, this.customerRow, this.domainsRow]) master.add(row);
        page.add(master);

        const person = new Adw.PreferencesGroup({
            title: 'Kontaktperson',
            description:
                'Wer im Anschreiben angesprochen wird. Leere Felder fallen auf die Angaben im wiederkehrenden Vertrag zurück.',
        });
        this.greetingRow = new Adw.EntryRow({
            title: 'Anrede (z. B. „Silke"; leer = vom Vertrag)',
            text: p?.contactPerson?.greeting ?? '',
        });
        this.firstNameRow = new Adw.EntryRow({ title: 'Vorname', text: p?.contactPerson?.firstName ?? '' });
        this.formalityRow = new Adw.ComboRow({
            title: 'Anredeform',
            model: Gtk.StringList.new(FORMALITY_OPTIONS.map((o) => o.label)),
        });
        this.formalityRow.set_selected(
            Math.max(
                0,
                FORMALITY_OPTIONS.findIndex((o) => o.value === (p?.contactPerson?.formality ?? null)),
            ),
        );
        for (const row of [this.greetingRow, this.firstNameRow, this.formalityRow]) person.add(row);
        page.add(person);

        this.templates = loadInvoicing(this.entity).mailTemplates;
        this.templateRow = new Adw.ComboRow({
            title: 'Mail-Vorlage',
            subtitle: 'Für die Verträge dieses Projekts; ein Vertrag kann eine eigene wählen',
            model: Gtk.StringList.new(['wie Standard der Entität', ...this.templates.map((t) => t.name)]),
        });
        this.templateRow.set_selected(Math.max(0, this.templates.findIndex((t) => t.id === p?.mailTemplateId) + 1));
        this.templateRow.set_sensitive(this.templates.length > 0);
        person.add(this.templateRow);

        const extra = new Adw.PreferencesGroup({ title: 'Notiz' });
        this.notesRow = new Adw.EntryRow({ title: 'Notiz', text: p?.notes ?? '' });
        extra.add(this.notesRow);
        page.add(extra);

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
        const customer = this.customers[this.customerRow.get_selected()];
        if (!text(this.nameRow)) return void (await this.fail('Der Projektname fehlt.'));
        if (!customer) return void (await this.fail('Bitte einen Kunden wählen.'));
        const contactPerson = {
            greeting: text(this.greetingRow) || null,
            firstName: text(this.firstNameRow) || null,
            formality: FORMALITY_OPTIONS[this.formalityRow.get_selected()]?.value ?? null,
        };
        const common = {
            name: text(this.nameRow),
            contactId: customer.id,
            domains: text(this.domainsRow).split(','),
            contactPerson,
            notes: text(this.notesRow) || null,
            mailTemplateId: this.templates[this.templateRow.get_selected() - 1]?.id ?? null,
        };
        this.saveButton.set_sensitive(false);
        this.saveButton.set_title('Speichere …');
        try {
            if (this.existing) updateProject(this.entity.id, this.existing.id, common);
            else addProject(this.entity.id, common);
            this.dialog.close();
            showToast(this.existing ? 'Projekt aktualisiert' : 'Projekt angelegt');
            this.onSaved?.();
        } catch (err) {
            this.saveButton.set_sensitive(true);
            this.saveButton.set_title('Speichern');
            await this.fail(err instanceof Error ? err.message : String(err));
        }
    }

    private fail(message: string): Promise<void> {
        return errorDialog(this.dialog, 'Speichern fehlgeschlagen', message);
    }
}
