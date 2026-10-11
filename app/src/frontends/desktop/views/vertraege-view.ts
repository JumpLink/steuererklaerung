/**
 * <BhVertraegeView> — the Verträge view (ADR 0004), the native counterpart to `contracts liste`.
 *
 * What a running contract costs per month, and — the reason this view exists — when notice must be
 * given at the latest, as a badge that turns red while there is still time to act. Each row carries
 * the one finding that matters most (a missing debit, a returned one, a raised price), so the list
 * alone says which contract needs looking at; the detail dialog has the rest.
 *
 * Reads go through `presenters/contracts.ts` and are synchronous (the local ledger), so the whole
 * list is rendered in one pass. Suggesting contracts from recurring debits is step 5 of the ADR and
 * deliberately absent — it belongs to a background job, not to a view.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { deDate, eur } from '../../../core/lib/format.ts';
import {
    type ContractFilter,
    type ContractOverview,
    type ContractSummary,
    contractDeadlinesIcs,
    deadlineUrgency,
    filterContracts,
    latestFinding,
    loadContractOverview,
    monthlyTotal,
} from '../../../core/presenters/contracts.ts';
import type { AppEntity } from '../entities.ts';
import { _, _n, _p, fmt } from '../i18n.ts';
import { showToast } from '../toast.ts';
import Template from './vertraege-view.blp';
import { errorDialog } from './dialogs.ts';
import {
    applyScrollHook,
    amountLabel,
    emptyState,
    GroupRows,
    kpiFlow,
    loadIntoStack,
    LoadToken,
    markup,
    saveFileViaDialog,
} from './util.ts';
import { BhVertragDetailDialog } from './vertrag-detail-dialog.ts';
import { BhVertragFormDialog } from './vertrag-form-dialog.ts';
import {
    CYCLE_LABEL,
    deadlineBadge,
    findingCss,
    findingText,
    STATUS_CSS,
    STATUS_LABEL,
    URGENCY_CSS,
} from './vertrag-labels.ts';

/** The filter chips over the list. */
const FILTERS: { key: ContractFilter; label: string }[] = [
    { key: 'all', label: _('All') },
    { key: 'active', label: _p('contract filter', 'Active') },
    { key: 'deadline', label: _p('contract filter', 'Deadline near') },
    { key: 'archived', label: _p('contract filter', 'Archived') },
];

export class BhVertraegeView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _kpi_box: Gtk.Box;
    declare private _list_toolbar: Gtk.Box;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhVertraegeView',
                Template,
                InternalChildren: ['stack', 'error_page', 'scroller', 'kpi_box', 'list_toolbar', 'list_group'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly rows: GroupRows;
    private entity: AppEntity | null = null;
    private year = new Date().getFullYear();
    private overview: ContractOverview | null = null;
    private filter: ContractFilter = 'all';
    /** The chips, so an empty state can put the list back to "All". */
    private filterButtons: Gtk.ToggleButton[] = [];

    constructor() {
        super();
        this.rows = new GroupRows(this._list_group);
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        if (year > 0) this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Contracts could not be loaded'),
            load: () => loadContractOverview({ entityId: entity.id }), // synchronous: the local ledger
            fill: (overview) => {
                this.overview = overview;
                this.fillKpis(overview);
                this.fillToolbar();
                this.render();
                applyScrollHook(this._scroller);
            },
        });
    }

    /** Lead with what the contracts cost and how many deadlines are close enough to act on. */
    private fillKpis(overview: ContractOverview): void {
        clearBox(this._kpi_box);
        const live = filterContracts(overview.contracts, 'all');
        const active = live.filter((c) => c.status === 'active');
        const urgent = live.filter((c) => deadlineUrgency(c.deadline) === 'urgent');
        const soon = live.filter((c) => deadlineUrgency(c.deadline) === 'soon');
        const withFinding = live.filter((c) => (overview.findings[c.id]?.length ?? 0) > 0);
        this._kpi_box.append(
            kpiFlow([
                {
                    label: _('Per month'),
                    value: eur(monthlyTotal(live)),
                    sub: fmt(_n('{n} active contract', '{n} active contracts', active.length), { n: active.length }),
                },
                {
                    label: _('Per year'),
                    value: eur(Math.round(monthlyTotal(live) * 1200) / 100),
                    sub: _('derived from the intervals'),
                },
                {
                    label: _('Deadline near'),
                    value: String(urgent.length + soon.length),
                    accent: urgent.length > 0 ? 'error' : undefined,
                    sub: fmt(_n('{n} of them urgent', '{n} of them urgent', urgent.length), { n: urgent.length }),
                },
                {
                    label: _('Needs a look'),
                    value: String(withFinding.length),
                    accent: withFinding.length > 0 ? 'error' : undefined,
                    sub: _('missing, returned or changed debits'),
                },
            ]),
        );
    }

    /** The filter chips plus "New contract" and the calendar export, above the group (see the .blp). */
    private fillToolbar(): void {
        clearBox(this._list_toolbar);
        this._list_toolbar.append(this.buildFilterToggle());
        const spacer = new Gtk.Box({ hexpand: true });
        this._list_toolbar.append(spacer);
        const ics = new Gtk.Button({ label: _('Export deadlines'), valign: Gtk.Align.CENTER });
        ics.set_tooltip_text(_('Save the upcoming notice deadlines as a calendar file (.ics)'));
        ics.connect('clicked', () => this.exportDeadlines());
        this._list_toolbar.append(ics);
        const add = new Gtk.Button({
            label: _('New contract'),
            cssClasses: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        add.connect('clicked', () => this.edit(null));
        this._list_toolbar.append(add);
    }

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
                this.render();
            });
            box.append(btn);
            buttons.push(btn);
        }
        const active = Math.max(
            0,
            FILTERS.findIndex((f) => f.key === this.filter),
        );
        buttons[active]?.set_active(true);
        return box;
    }

    /**
     * Back to "All" — the way out of a filter that matched nothing. The chip is activated first so
     * the buttons cannot disagree with the state, then rendered unconditionally: an ALREADY active
     * toggle emits no `toggled`.
     */
    private resetFilter(): void {
        this.filterButtons[0]?.set_active(true);
        this.filter = 'all';
        this.render();
    }

    private render(): void {
        this.rows.clear();
        const overview = this.overview;
        if (!overview) return;
        const shown = filterContracts(overview.contracts, this.filter).sort(byDeadlineThenName);
        const live = filterContracts(overview.contracts, 'all').length;
        this._list_group.set_description(fmt(_n('{n} contract', '{n} contracts', live), { n: live }));
        if (shown.length === 0) {
            this.rows.add(overview.contracts.length === 0 ? this.firstRunState() : this.noMatchState());
            return;
        }
        for (const c of shown) this.rows.add(this.contractRow(c, overview));
    }

    private firstRunState(): Gtk.Widget {
        return emptyState({
            icon: 'text-x-generic-symbolic',
            title: _('No contracts yet'),
            description: _(
                'Hosting, insurance, a phone tariff — recorded once with its term and notice period, ' +
                    'the app works out by itself when the last day to cancel is.',
            ),
            action: { label: _('New contract'), run: () => this.edit(null) },
        });
    }

    private noMatchState(): Gtk.Widget {
        return emptyState({
            icon: 'edit-find-symbolic',
            title: _('Nothing under this filter'),
            description:
                this.filter === 'archived'
                    ? _('No contract has been archived yet.')
                    : _('No contract is in this state — another filter shows more.'),
            action: { label: _('Show all'), run: () => this.resetFilter() },
        });
    }

    private contractRow(c: ContractSummary, overview: ContractOverview): Adw.ActionRow {
        const finding = latestFinding(overview.findings[c.id]);
        const sub = [
            c.counterparty?.trim() || null,
            c.cycle ? fmt(_('{amount} {cycle}'), { amount: eur(c.amount ?? 0), cycle: CYCLE_LABEL[c.cycle] }) : null,
            finding ? findingText(finding) : null,
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(c.name),
            subtitle: markup(sub.join(' · ')),
            activatable: true,
        });
        row.set_title_lines(1);
        row.set_subtitle_lines(2);
        if (c.monthlyAmount != null) {
            const label = amountLabel(fmt(_('{amount} / month'), { amount: eur(c.monthlyAmount) }));
            label.set_tooltip_text(
                fmt(_('Derived from {amount} {cycle}'), {
                    amount: eur(c.amount ?? 0),
                    cycle: c.cycle ? CYCLE_LABEL[c.cycle] : '',
                }),
            );
            row.add_suffix(label);
        }
        if (finding) row.add_suffix(dot(findingCss(finding), findingText(finding)));
        const deadline = deadlineBadge(c.deadline);
        if (deadline) {
            const badge = this.badge(deadline, URGENCY_CSS[deadlineUrgency(c.deadline)]);
            badge.set_tooltip_text(
                c.deadline.kind === 'fixed'
                    ? fmt(_('Give notice by {date} at the latest'), { date: deDate(c.deadline.latestNotice) })
                    : _('Cancellable at any time'),
            );
            row.add_suffix(badge);
        }
        if (c.status !== 'active') row.add_suffix(this.badge(STATUS_LABEL[c.status], STATUS_CSS[c.status]));
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.openDetail(c));
        return row;
    }

    private openDetail(c: ContractSummary): void {
        const dialog = new BhVertragDetailDialog();
        dialog.open(this, c.id, {
            onEdit: () => this.edit(c),
            onChanged: () => this.entity && this.reload(this.entity, this.year),
        });
    }

    /** Open the form; `null` creates a contract. Re-reads the list on save. */
    private edit(c: ContractSummary | null): void {
        const entity = this.entity;
        if (!entity) return;
        const form = new BhVertragFormDialog();
        form.open(this, entity, c, () => this.reload(entity, this.year));
    }

    /**
     * The upcoming notice deadlines as an .ics file — the point being that the deadline then also
     * exists where someone actually looks, which is their calendar, not this app.
     */
    private exportDeadlines(): void {
        const entity = this.entity;
        if (!entity) return;
        try {
            const ics = contractDeadlinesIcs({ entityId: entity.id });
            saveFileViaDialog(
                this,
                `kuendigungsfristen-${entity.id}.ics`,
                new TextEncoder().encode(ics),
                _('Deadlines saved'),
            );
        } catch (err) {
            void errorDialog(this, _('Export failed'), err instanceof Error ? err.message : String(err));
            return;
        }
        showToast(_('Deadlines exported'));
    }

    private badge(label: string, css: string): Gtk.Label {
        return new Gtk.Label({ label, cssClasses: ['caption', css], valign: Gtk.Align.CENTER });
    }
}

/** The urgent deadlines first — what the view is for — then alphabetically. */
function byDeadlineThenName(a: ContractSummary, b: ContractSummary): number {
    const left = a.deadline.kind === 'fixed' ? a.deadline.daysLeft : Number.MAX_SAFE_INTEGER;
    const right = b.deadline.kind === 'fixed' ? b.deadline.daysLeft : Number.MAX_SAFE_INTEGER;
    return left === right ? a.name.localeCompare(b.name) : left - right;
}

/** A finding marker in the row's suffix; the text is in the subtitle, so this only carries colour. */
function dot(css: string, tooltip: string): Gtk.Image {
    const image = new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: [css] });
    image.set_tooltip_text(tooltip);
    return image;
}

function clearBox(box: Gtk.Box): void {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}
