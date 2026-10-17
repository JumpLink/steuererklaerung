/**
 * <BhZeitProjektDialog> — puts one tracked entry on a project, or takes it off one.
 *
 * Only the choice lives here. Which projects are offered (the customer's own, or all while the
 * entry has none) and what a choice means for the entry is core's (`projectsForContact`,
 * `assignTimeProject`); the confirm callback hands the chosen id back, `null` for "kein Projekt".
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import type { Project } from '../../../core/config/index.ts';
import { _ } from '../i18n.ts';

export interface ZeitProjektDialogInit {
    /** What the entry says now, for the heading. */
    title: string;
    /** The projects to choose from, already narrowed to the entry's customer. */
    projects: readonly Project[];
    /** The entry's current project id, or null. */
    current: string | null;
    onConfirm: (projectId: string | null) => void;
}

export class BhZeitProjektDialog {
    private readonly dialog = new Adw.PreferencesDialog();
    private readonly row: Adw.ComboRow;

    constructor(private readonly init: ZeitProjektDialogInit) {
        this.dialog.set_title(_('Assign project'));

        const group = new Adw.PreferencesGroup({ title: init.title });
        this.row = new Adw.ComboRow({
            title: _('Project'),
            subtitle: init.projects.length ? '' : _('No project for this customer yet (Projects view)'),
            model: Gtk.StringList.new([_('— no project —'), ...init.projects.map((p) => p.name)]),
        });
        this.row.set_selected(Math.max(0, init.projects.findIndex((p) => p.id === init.current) + 1));
        group.add(this.row);

        const confirm = new Adw.ButtonRow({ title: _('Save') });
        confirm.add_css_class('suggested-action');
        confirm.connect('activated', () => this.confirm());
        group.add(confirm);

        const page = new Adw.PreferencesPage();
        page.add(group);
        this.dialog.add(page);
    }

    present(parent: Gtk.Widget): void {
        this.dialog.present(parent);
    }

    private confirm(): void {
        const picked = this.init.projects[this.row.get_selected() - 1];
        this.dialog.close();
        this.init.onConfirm(picked?.id ?? null);
    }
}
