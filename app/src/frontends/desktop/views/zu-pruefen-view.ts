/**
 * <BhZuPruefenView> — the „Zu prüfen" tab of the Buchungen hub (Idee 6).
 *
 * The queue holds the bookings nothing classified and the ones only an Auffangregel caught. Per
 * booking: Bestätigen (records the category as checked — the EÜR does not change, see
 * `confirmClassification`) or Umbuchen (the existing dialog). ←/→ step through the open bookings,
 * Enter confirms, the progress line counts what was handled in this session, and an empty queue says
 * „Alles geprüft". The check boxes in the queue feed „Regel aus Auswahl".
 *
 * Same split and keyboard model as the Beleg-Eingang, so the two review flows feel like one.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gdk from '@girs/gdk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './zu-pruefen-view.blp';
import { nextOpenId, reviewProgressLabel, stepOpenId } from '../../../core/presenters/belege.ts';
import { confirmZuPruefen, loadZuPruefen, type ZuPruefenRow } from '../../../core/presenters/zu-pruefen.ts';
import { GRUND_TEXT } from '../../../core/elster/zu-pruefen.ts';
import { appSession } from '../data/session.ts';
import { loadDms } from '../data/settings.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, amountLabel, loadIntoStack, markup } from './util.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';
import { BhUmbuchenDialog } from './umbuchen-dialog.ts';
import { BhTxDetailDialog } from './tx-detail-dialog.ts';
import { BhRegelAusAuswahlDialog } from './regel-aus-auswahl-dialog.ts';
import { erstattungGroup } from './erstattung-group.ts';
import { navigateTo } from '../nav.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';

interface QueueRow {
    row: Gtk.ListBoxRow;
    action: Adw.ActionRow;
    check: Gtk.CheckButton;
    done: Gtk.Image;
}

export class BhZuPruefenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _progress_label: Gtk.Label;
    declare private _progress_bar: Gtk.ProgressBar;
    declare private _list_box: Gtk.ListBox;
    declare private _regel_button: Gtk.Button;
    declare private _detail_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhZuPruefenView',
                Template,
                InternalChildren: [
                    'stack',
                    'error_page',
                    'progress_label',
                    'progress_bar',
                    'list_box',
                    'regel_button',
                    'detail_box',
                ],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private entity?: AppEntity;
    private year = 0;
    /** Every booking that was in the queue this session — handled ones stay listed, struck through. */
    private items: ZuPruefenRow[] = [];
    /** Handled this session: id → what happened („bestätigt", „umgebucht", „per Regel"). */
    private readonly done = new Map<string, string>();
    private readonly rows = new Map<string, QueueRow>();
    /** Marked for „Regel aus Auswahl". */
    private readonly marked = new Set<string>();
    private currentId: string | null = null;
    private selecting = false;
    private busy = false;

    constructor() {
        super();
        this._list_box.connect('row-selected', (_l, row) => {
            if (this.selecting || !row) return;
            const id = row.get_name();
            if (id && id !== this.currentId) {
                this.currentId = id;
                this.renderDetail();
            }
        });
        this._regel_button.connect('clicked', () => this.openRegelAusAuswahl());
        const key = new Gtk.EventControllerKey();
        key.connect('key-pressed', (_c, keyval) => this.onKeyPressed(keyval));
        this.add_controller(key);
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Buchungen zu prüfen konnten nicht geladen werden',
            load: () => loadZuPruefen(appSession(), entity, year),
            fill: (data) => {
                this.items = data.rows;
                this.done.clear();
                this.marked.clear();
                this.currentId = this.items[0]?.id ?? null;
                this.renderList();
                this.updateProgress();
                this.renderDetail();
                this.focusCurrentRow();
                if (process.env.STEUER_APP_DEBUG) console.error(`[app] Zu prüfen ${year} ok: ${this.items.length}`);
            },
        });
    }

    /**
     * Re-read the queue after a write that may move several bookings at once (Umbuchen, a new rule):
     * what left it counts as handled, what is new is appended — the progress of this session stays.
     */
    private async refresh(why: string): Promise<void> {
        const entity = this.entity;
        if (!entity) return;
        appSession().invalidate(entity.id, this.year);
        try {
            const { rows } = await loadZuPruefen(appSession(), entity, this.year);
            const now = new Map(rows.map((r) => [r.id, r]));
            for (const item of this.items) {
                if (!now.has(item.id) && !this.done.has(item.id)) this.done.set(item.id, why);
            }
            this.items = this.items.map((i) => now.get(i.id) ?? i);
            for (const r of rows) if (!this.items.some((i) => i.id === r.id)) this.items.push(r);
            for (const id of this.marked) if (this.done.has(id)) this.marked.delete(id);
            if (this.currentId == null || this.done.has(this.currentId)) {
                this.currentId = nextOpenId(this.items, this.doneIds(), this.currentId ?? undefined);
            }
            this.renderList();
            this.updateProgress();
            this.renderDetail();
            this.focusCurrentRow();
        } catch (err) {
            await errorDialog(this, 'Neu laden fehlgeschlagen', err instanceof Error ? err.message : String(err));
        }
    }

    // ---------- queue ----------

    private renderList(): void {
        this.selecting = true;
        let child = this._list_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list_box.remove(child);
            child = next;
        }
        this.rows.clear();
        for (const item of this.items) {
            const action = new Adw.ActionRow({ titleLines: 1, subtitleLines: 2 });
            const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: this.marked.has(item.id) });
            check.set_tooltip_text(
                `Für „Regel aus Auswahl" markieren: ${item.counterparty?.trim() || item.purpose?.trim() || '—'} · ${deDate(item.bookingDate)}`,
            );
            check.connect('toggled', () => {
                if (check.get_active()) this.marked.add(item.id);
                else this.marked.delete(item.id);
                this.updateRegelButton();
            });
            action.add_prefix(check);
            action.add_suffix(
                new Gtk.Label({
                    label: eur(item.amount),
                    cssClasses: ['numeric', 'caption'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            const done = new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] });
            action.add_suffix(done);
            const row = new Gtk.ListBoxRow({ child: action, name: item.id });
            this.rows.set(item.id, { row, action, check, done });
            this.fillRow(item);
            this._list_box.append(row);
        }
        this.selecting = false;
        this.selectRow(this.currentId);
        this.updateRegelButton();
    }

    private fillRow(item: ZuPruefenRow): void {
        const entry = this.rows.get(item.id);
        if (!entry) return;
        const handled = this.done.get(item.id);
        const title = markup(item.counterparty?.trim() || item.purpose?.trim() || '—');
        entry.action.set_title(handled ? `<s>${title}</s>` : title);
        entry.action.set_subtitle(markup(`${deDate(item.bookingDate)}  ·  ${handled ?? GRUND_TEXT[item.grund]}`));
        entry.done.set_visible(handled != null);
        entry.check.set_sensitive(handled == null);
    }

    private selectRow(id: string | null): void {
        this.selecting = true;
        const row = id != null ? this.rows.get(id)?.row : undefined;
        if (row) this._list_box.select_row(row);
        else this._list_box.unselect_all();
        this.selecting = false;
    }

    private updateProgress(): void {
        const total = this.items.length;
        const done = this.done.size;
        this._progress_label.set_label(reviewProgressLabel(total, done));
        this._progress_bar.set_fraction(total > 0 ? done / total : 0);
    }

    private updateRegelButton(): void {
        const n = this.marked.size;
        this._regel_button.set_sensitive(n > 0);
        this._regel_button.set_label(n > 0 ? `Regel aus Auswahl (${n})` : 'Regel aus Auswahl');
    }

    private doneIds(): Set<string> {
        return new Set(this.done.keys());
    }

    private current(): ZuPruefenRow | null {
        return this.items.find((i) => i.id === this.currentId) ?? null;
    }

    // ---------- keyboard ----------

    /** ←/→ step through the OPEN bookings, Enter confirms — unless a text field owns the keys. */
    private onKeyPressed(keyval: number): boolean {
        if (this.items.length === 0) return false;
        const focus = (this.get_root() as Gtk.Window | null)?.get_focus();
        if (focus instanceof Gtk.Text || focus instanceof Gtk.TextView) return false;
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            void this.confirm();
            return true;
        }
        if (keyval !== Gdk.KEY_Left && keyval !== Gdk.KEY_Right) return false;
        this.step(keyval === Gdk.KEY_Right ? 1 : -1);
        return true;
    }

    private step(dir: 1 | -1): void {
        const next = stepOpenId(this.items, this.doneIds(), this.currentId, dir);
        if (next == null || next === this.currentId) return;
        this.currentId = next;
        this.selectRow(next);
        this.renderDetail();
        this.focusCurrentRow();
    }

    // ---------- detail ----------

    private clearDetail(): void {
        let child = this._detail_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._detail_box.remove(child);
            child = next;
        }
    }

    private renderDetail(): void {
        this.clearDetail();
        const item = this.current();
        if (!item) {
            this.renderAllDone();
            return;
        }
        if (this.done.has(item.id)) {
            this.renderDoneDetail(item);
            return;
        }
        this._detail_box.append(this.buchungGroup(item));
        if (item.grund === 'erstattung' && this.entity) {
            // „Gehört das zu dieser Zahlung?" replaces Bestätigen: Ja/Nein IS the decision here.
            this._detail_box.append(
                erstattungGroup(this, this.entity, this.year, item.id, (what) => void this.refresh(what)),
            );
        } else {
            this._detail_box.append(this.warumGroup(item));
        }
        this._detail_box.append(this.actionsRow(item));
    }

    private buchungGroup(item: ZuPruefenRow): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: markup(item.counterparty?.trim() || '—'),
            description: [deDate(item.bookingDate), item.account].filter(Boolean).join('  ·  '),
        });
        group.set_header_suffix(
            amountLabel(eur(item.amount), { heading: true, accent: item.amount < 0 ? 'error' : 'success' }),
        );
        if (item.purpose) {
            const purpose = new Adw.ActionRow({ title: 'Verwendungszweck', subtitle: markup(item.purpose) });
            purpose.set_subtitle_lines(0);
            group.add(purpose);
        }
        const details = new Adw.ActionRow({ title: 'Alle Details', activatable: true });
        details.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        details.connect('activated', () => this.openDetail(item));
        group.add(details);
        return group;
    }

    /** Why the booking is here and what it is booked as now. */
    private warumGroup(item: ZuPruefenRow): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Zu prüfen' });
        const lernmodus = lernmodusOn();
        group.set_header_suffix(new BhGlossaryHelp('zu-pruefen', lernmodus));
        const unklar = item.grund === 'unklassifiziert';
        const row = new Adw.ActionRow({
            title: unklar ? 'Keine Regel und kein Beleg' : markup(item.category),
            subtitle: unklar
                ? 'Weder ein Beleg noch eine Regel ordnet diese Buchung ein — bitte umbuchen.'
                : markup(`${item.herkunft} — nur geraten, nicht über die Gegenseite erkannt`),
        });
        row.set_subtitle_lines(0);
        row.add_prefix(
            new Gtk.Image({
                iconName: unklar ? 'dialog-warning-symbolic' : 'dialog-question-symbolic',
                cssClasses: [unklar ? 'warning' : 'accent'],
            }),
        );
        if (!unklar) row.add_suffix(new BhGlossaryHelp('auffangregel', lernmodus));
        group.add(row);
        return group;
    }

    /** Überspringen · Umbuchen · Bestätigen und weiter, plus the keyboard hint. */
    private actionsRow(item: ZuPruefenRow): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
        const back = new Gtk.Button({ iconName: 'go-previous-symbolic', tooltipText: 'Vorherige Buchung (←)' });
        back.connect('clicked', () => this.step(-1));
        const fwd = new Gtk.Button({ iconName: 'go-next-symbolic', tooltipText: 'Nächste Buchung (→)' });
        fwd.connect('clicked', () => this.step(1));
        const nav = new Gtk.Box({ cssClasses: ['linked'] });
        nav.append(back);
        nav.append(fwd);
        buttons.append(nav);
        buttons.append(new Gtk.Box({ hexpand: true }));
        const umbuchen = new Gtk.Button({ label: 'Umbuchen', cssClasses: ['pill'] });
        umbuchen.connect('clicked', () => this.openUmbuchen(item));
        buttons.append(umbuchen);
        const confirm = new Gtk.Button({ label: 'Bestätigen und weiter', cssClasses: ['suggested-action', 'pill'] });
        confirm.set_sensitive(item.grund === 'auffangregel' && !this.busy);
        if (item.grund === 'unklassifiziert') confirm.set_tooltip_text('Ohne Kategorie gibt es nichts zu bestätigen');
        if (item.grund === 'erstattung') confirm.set_visible(false);
        confirm.connect('clicked', () => void this.confirm());
        buttons.append(confirm);
        box.append(buttons);
        box.append(
            new Gtk.Label({
                label: 'Tipp: ←/→ blättern · Eingabetaste bestätigt',
                xalign: 1,
                cssClasses: ['dim-label', 'caption'],
            }),
        );
        return box;
    }

    private renderDoneDetail(item: ZuPruefenRow): void {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({ title: 'Erledigt', subtitle: this.done.get(item.id) ?? '' });
        row.add_prefix(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] }));
        group.add(row);
        this._detail_box.append(group);
        this._detail_box.append(this.buchungGroup(item));
    }

    private renderAllDone(): void {
        const fresh = this.done.size === 0;
        const page = new Adw.StatusPage({
            iconName: 'object-select-symbolic',
            title: 'Alles geprüft',
            description: fresh
                ? `Jede Buchung in ${this.year} ist über einen Beleg, eine eigene Regel oder von Hand eingeordnet.`
                : 'Alle Buchungen dieser Liste sind bestätigt oder umgebucht. Neue Buchungen, die nur geraten eingeordnet werden, erscheinen hier.',
            vexpand: true,
        });
        page.add_css_class('compact');
        const btn = new Gtk.Button({
            label: 'Alle Buchungen',
            cssClasses: ['pill'],
            halign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', () => navigateTo(this, 'transactions', 'buchungen'));
        page.set_child(btn);
        this._detail_box.append(page);
    }

    // ---------- actions ----------

    private async confirm(): Promise<void> {
        const item = this.current();
        const entity = this.entity;
        if (!item || !entity || this.busy || this.done.has(item.id) || item.grund !== 'auffangregel') return;
        this.busy = true;
        try {
            await confirmZuPruefen(appSession(), entity, this.year, item.id);
            this.done.set(item.id, `bestätigt: ${item.category}`);
            this.fillRow(item);
            this.updateProgress();
            showToast(`Bestätigt: ${markup(item.category)}`);
            if (this.currentId === item.id) {
                this.currentId = nextOpenId(this.items, this.doneIds(), item.id);
                this.selectRow(this.currentId);
                this.renderDetail();
                this.focusCurrentRow();
            }
        } catch (err) {
            await errorDialog(this, 'Bestätigen fehlgeschlagen', err instanceof Error ? err.message : String(err));
        } finally {
            this.busy = false;
        }
    }

    private openUmbuchen(item: ZuPruefenRow): void {
        const entity = this.entity;
        if (!entity) return;
        new BhUmbuchenDialog(
            entity,
            this.year,
            {
                transactionId: item.id,
                category: item.category,
                source: item.source,
                counterparty: item.counterparty,
                purpose: item.purpose,
                note: item.note,
            },
            (message, changed) => {
                showToast(message);
                if (changed) void this.refresh('umgebucht');
            },
        ).present(this);
    }

    private openDetail(item: ZuPruefenRow): void {
        const entity = this.entity;
        if (!entity) return;
        let paperlessBase: string | null = null;
        try {
            paperlessBase = loadDms(entity).paperlessUrl ?? null;
        } catch {
            paperlessBase = null;
        }
        new BhTxDetailDialog().open(this, item, paperlessBase, {
            entity,
            year: this.year,
            onChanged: () => void this.refresh('geändert'),
        });
    }

    private openRegelAusAuswahl(): void {
        const entity = this.entity;
        if (!entity || this.marked.size === 0) return;
        new BhRegelAusAuswahlDialog(entity, this.year, [...this.marked], (message) => {
            showToast(message);
            void this.refresh('per Regel');
        }).present(this);
    }

    private focusCurrentRow(): void {
        const row = this.currentId != null ? this.rows.get(this.currentId)?.row : undefined;
        row?.grab_focus();
    }
}
