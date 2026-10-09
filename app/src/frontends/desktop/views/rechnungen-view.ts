/**
 * <BhRechnungenView> — the Rechnungen view.
 *
 * Mirrors the web bh-rechnungen-view: the recurring-invoice reminders (overdue · due-soon ·
 * upcoming) and the full list of issued invoices from the entity's back-end. The recurring part is
 * a synchronous local read (rendered at once); the issued list is an outbound fetch (Qonto), loaded
 * async into its own group with its own loading/error state. Draft creation (a write) is deferred.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './rechnungen-view.blp';
import {
    type InvoiceCapabilities,
    loadCapabilities,
    loadInvoicingBlock,
    loadOutgoingInvoices,
    loadRecurring,
    type OutgoingInvoiceSummary,
    type RecurringDueEntry,
    selectInvoicesForYear,
} from '../../../core/presenters/rechnungen.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { loadRecurringInvoices } from '../../../core/config/index.ts';
import { loadEntityMailStatus, withLegacySent } from '../../../core/actions/send-invoice-email.ts';
import type { InvoiceMailRecord } from '@steuererklaerung/store';
import {
    type DisplayInvoiceStatus,
    displayInvoiceStatus,
    INVOICE_STATUS_LABEL,
} from '../../../core/invoices/status.ts';
import { createRecurringInvoiceDraft, reconcileRecurringInvoices } from '../../../core/actions/recurring-invoices.ts';
import { listSchedules } from '../../../core/actions/recurring-schedules.ts';
import type { RecurringInvoice } from '../../../core/config/schema/recurring.ts';
import { BhWiederkehrendDialog } from './wiederkehrend-dialog.ts';
import { GroupRows, LoadToken, amountLabel, emptyState, kpiFlow, loadIntoStack, markup } from './util.ts';
import { BhRechnungDetailDialog } from './rechnung-detail-dialog.ts';
import { BhRechnungVersandDialog } from './rechnung-versand-dialog.ts';
import { BhRechnungFormDialog } from './rechnung-form-dialog.ts';
import { errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';

/** Status label + colour class for a recurring reminder. */
const DUE_META: Record<string, { label: string; css: string }> = {
    overdue: { label: 'überfällig', css: 'error' },
    'due-soon': { label: 'bald fällig', css: 'warning' },
    upcoming: { label: 'geplant', css: 'dim-label' },
    paused: { label: 'pausiert', css: 'dim-label' },
    cancelled: { label: 'storniert', css: 'dim-label' },
};

/** GTK css class per normalized display status (shared vocabulary from invoices/status.ts). */
const STATUS_CSS: Record<DisplayInvoiceStatus, string> = {
    draft: 'dim-label',
    open: 'warning',
    overdue: 'error',
    paid: 'success',
    cancelled: 'dim-label',
};

/** Filter chips over the issued-invoice list. */
const FILTERS: { key: 'all' | DisplayInvoiceStatus; label: string }[] = [
    { key: 'all', label: 'Alle' },
    { key: 'draft', label: 'Entwürfe' },
    { key: 'open', label: 'Offen' },
    { key: 'overdue', label: 'Überfällig' },
    { key: 'paid', label: 'Bezahlt' },
    { key: 'cancelled', label: 'Storniert' },
];

export class BhRechnungenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _notice_page: Adw.StatusPage;
    declare private _kpi_box: Gtk.Box;
    declare private _recurring_group: Adw.PreferencesGroup;
    declare private _invoices_toolbar: Gtk.Box;
    declare private _invoices_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhRechnungenView',
                Template,
                InternalChildren: [
                    'stack',
                    'error_page',
                    'notice_page',
                    'kpi_box',
                    'recurring_group',
                    'invoices_toolbar',
                    'invoices_group',
                ],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly invoicesToken = new LoadToken();
    /** STEUER_APP_INVOICE_DETAIL fires once, not on every reload the dialog triggers. */
    private detailHookDone = false;
    private readonly recurring: GroupRows;
    private readonly invoices: GroupRows;
    private entity: AppEntity | null = null;
    private year = new Date().getFullYear();
    private capabilities: InvoiceCapabilities | null = null;
    private allInvoices: OutgoingInvoiceSummary[] = [];
    /** Latest mail attempt per invoice id, for the list badge. */
    private mailStatus = new Map<string, InvoiceMailRecord>();
    private filter: 'all' | DisplayInvoiceStatus = 'all';
    /** The status chips, so the empty state can put them back to "Alle". */
    private filterButtons: Gtk.ToggleButton[] = [];
    // Recomputed on read, not cached at construction, so a long-running session that crosses
    // midnight derives "überfällig" against the current day (matches rechnung-detail-dialog).
    private get today(): string {
        return new Date().toISOString().slice(0, 10);
    }

    constructor() {
        super();
        this.recurring = new GroupRows(this._recurring_group);
        this.invoices = new GroupRows(this._invoices_group);
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        if (year > 0) this.year = year;
        // The Qonto credentials are global, so an entity without its own Qonto account must not show
        // (or create) another entity's invoices — say so instead of loading anything.
        const block = loadInvoicingBlock(entity.id);
        if (block) {
            this.token.next(); // drop any load still in flight for the previous entity
            this.invoicesToken.next();
            this._notice_page.set_description(block);
            this._stack.set_visible_child_name('notice');
            return;
        }
        try {
            this.capabilities = loadCapabilities(entity.id);
        } catch {
            this.capabilities = null;
        }
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Rechnungen konnten nicht geladen werden',
            load: () => loadRecurring(entity.id), // synchronous
            fill: (entries) => {
                this.fillRecurring(entries);
                if (process.env.STEUER_APP_DEBUG) console.error(`[app] Rechnungen ok: ${entries.length} wiederkehrend`);
                this.loadInvoices(entity); // the outbound listing fills its group async
            },
        });
    }

    /** The display status of an invoice (normalized + overdue-derived). */
    private dispStatus(inv: OutgoingInvoiceSummary): DisplayInvoiceStatus {
        return displayInvoiceStatus(inv.status, inv.dueDate, this.today);
    }

    private fillRecurring(entries: RecurringDueEntry[]): void {
        this.recurring.clear();
        const overdue = entries.filter((e) => e.status === 'overdue').length;
        const soon = entries.filter((e) => e.status === 'due-soon').length;
        this._recurring_group.set_description(
            entries.length ? `${overdue} überfällig · ${soon} bald fällig · ${entries.length} gesamt` : 'keine erfasst',
        );
        if (entries.length === 0) {
            this.recurring.add(
                emptyState({
                    icon: 'view-refresh-symbolic',
                    title: 'Keine wiederkehrenden Rechnungen',
                    description:
                        'Was jedes Jahr oder jeden Monat gleich abgerechnet wird — Hosting, Wartung, ' +
                        'Miete — steht hier einmal und erinnert dann von selbst.',
                    action: { label: 'Wiederkehrend anlegen', run: () => this.editSchedule(null) },
                }),
            );
            return;
        }
        for (const e of entries) this.recurring.add(this.recurringRow(e));
    }

    /**
     * Open the schedule editor. `null` creates one.
     *
     * The dashboard entry carries only what a REMINDER needs, so an edit re-reads the schedule from
     * the manifest by id — editing a projection would write back whatever the projection dropped.
     */
    private editSchedule(id: string | null): void {
        const entity = this.entity;
        if (!entity) return;
        let existing: RecurringInvoice | null = null;
        if (id) {
            existing = listSchedules(entity.id).find((s) => s.id === id) ?? null;
            if (!existing) {
                showToast(`Wiederkehrender Posten „${id}" nicht gefunden.`);
                return;
            }
        }
        const dialog = new BhWiederkehrendDialog(entity, existing, (message, changed) => {
            showToast(message);
            if (changed) this.reload(entity, this.year);
        });
        dialog.present(this);
    }

    private recurringRow(e: RecurringDueEntry): Adw.ActionRow {
        const meta = DUE_META[e.status] ?? DUE_META.upcoming;
        const when =
            e.daysUntilDue < 0
                ? `seit ${Math.abs(e.daysUntilDue)} Tagen`
                : e.daysUntilDue === 0
                  ? 'heute'
                  : `in ${e.daysUntilDue} Tagen`;
        const what = e.description || e.domains.join(', ') || e.customer;
        const sub = [
            what,
            `fällig ${deDate(e.dueDate)} (${when})`,
            e.lastInvoiceNumber ? `zuletzt ${e.lastInvoiceNumber}` : null,
        ].filter(Boolean);
        const row = new Adw.ActionRow({ title: markup(e.customer), subtitle: markup(sub.join(' · ')) });
        row.add_suffix(amountLabel(eur(e.totals.gross)));
        row.add_suffix(this.badge(meta.label, meta.css));
        // A paused/cancelled schedule stays read-only; the rest get a one-click "draft from template"
        // button. This uses the recurring path (createRecurringInvoiceDraft → provider.createDraft
        // directly), so it works for the Qonto back-end too — unlike the form-based "Neue Rechnung",
        // which the createDraft capability gates off for Qonto. So gate on status, not capabilities.
        if (e.status !== 'paused' && e.status !== 'cancelled') {
            const btn = new Gtk.Button({
                label: 'Entwurf erstellen',
                cssClasses: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => void this.createDraftFromRecurring(e, btn));
            row.add_suffix(btn);
        }
        // Every schedule is editable, including a paused one — pausing is how you park something
        // you intend to come back to, and coming back means changing it.
        const edit = new Gtk.Button({ iconName: 'document-edit-symbolic', valign: Gtk.Align.CENTER });
        edit.add_css_class('flat');
        edit.set_tooltip_text('Wiederkehrenden Posten bearbeiten');
        edit.connect('clicked', () => this.editSchedule(e.id));
        row.add_suffix(edit);
        return row;
    }

    /**
     * Create a DRAFT invoice from a recurring schedule's template, then advance the schedule (the
     * same core path the CLI/web use). The write advanced the schedule and created a draft — not a
     * one-tap-reversible edit — so we confirm with a plain toast (draft number when the back-end
     * assigned one) and refresh both the reminders (rolled-forward due date) and the issued list.
     */
    private async createDraftFromRecurring(e: RecurringDueEntry, btn: Gtk.Button): Promise<void> {
        if (!this.entity) return;
        btn.set_sensitive(false);
        btn.set_label('Erstelle Entwurf …');
        try {
            const result = await createRecurringInvoiceDraft(e.id);
            showToast(result.draft?.number ? `Entwurf ${result.draft.number} erstellt` : 'Entwurf erstellt');
            // fillRecurring rebuilds the rows (this button included); safe — nothing touches btn after.
            this.fillRecurring(loadRecurring(this.entity.id));
            this.loadInvoices(this.entity);
        } catch (err) {
            btn.set_sensitive(true);
            btn.set_label('Entwurf erstellen');
            await errorDialog(this, 'Entwurf fehlgeschlagen', err instanceof Error ? err.message : String(err));
        }
    }

    private loadInvoices(entity: AppEntity): void {
        this.invoices.clear();
        this.invoices.add(new Adw.ActionRow({ title: 'Lade Rechnungen aus dem Back-End …' }));
        const token = this.invoicesToken.next();
        loadOutgoingInvoices(entity.id)
            .then((list) => {
                if (token !== this.invoicesToken.current) return;
                if (process.env.STEUER_APP_DEBUG)
                    console.error(`[app] Rechnungen-Liste ok: ${list.length} ausgestellt`);
                this.fillInvoices(list);
                this.reconcileSchedules(entity, list);
                // STEUER_APP_MAIL_DIALOG=1 (dev/testing hook): open the mail dialog on the first
                // invoice that has a number, so the Versandkonto state can be captured.
                const first = list.find((i) => i.number && i.status !== 'draft');
                if (process.env.STEUER_APP_MAIL_DIALOG === '1' && first) {
                    const versand = new BhRechnungVersandDialog();
                    versand.onSent = () => this.loadInvoices(entity);
                    versand.open(this, entity, first, null);
                }
                // STEUER_APP_INVOICE_DETAIL=<Rechnungsnummer> (dev/testing hook): open that invoice's
                // detail dialog once, e.g. to capture the Doppelzahlung warning.
                const wanted = process.env.STEUER_APP_INVOICE_DETAIL;
                const target = wanted && !this.detailHookDone ? list.find((i) => i.number === wanted) : undefined;
                if (target) {
                    this.detailHookDone = true;
                    this.openDetail(target);
                }
            })
            .catch((err: unknown) => {
                if (token !== this.invoicesToken.current) return;
                this.invoices.clear();
                this.invoices.add(
                    new Adw.ActionRow({
                        title: 'Rechnungen nicht verfügbar',
                        subtitle: markup(err instanceof Error ? err.message : String(err)),
                    }),
                );
            });
    }

    /**
     * Pull the final number (or the replacement after a cancel) of each contract's last invoice from
     * the list just loaded. Best-effort: a failure leaves the contracts as they are, since the list
     * itself is already on screen.
     */
    private reconcileSchedules(entity: AppEntity, list: OutgoingInvoiceSummary[]): void {
        reconcileRecurringInvoices({ entityId: entity.id, invoices: list })
            .then((res) => {
                if (!res.rewritten || this.entity?.id !== entity.id) return;
                this.fillRecurring(loadRecurring(entity.id));
            })
            .catch((err: unknown) => {
                if (process.env.STEUER_APP_DEBUG) console.error(`[app] Vertrags-Abgleich fehlgeschlagen: ${err}`);
            });
    }

    /** Ledger history plus the pre-history `lastInvoice` marks; a read failure is logged, not shown. */
    private loadMailStatus(list: OutgoingInvoiceSummary[]): Map<string, InvoiceMailRecord> {
        if (!this.entity) return new Map();
        let status = new Map<string, InvoiceMailRecord>();
        try {
            status = loadEntityMailStatus(this.entity.id);
        } catch (err) {
            console.error(`[app] Versandstatus nicht lesbar: ${err}`);
        }
        try {
            return withLegacySent(status, loadRecurringInvoices(), this.entity.id, list);
        } catch (err) {
            console.error(`[app] Versandvermerke der Verträge nicht lesbar: ${err}`);
            return status;
        }
    }

    private fillInvoices(list: OutgoingInvoiceSummary[]): void {
        // Paid/cancelled invoices of the selected year, plus everything still unpaid of any year.
        this.allInvoices = selectInvoicesForYear(list, this.year, this.today);
        this.mailStatus = this.loadMailStatus(list);
        this.fillKpis();
        // Above the group, not in its header — see the comment on invoices_toolbar in the .blp.
        let child = this._invoices_toolbar.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._invoices_toolbar.remove(child);
            child = next;
        }
        this._invoices_toolbar.append(this.buildHeaderSuffix());
        this.renderInvoices();
    }

    /** Design: lead the view with a KPI-card row — open / overdue / paid totals. */
    private fillKpis(): void {
        let child = this._kpi_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._kpi_box.remove(child);
            child = next;
        }
        const sum = (pred: (d: DisplayInvoiceStatus) => boolean): { total: number; count: number } => {
            let total = 0;
            let count = 0;
            for (const inv of this.allInvoices) {
                if (!pred(this.dispStatus(inv))) continue;
                total += inv.total ?? 0;
                count += 1;
            }
            return { total, count };
        };
        const open = sum((d) => d === 'open' || d === 'overdue');
        const overdue = sum((d) => d === 'overdue');
        const paid = sum((d) => d === 'paid');
        this._kpi_box.append(
            kpiFlow([
                { label: 'Offen', value: eur(open.total), sub: `${open.count} Rechnung(en)` },
                {
                    label: 'Überfällig',
                    value: eur(overdue.total),
                    accent: overdue.total > 0 ? 'error' : undefined,
                    sub: `${overdue.count} Rechnung(en)`,
                },
                { label: 'Bezahlt', value: eur(paid.total), accent: 'success', sub: `${paid.count} Rechnung(en)` },
            ]),
        );
    }

    /** The invoices-group header suffix: the status filter + a capability-gated "Neue Rechnung". */
    private buildHeaderSuffix(): Gtk.Box {
        const box = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
        box.append(this.buildFilterToggle());
        if (this.capabilities?.createDraft) {
            const btn = new Gtk.Button({
                label: 'Neue Rechnung',
                cssClasses: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => this.newInvoice());
            box.append(btn);
        }
        return box;
    }

    /** Open the create form; refresh the list on save. */
    private newInvoice(): void {
        if (!this.entity) return;
        const form = new BhRechnungFormDialog();
        form.open(this, this.entity, null, () => this.entity && this.loadInvoices(this.entity));
    }

    /**
     * Back to "Alle" — the status-filter empty state's way out. Activates the chip so the buttons
     * cannot disagree with the state, then renders unconditionally: an ALREADY-active toggle emits
     * no `toggled`, so relying on the signal would leave the list untouched.
     */
    private resetInvoiceFilter(): void {
        this.filterButtons[0]?.set_active(true);
        this.filter = 'all';
        this.renderInvoices();
    }

    /** Render the invoice rows for the active filter. */
    private renderInvoices(): void {
        this.invoices.clear();
        const shown = this.allInvoices.filter((i) => this.filter === 'all' || this.dispStatus(i) === this.filter);
        this._invoices_group.set_description(`${this.allInvoices.length} gesamt`);
        if (shown.length === 0) {
            const filtered = this.filter !== 'all';
            this.invoices.add(
                filtered
                    ? emptyState({
                          icon: 'edit-find-symbolic',
                          title: 'Nichts in diesem Status',
                          description: 'Keine Rechnung hat diesen Status — ein anderer Filter zeigt mehr.',
                          action: { label: 'Alle zeigen', run: () => this.resetInvoiceFilter() },
                      })
                    : emptyState({
                          icon: 'document-send-symbolic',
                          title: 'Noch keine Rechnungen',
                          description: 'Ausgangsrechnungen entstehen hier — als PDF und als E-Rechnung (XRechnung).',
                          action: { label: 'Rechnung anlegen', run: () => this.newInvoice() },
                      }),
            );
            return;
        }
        for (const inv of shown) this.invoices.add(this.invoiceRow(inv));
    }

    /**
     * A linked ToggleButton row acting as the status filter. The buttons share ONE group
     * (`set_group`) so they behave like radios — exactly one is active and clicking the active one
     * cannot deselect it (previously they toggled independently, so several could be lit at once).
     */
    private buildFilterToggle(): Gtk.Box {
        const box = new Gtk.Box({ cssClasses: ['linked'], valign: Gtk.Align.CENTER });
        const buttons: Gtk.ToggleButton[] = [];
        this.filterButtons = buttons;
        let group: Gtk.ToggleButton | null = null;
        for (const f of FILTERS) {
            const btn = new Gtk.ToggleButton({ label: f.label });
            btn.add_css_class('caption');
            if (group) btn.set_group(group);
            else group = btn;
            btn.connect('toggled', () => {
                if (!btn.get_active()) return; // ignore the paired deactivation of the previous button
                this.filter = f.key;
                this.renderInvoices();
            });
            box.append(btn);
            buttons.push(btn);
        }
        // Light up the current filter (grouped → this deactivates the others).
        const active = Math.max(
            0,
            FILTERS.findIndex((f) => f.key === this.filter),
        );
        buttons[active]?.set_active(true);
        return box;
    }

    private invoiceRow(inv: OutgoingInvoiceSummary): Adw.ActionRow {
        const disp = this.dispStatus(inv);
        const who = inv.customerName || inv.number || inv.clientId || 'Rechnung';
        const sub = [
            inv.number ? `Nr. ${inv.number}` : null,
            inv.issueDate ? `ausgestellt ${deDate(inv.issueDate)}` : null,
            inv.dueDate ? `fällig ${deDate(inv.dueDate)}` : null,
        ].filter(Boolean);
        const row = new Adw.ActionRow({ title: markup(who), subtitle: markup(sub.join(' · ')), activatable: true });
        if (inv.total != null) row.add_suffix(amountLabel(eur(inv.total)));
        if (disp !== 'draft' && disp !== 'cancelled') {
            const mail = this.mailStatus.get(inv.id);
            if (mail?.result === 'sent') row.add_suffix(this.badge('gesendet', 'success'));
            else if (mail) row.add_suffix(this.badge('Versand fehlgeschlagen', 'error'));
            else row.add_suffix(this.badge('nicht gesendet', 'dim-label'));
        }
        row.add_suffix(this.badge(INVOICE_STATUS_LABEL[disp], STATUS_CSS[disp]));
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.openDetail(inv));
        return row;
    }

    /** Open the detail dialog for one invoice; refresh the list on any change. */
    private openDetail(inv: OutgoingInvoiceSummary): void {
        if (!this.entity || !this.capabilities) return;
        const dialog = new BhRechnungDetailDialog();
        dialog.onChanged = () => this.entity && this.loadInvoices(this.entity);
        dialog.open(this, this.entity, inv, this.capabilities);
    }

    private badge(label: string, css: string): Gtk.Label {
        return new Gtk.Label({ label, cssClasses: ['caption', css], valign: Gtk.Align.CENTER });
    }
}
