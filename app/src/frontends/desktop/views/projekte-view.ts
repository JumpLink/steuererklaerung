/**
 * <BhProjekteView> — the Projekte view (list + full CRUD).
 *
 * A project joins a customer contact, its domains and the person the cover letters address to the
 * recurring invoices that belong together. One row per project (name, customer, domains, contracts);
 * the list-group header carries "＋ Projekt hinzufügen". A row is activatable → edit; a per-row
 * "Löschen" confirms via Adw.AlertDialog and is refused by the action while a contract still belongs
 * to the project. Manifest + store reads/writes only (see data/projects.ts); entity-scoped.
 *
 * Since Idee 14 a row opens the project detail (Projektergebnis of the selected year, the assigned
 * expenses and the project rules); „Bearbeiten“ there opens the form. The row subtitle shows the
 * result, so the list answers „what did this project bring?“ without a click.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './projekte-view.blp';
import { contactDisplayName } from '@steuererklaerung/store';
import { loadProjektAnsicht, type ProjektAnsicht } from '../../../core/presenters/projekt.ts';
import { eur } from '../../../core/lib/format.ts';
import { appSession } from '../data/session.ts';
import { loadProjectsData, type Project, type ProjectsData, removeProject } from '../data/projects.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { BhProjektDetailDialog } from './projekt-detail-dialog.ts';
import { BhProjektFormDialog } from './projekt-form-dialog.ts';
import { GroupRows, LoadToken, emptyState, explainerRow, loadIntoStack, markup } from './util.ts';
import { onNarrow } from '../widgets/narrow.ts';
import { explainerPlacement, phoneSubtitleLines } from '../widgets/phone-rules.ts';
import { hideOnPhone, phoneRowActions, rowActions, wrapButtonLabel } from '../widgets/responsive.ts';
import type { ViewAction } from '../view.ts';
import { _, _n, fmt } from '../i18n.ts';
import { errorText } from '../error-text.ts';

export class BhProjekteView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _summary_group: Adw.PreferencesGroup;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhProjekteView',
                Template,
                InternalChildren: ['stack', 'error_page', 'summary_group', 'list_group'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly summary: GroupRows;
    private readonly list: GroupRows;
    private entity: AppEntity | null = null;
    private year = new Date().getFullYear();
    private data: ProjectsData | null = null;
    private ansicht: ProjektAnsicht | null = null;
    private phone = false;

    constructor() {
        super();
        this.summary = new GroupRows(this._summary_group);
        this.list = new GroupRows(this._list_group);
        onNarrow(this, (narrow) => {
            if (narrow === this.phone) return;
            this.phone = narrow;
            if (this.data) this.fill(this.data);
        });
    }

    /** `Add a project` lives in the content header bar on a phone. */
    headerActions(): ViewAction[] {
        return [{ label: _('Add a project'), primary: true, run: () => this.openForm(null) }];
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        this.load(entity);
    }

    private load(entity: AppEntity): void {
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Projects could not be loaded'),
            load: async () => ({
                data: loadProjectsData(entity.id),
                // The result needs the year's EÜR; a project list must not fail with it.
                ansicht: await loadProjektAnsicht(appSession(), entity, this.year).catch((err: unknown) => {
                    console.error(`[app] Projektergebnis: ${err instanceof Error ? err.message : err}`);
                    return null;
                }),
            }),
            fill: ({ data, ansicht }) => {
                this.ansicht = ansicht;
                this.fill(data);
            },
        });
    }

    /** Re-read + re-render after a write. No-op before the first load. */
    private refresh(): void {
        if (this.entity) this.load(this.entity);
    }

    private fill(data: ProjectsData): void {
        this.data = data;
        this.fillSummary(data);
        this.fillList(data);
    }

    private fillSummary(data: ProjectsData): void {
        this.summary.clear();
        this._summary_group.set_title(_('Projects'));
        const explainer = _(
            'A project bundles a customer, their domains and the contact person for the cover letter. Several recurring invoices can belong to the same project. Projects are optional.',
        );
        const folded = explainerPlacement(this.phone, true) === 'expander';
        this._summary_group.set_description(folded ? null : explainer);
        if (folded) this.summary.add(explainerRow(explainer));
        const contracts = [...data.schedulesByProject.values()].reduce((sum, ids) => sum + ids.length, 0);
        this.summary.add(
            new Adw.ActionRow({
                // markup-ok: numbers / catalogue text only
                title: fmt(_('{n} in total'), { n: data.projects.length }),
                subtitle: fmt(_('{n} assigned recurring invoices'), { n: contracts }),
            }),
        );
    }

    private fillList(data: ProjectsData): void {
        this.list.clear();
        const add = new Gtk.Button({
            label: _('＋ Add a project'),
            cssClasses: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        add.connect('clicked', () => this.openForm(null));
        // In the header bar on a phone — see headerActions().
        this._list_group.set_header_suffix(hideOnPhone(wrapButtonLabel(add)));
        if (data.projects.length === 0) {
            this.list.add(
                emptyState({
                    icon: 'folder-symbolic',
                    title: _('No projects yet'),
                    description: _('A project belongs to a customer and sets who the cover letter addresses.'),
                    action: { label: _('Create a project'), run: () => this.openForm(null) },
                }),
            );
            return;
        }
        for (const p of data.projects) this.list.add(this.buildRow(p, data));
    }

    private buildRow(p: Project, data: ProjectsData): Adw.ActionRow {
        const customer = data.contacts.find((c) => c.id === p.contactId);
        const contracts = data.schedulesByProject.get(p.id) ?? [];
        const ergebnis = this.ansicht?.projekte.find((x) => x.projectId === p.id);
        const hatErgebnis = ergebnis && (ergebnis.umsatz !== 0 || ergebnis.kosten !== 0);
        const sub = [
            customer ? contactDisplayName(customer) : fmt(_('Contact {id} is missing'), { id: p.contactId }),
            p.domains.length ? p.domains.join(', ') : null,
            contracts.length ? fmt(_n('{n} invoice', '{n} invoices', contracts.length), { n: contracts.length }) : null,
            hatErgebnis ? fmt(_('Result {year}: {amount}'), { year: this.year, amount: eur(ergebnis.ergebnis) }) : null,
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(p.name),
            subtitle: markup(sub.join(' · ')),
            activatable: true,
        });
        if (this.phone) row.set_subtitle_lines(phoneSubtitleLines(true));
        row.add_prefix(new Adw.Avatar({ size: 32, text: p.name, showInitials: true, valign: Gtk.Align.CENTER }));
        // One cluster, so the phone half can give Delete a thumb-sized target — see phoneRowActions().
        const actions = rowActions([]);
        row.add_suffix(actions);
        phoneRowActions(actions);
        const greeting = p.contactPerson?.greeting;
        if (greeting) {
            actions.append(
                new Gtk.Label({
                    label: fmt(_('Salutation: {name}'), { name: greeting }),
                    cssClasses: ['caption', 'dim-label'],
                    valign: Gtk.Align.CENTER,
                }),
            );
        }
        const del = new Gtk.Button({ label: _('Delete'), cssClasses: ['flat'], valign: Gtk.Align.CENTER });
        del.connect('clicked', () => void this.askDelete(p)); // the button consumes the click → no row activation
        actions.append(del);
        row.connect('activated', () => this.openDetail(p));
        return row;
    }

    /** Open the project detail (result, costs, rules); its „Bearbeiten“ opens the form. */
    private openDetail(p: Project): void {
        if (!this.entity) return;
        new BhProjektDetailDialog().open(this, this.entity, this.year, p.id, {
            onEdit: () => this.openForm(p),
            onChanged: () => this.refresh(),
        });
    }

    /** Open the create/edit form; refresh the list on save. */
    private openForm(p: Project | null): void {
        if (!this.entity || !this.data) return;
        new BhProjektFormDialog().open(this, this.entity, this.data.contacts, p, () => this.refresh());
    }

    private async askDelete(p: Project): Promise<void> {
        if (!this.entity) return;
        const ok = await confirmDialog(this, {
            heading: _('Delete project'),
            body: fmt(_('Really delete “{name}”? Times already recorded keep their name.'), { name: p.name }),
            confirmLabel: _('Delete'),
            destructive: true,
        });
        if (!ok) return;
        try {
            removeProject(this.entity.id, p.id);
            showToast(_('Project deleted'));
            this.refresh();
        } catch (err) {
            await errorDialog(this, _('Deleting failed'), errorText(err));
        }
    }
}
