/**
 * <BhZeitenView> — Zeiterfassung: Timer, Tagesliste, offene Zeiten.
 *
 * Three blocks, top to bottom, in the order they are used: the timer (start form or the running
 * clock with a stop button), what is still unbilled per project (each row offering "Rechnung
 * erstellen"), and the entries grouped by day.
 *
 * The elapsed clock ticks from a GLib timeout that only runs while a timer is actually running —
 * a permanently ticking source would keep the app awake for nothing.
 *
 * Store-only reads/writes (see data/time.ts); entity-scoped, not year-scoped: "is a timer
 * running" and "what is still unbilled" are not questions about a tax year.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import Template from './zeiten-view.blp';
import {
    assignTimeProject,
    createInvoiceFromTime,
    buildTimeDays,
    formatDuration,
    loadTimeView,
    projectsForContact,
    removeTimeEntry,
    resolveTimeProject,
    startTracking,
    stopTracking,
    type TimeDay,
    type TimeEntry,
    type TimeListRow,
    timeProjectLabel,
    type TimeViewModel,
    toHours,
} from '../data/time.ts';
import type { TimeRowStatus } from '../../../core/presenters/zeiten.ts';
import type { AppEntity } from '../entities.ts';
import { _ } from '../i18n.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { amountLabel, GroupRows, LoadToken, loadIntoStack, markup } from './util.ts';
import { BhZeitProjektDialog } from './zeit-projekt-dialog.ts';
import { BhZeitRechnungDialog } from './zeit-rechnung-dialog.ts';

/** Status label + colour class per row status — the invoice list's vocabulary (open = amber, done = green). */
const STATUS_META: Record<TimeRowStatus, { label: () => string; css: string }> = {
    open: { label: () => _('Open'), css: 'warning' },
    billed: { label: () => _('Invoiced'), css: 'success' },
    internal: { label: () => _('Internal'), css: 'dim-label' },
};

export class BhZeitenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _timer_group: Adw.PreferencesGroup;
    declare private _elapsed_label: Gtk.Label;
    declare private _running_label: Gtk.Label;
    declare private _form_box: Gtk.Box;
    declare private _project_dropdown: Gtk.DropDown;
    declare private _project_entry: Gtk.Entry;
    declare private _description_entry: Gtk.Entry;
    declare private _start_button: Gtk.Button;
    declare private _stop_button: Gtk.Button;
    declare private _unbilled_group: Adw.PreferencesGroup;
    declare private _entries_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhZeitenView',
                Template,
                InternalChildren: [
                    'stack',
                    'error_page',
                    'timer_group',
                    'elapsed_label',
                    'running_label',
                    'form_box',
                    'project_dropdown',
                    'project_entry',
                    'description_entry',
                    'start_button',
                    'stop_button',
                    'unbilled_group',
                    'entries_group',
                ],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly unbilled: GroupRows;
    private readonly entries: GroupRows;
    private entity: AppEntity | null = null;
    private model: TimeViewModel | null = null;
    /** GLib source id of the 1 s tick, or 0 when no timer runs. */
    private tickId = 0;

    constructor() {
        super();
        this.unbilled = new GroupRows(this._unbilled_group);
        this.entries = new GroupRows(this._entries_group);
        this._start_button.connect('clicked', () => this.onStart());
        this._stop_button.connect('clicked', () => this.onStop());
        // Enter in either field starts the timer — the whole point is that it costs one gesture.
        this._project_entry.connect('activate', () => this.onStart());
        // A listed project replaces the free label; "kein Projekt" brings the label field back.
        this._project_dropdown.connect('notify::selected', () => {
            this.syncProjectEntry();
            if (this.selectedProjectId()) this._description_entry.grab_focus();
        });
        this._description_entry.connect('activate', () => this.onStart());
        this.connect('destroy', () => this.stopTick());
    }

    reload(entity: AppEntity, _year: number): void {
        this.entity = entity;
        this.load(entity);
    }

    private load(entity: AppEntity): void {
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Zeiten konnten nicht geladen werden',
            load: () => loadTimeView(entity.id),
            fill: (model) => this.fill(model),
        });
    }

    private refresh(): void {
        if (this.entity) this.load(this.entity);
    }

    private fill(model: TimeViewModel): void {
        // The picker's choice survives a reload: read it before the model it indexes is replaced.
        const picked = this.selectedProjectId();
        this.model = model;
        this.fillProjectChoices(model, picked);
        this.fillTimer(model);
        this.fillUnbilled(model);
        this.fillEntries(model);
        if (process.env.STEUER_APP_DEBUG) {
            console.error(`[app] Zeiten ok: ${model.recent.length} Einträge, ${model.unbilled.length} offene Projekte`);
        }
    }

    // --- Timer ------------------------------------------------------------------------------

    /**
     * The start form offers every project of the entity: the customer is not known before the
     * project is. Without any project the dropdown stays out of the way and the form is the old one.
     */
    private fillProjectChoices(model: TimeViewModel, keep: string | null): void {
        this._project_dropdown.set_model(Gtk.StringList.new(['Kein Projekt', ...model.projectList.map((p) => p.name)]));
        const index = model.projectList.findIndex((p) => p.id === keep);
        this._project_dropdown.set_selected(index + 1);
        this._project_dropdown.set_visible(model.projectList.length > 0);
        this.syncProjectEntry();
    }

    private selectedProjectId(): string | null {
        return this.model?.projectList[this._project_dropdown.get_selected() - 1]?.id ?? null;
    }

    private syncProjectEntry(): void {
        const listed = this.selectedProjectId() !== null;
        this._project_entry.set_visible(!listed);
    }

    private fillTimer(model: TimeViewModel): void {
        const running = model.running;
        this._timer_group.set_title(running ? 'Läuft' : 'Zeiterfassung');
        this._form_box.set_visible(!running);
        this._stop_button.set_visible(!!running);

        if (!running) {
            this.stopTick();
            this._elapsed_label.set_label('00:00:00');
            this._running_label.set_label('Kein Timer aktiv');
            this._timer_group.set_description('Projekt eintragen und starten. Enter genügt.');
            return;
        }

        const who = running.contactId ? (model.names.get(running.contactId) ?? '') : 'ohne Kunde';
        const label = timeProjectLabel(running, model.projectList);
        this._running_label.set_label([label, running.description, who].filter(Boolean).join(' · '));
        this._timer_group.set_description(null);
        this.updateElapsed();
        this.startTick();
    }

    private startTick(): void {
        if (this.tickId) return;
        this.tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this.updateElapsed();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private stopTick(): void {
        if (!this.tickId) return;
        GLib.source_remove(this.tickId);
        this.tickId = 0;
    }

    private updateElapsed(): void {
        const running = this.model?.running;
        if (!running) return;
        const secs = Math.max(0, Math.round((Date.now() - Date.parse(running.startedAt)) / 1000));
        this._elapsed_label.set_label(formatDuration(secs));
    }

    private onStart(): void {
        if (!this.entity) return;
        const projectId = this.selectedProjectId();
        const label = projectId ?? this._project_entry.get_text().trim();
        if (!label) {
            this._project_entry.grab_focus();
            return;
        }
        const description = this._description_entry.get_text().trim();
        try {
            // Same resolution as `time start --project`: a project fills in its name and customer,
            // a free label that names one project exactly is linked too.
            const target = resolveTimeProject(this.entity.id, label, null, this.model?.projectList);
            // A label already worked for keeps its customer — otherwise every new entry would have
            // to be assigned by hand although the answer is in the previous entry.
            const contactId =
                target.contactId ??
                this.model?.recent.find((e) => e.project === target.project && e.contactId)?.contactId ??
                null;
            startTracking({
                entityId: this.entity.id,
                ...target,
                contactId,
                description: description || null,
            });
            this._description_entry.set_text('');
            showToast(`Timer läuft: ${target.project}`);
            this.refresh();
        } catch (err) {
            void errorDialog(
                this,
                'Timer konnte nicht gestartet werden',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    private onStop(): void {
        if (!this.entity) return;
        try {
            const stopped = stopTracking(this.entity.id);
            showToast(`Gestoppt: ${stopped.project} · ${formatDuration(stopped.durationSeconds ?? 0)}`);
            this.refresh();
        } catch (err) {
            void errorDialog(
                this,
                'Timer konnte nicht beendet werden',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    // --- Offene Zeiten ----------------------------------------------------------------------

    private fillUnbilled(model: TimeViewModel): void {
        this.unbilled.clear();
        if (model.unbilled.length === 0) {
            this._unbilled_group.set_description('Alles abgerechnet.');
            return;
        }
        const total = model.unbilled.reduce((sum, r) => sum + r.seconds, 0);
        this._unbilled_group.set_description(`${toHours(total)} h offen`);

        for (const row of model.unbilled) {
            const who = row.contactId ? (model.names.get(row.contactId) ?? row.contactId) : 'ohne Kunde';
            const action = new Adw.ActionRow({
                title: timeProjectLabel(row, model.projectList),
                subtitle: `${toHours(row.seconds)} h · ${row.entries} Einträge · ${who}`,
            });
            action.add_suffix(
                new Gtk.Label({ label: formatDuration(row.seconds), cssClasses: ['numeric', 'dim-label'] }),
            );
            if (row.contactId) {
                const bill = new Gtk.Button({
                    label: 'Rechnung',
                    valign: Gtk.Align.CENTER,
                    tooltipText: 'Rechnungsentwurf aus diesen Zeiten erzeugen',
                });
                bill.connect('clicked', () => this.onBill(row.project, row.contactId as string, row.seconds));
                action.add_suffix(bill);
            } else {
                // Without a customer there is nobody to invoice — say so instead of offering a
                // button that can only fail.
                const hint = new Gtk.Label({ label: 'Kunde fehlt', cssClasses: ['dim-label'] });
                action.add_suffix(hint);
            }
            this.unbilled.add(action);
        }
    }

    private onBill(project: string, contactId: string, seconds: number): void {
        if (!this.entity) return;
        const entityId = this.entity.id;
        const dialog = new BhZeitRechnungDialog({
            project,
            hours: toHours(seconds),
            customer: this.model?.names.get(contactId) ?? contactId,
            onConfirm: (opts) => {
                try {
                    const result = createInvoiceFromTime({
                        entityId,
                        contactId,
                        project,
                        hourlyRate: opts.hourlyRate,
                        vatRate: opts.vatRate,
                        roundToMinutes: opts.roundToMinutes,
                    });
                    showToast(`Entwurf angelegt: ${result.invoice.totals.gross} € brutto`);
                    this.refresh();
                } catch (err) {
                    void errorDialog(
                        this,
                        'Rechnung konnte nicht erzeugt werden',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            },
        });
        dialog.present(this);
    }

    // --- Tagesliste -------------------------------------------------------------------------

    private fillEntries(model: TimeViewModel): void {
        this.entries.clear();
        const days = buildTimeDays(model.recent, model.projectList, model.names);
        if (days.length === 0) {
            this._entries_group.set_description(_('Nothing tracked yet.'));
            return;
        }
        this._entries_group.set_description(null);

        for (const day of days) {
            this.entries.add(this.dayHeader(day));
            for (const row of day.rows) this.entries.add(this.entryRow(row));
        }
    }

    /** Date left, the day's total right — the same column the entries' durations sit in. */
    private dayHeader(day: TimeDay): Adw.ActionRow {
        const title =
            day.relative === 'today'
                ? _('Today')
                : day.relative === 'yesterday'
                  ? _('Yesterday')
                  : new Date(`${day.day}T12:00:00`).toLocaleDateString('de-DE', {
                        weekday: 'short',
                        day: '2-digit',
                        month: 'long',
                        year: 'numeric',
                    });
        const header = new Adw.ActionRow({ title: markup(title), activatable: false, cssClasses: ['heading'] });
        header.add_suffix(amountLabel(day.total, { heading: true }));
        return header;
    }

    /**
     * Fixed columns, every row: start time · title/subtitle · duration · status · edit · delete.
     * A billed entry keeps its buttons (insensitive) so no column moves between rows.
     */
    private entryRow(item: TimeListRow): Adw.ActionRow {
        const { entry } = item;
        const subtitle = [item.project, item.customer, item.estimated ? _('estimated') : null].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(item.title),
            subtitle: markup(subtitle.join(' · ')),
            titleLines: 1,
            subtitleLines: 1,
            tooltipText: item.title,
        });
        row.add_prefix(
            new Gtk.Label({
                label: item.time,
                widthChars: 5,
                cssClasses: ['numeric', 'dim-label'],
                valign: Gtk.Align.CENTER,
            }),
        );
        row.add_suffix(amountLabel(item.duration));
        row.add_suffix(
            new Gtk.Label({
                label: STATUS_META[item.status].label(),
                cssClasses: ['caption', STATUS_META[item.status].css],
                widthChars: 11,
                xalign: 0.5,
                valign: Gtk.Align.CENTER,
            }),
        );

        const edit = new Gtk.Button({
            iconName: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            tooltipText: item.editable ? _('Assign project') : _('Already invoiced'),
            sensitive: item.editable,
            cssClasses: ['flat'],
        });
        edit.connect('clicked', () => this.onEditProject(entry, this.model as TimeViewModel));
        row.add_suffix(edit);
        const del = new Gtk.Button({
            iconName: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltipText: item.editable ? _('Delete entry') : _('Already invoiced'),
            sensitive: item.editable,
            cssClasses: ['flat'],
        });
        del.connect('clicked', () => void this.onDelete(entry));
        row.add_suffix(del);
        return row;
    }

    private onEditProject(entry: TimeEntry, model: TimeViewModel): void {
        const label = timeProjectLabel(entry, model.projectList);
        // The entry's customer narrows the choice; its current project stays offered either way.
        const choices = projectsForContact(model.projectList, entry.contactId);
        const dialog = new BhZeitProjektDialog({
            title: entry.description ? `${label} · ${entry.description}` : label,
            projects: choices,
            current: entry.projectId,
            onConfirm: (projectId) => {
                try {
                    assignTimeProject(entry.id, projectId);
                    showToast(projectId ? 'Projekt zugeordnet' : 'Projekt entfernt');
                    this.refresh();
                } catch (err) {
                    void errorDialog(
                        this,
                        'Projekt konnte nicht zugeordnet werden',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            },
        });
        dialog.present(this);
    }

    private async onDelete(entry: TimeEntry): Promise<void> {
        const ok = await confirmDialog(this, {
            heading: 'Eintrag löschen?',
            body: `${entry.project} · ${formatDuration(entry.durationSeconds ?? 0)}${entry.description ? `\n${entry.description}` : ''}`,
            confirmLabel: 'Löschen',
            destructive: true,
        });
        if (!ok) return;
        removeTimeEntry(entry.id);
        showToast('Eintrag gelöscht');
        this.refresh();
    }
}
