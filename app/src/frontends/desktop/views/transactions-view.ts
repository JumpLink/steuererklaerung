/**
 * <BhTransactionsView> — the Buchungen view.
 *
 * The v2 design (01-buchungen.png): a KPI-card row, a search box, filter chips
 * (Alle · Einnahmen · Ausgaben · Ohne Beleg), then one row per booking with an "ohne Beleg" badge
 * where a Vorsteuer expense lacks its receipt, and a click → the full transaction detail.
 *
 * Unlike the first port (a raw store read), the list is the ENRICHED aggregate the web Transaktionen
 * uses (classification + linked receipt + raw bank fields), so it can show the receipt state and the
 * per-row detail. Data + join live in the shared core presenter (presenters/buchungen.ts) — the SAME
 * receipt-join the web year-cache uses (async; shares the session's warm aggregate + document caches).
 *
 * Static chrome lives in transactions-view.blp; the KPI cards, chips and rows are built here.
 *
 * „Auswählen“ (Idee 14) turns the expense rows into check rows; „Projekt zuordnen“ then assigns all marked
 * expenses to one project (optionally remembering the shared text as a project rule). A row shows its
 * project, and the booking detail sets and takes it back.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import GLib from '@girs/glib-2.0';

import Template from './transactions-view.blp';
import type { EnrichedTxData, EnrichedTxRow } from '../../../core/presenters/buchungen.ts';
import { nimmProjektZuordnungZurueck, type ProjektAnsicht } from '../../../core/presenters/projekt.ts';
import { appSession } from '../data/session.ts';
import { reads } from '../read/index.ts';
import { loadDms } from '../data/settings.ts';
import { loadEntityProjects } from '../data/projects.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { UNKLASSIFIZIERT } from '../../../core/elster/euer-classify.ts';
import { showToast, showUndoToast } from '../toast.ts';
import { BhProjektZuordnenDialog } from './projekt-zuordnen-dialog.ts';
import { BhTxDetailDialog } from './tx-detail-dialog.ts';
import { GroupRows, LoadToken, amountLabel, emptyState, kpiFlow, loadIntoStack, markup, type Kpi } from './util.ts';
import { onNarrow } from '../widgets/narrow.ts';
import { kpiBlockMode, phoneSubtitleLines, searchVisible } from '../widgets/phone-rules.ts';
import type { ViewAction } from '../view.ts';
import { navigateTo } from '../nav.ts';
import { _, fmt } from '../i18n.ts';

/** Cap the rendered rows — a non-virtualised boxed list stays snappy up to a few hundred. */
const MAX_ROWS = 400;

/**
 * Rows built per main-loop turn. Building and laying out 400 ActionRows in one go held the loop for
 * ~450 ms after the page reported ready; in batches each turn is a frame or two and the window keeps
 * painting (and the first screenful is there at once).
 */
const ROW_BATCH = 40;

type TxFilter = 'all' | 'income' | 'expense' | 'ohneBeleg';
const FILTERS: { id: TxFilter; label: string }[] = [
    { id: 'all', label: _('All') },
    { id: 'income', label: _('Income') },
    { id: 'expense', label: _('Expenses') },
    { id: 'ohneBeleg', label: _('Without receipt') },
];

/** The audit-relevant Beleg gap: a Vorsteuer-bearing expense with no linked receipt. */
const isOhneBeleg = (r: EnrichedTxRow): boolean => r.kind === 'expense' && Math.abs(r.vat) > 0.005 && !r.receipt;

export class BhTransactionsView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _kpi_box: Gtk.Box;
    declare private _search_revealer: Gtk.Revealer;
    declare private _search_entry: Gtk.SearchEntry;
    declare private _filter_box: Gtk.Box;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhTransactionsView',
                Template,
                InternalChildren: [
                    'stack',
                    'error_page',
                    'kpi_box',
                    'search_revealer',
                    'search_entry',
                    'filter_box',
                    'list_group',
                ],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly list: GroupRows;
    private rows: EnrichedTxRow[] = [];
    private filter: TxFilter = 'all';
    private search = '';
    private paperlessBase: string | null = null;
    /** Held so a row action (Umbuchen) can reload the same entity-year it was opened for. */
    private entity: AppEntity | null = null;
    private year = 0;
    /** Whether the current entity's rows carry the EÜR classification (business) vs a raw list (privat). */
    private classified = true;
    /** The projects of the year (Idee 14); null for a privat entity or when they could not be read. */
    private projekte: ProjektAnsicht | null = null;
    /** „Auswählen“: the expense rows carry a check box, a click toggles instead of opening the detail. */
    private selecting = false;
    private readonly marked = new Set<string>();
    private zuordnenButton: Gtk.Button | null = null;
    /** The idle source that builds the remaining rows; replaced or removed by the next render. */
    private rowSource = 0;
    /** Mirrors the window's `narrow`; the KPI block, the search entry and the subtitles follow it. */
    private phone = false;
    /** The header menu's Search was pressed — the entry stays revealed until the width widens. */
    private searchRequested = false;
    private kpis: Kpi[] = [];

    /** On a phone the search entry hides behind the header menu, which is where GNOME puts it. */
    headerActions(): ViewAction[] {
        return [
            {
                label: _('Search'),
                iconName: 'edit-find-symbolic',
                run: () => {
                    this.searchRequested = true;
                    this.applySearchVisibility();
                    this._search_entry.grab_focus();
                },
            },
        ];
    }

    private applySearchVisibility(): void {
        this._search_revealer.set_reveal_child(searchVisible(this.phone, this.searchRequested, this.search));
    }

    constructor() {
        super();
        this.list = new GroupRows(this._list_group);
        onNarrow(this, (narrow) => {
            if (narrow === this.phone) return;
            this.phone = narrow;
            if (!narrow) this.searchRequested = false;
            this.applySearchVisibility();
            // Both are rebuilt rather than restyled: a rebuilt block is the simplest way to swap
            // cards for an expander, and the row cap is cheap to re-apply.
            if (this.kpis.length) this.renderKpi();
            if (this.rows.length) this.renderList();
        });
        this._search_entry.connect('search-changed', () => {
            this.search = (this._search_entry.get_text() ?? '').trim().toLowerCase();
            this.applySearchVisibility();
            this.renderList();
        });
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        // A business entity (ELSTER config) gets the classified aggregate (categories + receipts →
        // "ohne Beleg"); a `privat` entity gets the raw cash list (no Vorsteuer/Beleg concept).
        const business = !!entity.elster;
        this.buildFilterChips(business);
        // STEUER_APP_SEARCH=<text> (dev/testing hook): prefill the search box, so the rig can reach
        // the filtered-to-nothing empty state — the one a screenshot otherwise cannot produce,
        // because there is no way to type into an entry over D-Bus.
        const preset = process.env.STEUER_APP_SEARCH;
        if (preset) {
            this.search = preset.trim().toLowerCase();
            this._search_entry.set_text(preset);
        }
        try {
            this.paperlessBase = business ? (loadDms(entity).paperlessUrl ?? null) : null;
        } catch {
            this.paperlessBase = null;
        }
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Could not load the transactions'),
            load: () => reads.transaktionen(entity, year),
            fill: ({ data, projekte, projekteFehler }) => {
                if (projekteFehler) console.error(`[app] Projekte: ${projekteFehler}`);
                this.projekte = projekte;
                this.fill(data, year);
            },
        });
    }

    private fill(data: EnrichedTxData, year: number): void {
        this.rows = data.rows;
        this.classified = data.classified;
        // A reload (after an assignment) ends the selection; ids of rows that are gone stay out of it.
        this.selecting = false;
        this.marked.clear();
        this.fillKpi(data, year);
        this.renderList();
        if (process.env.STEUER_APP_DEBUG) console.error(`[app] Buchungen ${year} ok: ${data.rows.length} Zeilen`);
    }

    private fillKpi(data: EnrichedTxData, year: number): void {
        const t = data.totals;
        // The net figures come from the EÜR aggregate (same numbers the Steuer view shows); the count
        // is the classified rows. Ausgaben is a positive magnitude in the aggregate — show it signed.
        this.kpis = [
            { label: fmt(_('Transactions {year}'), { year }), value: String(data.rows.length) },
            { label: _('Income'), value: eur(t.incomeNet), accent: 'success', sub: fmt(_('net {year}'), { year }) },
            { label: _('Expenses'), value: eur(-t.expenseNet), accent: 'error', sub: fmt(_('net {year}'), { year }) },
            { label: _('Balance'), value: eur(t.profit), accent: t.profit >= 0 ? 'success' : 'error' },
        ];
        this.renderKpi();
    }

    private renderKpi(): void {
        let child = this._kpi_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._kpi_box.remove(child);
            child = next;
        }
        const cards = kpiFlow(this.kpis);
        if (kpiBlockMode(this.phone, this.kpis.length) === 'cards') {
            this._kpi_box.append(cards);
            return;
        }
        // A list view's numbers are context, not content: one closed row titled with the balance
        // keeps them reachable without pushing the first booking below the fold.
        const balance = this.kpis[this.kpis.length - 1];
        const expander = new Adw.ExpanderRow({
            title: _('Figures'),
            subtitle: markup(`${balance.label}: ${balance.value}`),
        });
        expander.add_row(new Gtk.ListBoxRow({ child: cards, activatable: false, selectable: false }));
        const group = new Adw.PreferencesGroup();
        group.add(expander);
        this._kpi_box.append(group);
    }

    /**
     * (Re)build the linked toggle group. Business: Alle · Einnahmen · Ausgaben · Ohne Beleg; a raw
     * `privat` list drops "Ohne Beleg" (no Vorsteuer/Beleg concept). Resets the active filter to Alle.
     */
    private buildFilterChips(business: boolean): void {
        let child = this._filter_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._filter_box.remove(child);
            child = next;
        }
        this.filter = 'all';
        const filters = business ? FILTERS : FILTERS.filter((f) => f.id !== 'ohneBeleg');
        let group: Gtk.ToggleButton | null = null;
        for (const f of filters) {
            const btn = new Gtk.ToggleButton({ label: f.label, active: f.id === this.filter });
            if (group) btn.set_group(group);
            else group = btn;
            btn.connect('toggled', () => {
                if (!btn.get_active()) return;
                this.filter = f.id;
                this.renderList();
            });
            this._filter_box.append(btn);
        }
    }

    /** Apply the active chip + the search text, then render the visible rows. */
    private renderList(): void {
        const q = this.search;
        const shown = this.rows.filter((r) => {
            if (this.filter === 'income' && r.kind !== 'income') return false;
            if (this.filter === 'expense' && r.kind !== 'expense') return false;
            if (this.filter === 'ohneBeleg' && !isOhneBeleg(r)) return false;
            if (q) {
                const hay = `${r.counterparty ?? ''} ${r.purpose ?? ''} ${r.category ?? ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        this.fillList(shown);
    }

    /** Ctrl+F lands here — the {@link Searchable} seam the window asks the visible view for. */
    focusSearch(): void {
        this._search_entry.grab_focus();
    }

    /** Clear search and filter chips, then re-render — the empty state's way out. */
    private resetFilters(): void {
        this.search = '';
        this._search_entry.set_text('');
        // Activate the first chip so the buttons cannot disagree with the state — but do NOT rely
        // on its `toggled` signal to re-render: a chip that is ALREADY active emits nothing, which
        // is exactly the case where only the search box was narrowing the list.
        const first = this._filter_box.get_first_child();
        if (first instanceof Gtk.ToggleButton) first.set_active(true);
        this.filter = 'all';
        this.renderList();
    }

    private fillList(rows: EnrichedTxRow[]): void {
        this.cancelRowBuild();
        this.list.clear();
        const shown = rows.slice(0, MAX_ROWS);
        this._list_group.set_title(_('Transactions'));
        this._list_group.set_description(
            rows.length > shown.length
                ? fmt(_('{shown} of {total} shown'), { shown: shown.length, total: rows.length })
                : fmt(_('{total} total'), { total: rows.length }),
        );
        this.buildSelectBar();
        if (shown.length === 0) {
            // Two different kinds of empty, two different answers. Filtered-to-nothing means widen
            // the filter; nothing at all means there is no account connected yet — and on a fresh
            // install THAT is what every list in the app says, so it had better say what to do.
            const filtered = this.search !== '' || this.filter !== 'all';
            this.list.add(
                filtered
                    ? emptyState({
                          icon: 'edit-find-symbolic',
                          title: _('Nothing found'),
                          description: _('No transaction matches the search and filter.'),
                          action: { label: _('Reset filter'), run: () => this.resetFilters() },
                      })
                    : emptyState({
                          icon: 'view-list-symbolic',
                          title: _('No transactions yet'),
                          description: _('Transactions come from a connected account or from an imported file.'),
                          action: { label: _('Connect account'), run: () => navigateTo(this, 'konten') },
                      }),
            );
            return;
        }
        const first = shown.slice(0, ROW_BATCH);
        for (const r of first) this.list.add(this.buildRow(r));
        this.applyDetailHook(shown);
        this.buildRestInBatches(shown, first.length);
    }

    private cancelRowBuild(): void {
        if (this.rowSource) GLib.source_remove(this.rowSource);
        this.rowSource = 0;
    }

    /** Build `shown[from…]` ROW_BATCH at a time on idle; a newer render cancels what is left. */
    private buildRestInBatches(shown: EnrichedTxRow[], from: number): void {
        let next = from;
        if (next >= shown.length) return;
        this.rowSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const end = Math.min(next + ROW_BATCH, shown.length);
            for (; next < end; next++) this.list.add(this.buildRow(shown[next]));
            if (next < shown.length) return GLib.SOURCE_CONTINUE;
            this.rowSource = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The header of the list: „Auswählen“, and while selecting „Projekt zuordnen (N)“ and „Fertig“. Business entities only. */
    private buildSelectBar(): void {
        if (!this.classified || !this.entity) {
            this._list_group.set_header_suffix(null);
            return;
        }
        const bar = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        if (this.selecting) {
            this.zuordnenButton = new Gtk.Button({ label: _('Assign to project'), cssClasses: ['suggested-action'] });
            this.zuordnenButton.set_tooltip_text(_('Assign the marked expenses to a project'));
            this.zuordnenButton.connect('clicked', () => this.openZuordnen());
            bar.append(this.zuordnenButton);
            this.updateZuordnen();
        }
        const toggle = new Gtk.Button({ label: this.selecting ? _('Done') : _('Select'), cssClasses: ['flat'] });
        toggle.set_tooltip_text(this.selecting ? _('End selection') : _('Mark expenses to assign them to a project'));
        toggle.connect('clicked', () => {
            this.selecting = !this.selecting;
            this.marked.clear();
            this.renderList();
        });
        bar.append(toggle);
        this._list_group.set_header_suffix(bar);
    }

    private updateZuordnen(): void {
        const n = this.marked.size;
        this.zuordnenButton?.set_label(n > 0 ? fmt(_('Assign to project ({n})'), { n }) : _('Assign to project'));
        this.zuordnenButton?.set_sensitive(n > 0);
    }

    private openZuordnen(): void {
        const entity = this.entity;
        if (!entity || this.marked.size === 0) return;
        const projekte = loadEntityProjects(entity.id).map((p) => ({ id: p.id, name: p.name }));
        const ids = [...this.marked];
        new BhProjektZuordnenDialog(entity, this.year, ids, projekte, true, (message, geaendert) => {
            appSession().invalidate(entity.id, this.year);
            this.reload(entity, this.year);
            if (geaendert.length === 0) return showToast(message);
            showUndoToast(message, () => {
                void nimmProjektZuordnungZurueck(appSession(), entity, this.year, geaendert).then((r) => {
                    showToast(r.zurueckgenommen[0]?.danach ?? _('Assignment taken back'));
                    this.reload(entity, this.year);
                });
            });
        }).present(this);
    }

    /** One booking row: counterparty + date·purpose·category, an "ohne Beleg" badge, the signed amount, → detail. */
    private buildRow(r: EnrichedTxRow): Adw.ActionRow {
        const title =
            r.counterparty?.trim() ||
            r.purpose?.trim() ||
            (r.category === UNKLASSIFIZIERT ? _('(unclassified)') : r.category);
        const sub = [deDate(r.bookingDate)];
        if (r.purpose && r.counterparty) sub.push(r.purpose.trim());
        if (r.category && r.category !== UNKLASSIFIZIERT) sub.push(r.category);
        const projekt = this.projekte?.buchungen[r.id]?.projekte;
        if (projekt?.length)
            sub.push(fmt(_('Project {names}'), { names: [...new Set(projekt.map((p) => p.projektName))].join(', ') }));
        const row = new Adw.ActionRow({ title: markup(title), subtitle: markup(sub.join('  ·  ')), activatable: true });
        // A three-line subtitle makes a 40-row list unscannable at phone width.
        if (this.phone) row.set_subtitle_lines(phoneSubtitleLines(true));

        if (this.selecting && r.amount < 0) {
            const check = new Gtk.CheckButton({ active: this.marked.has(r.id), valign: Gtk.Align.CENTER });
            check.set_tooltip_text(fmt(_('Select: {title} · {date}'), { title, date: deDate(r.bookingDate) }));
            check.connect('toggled', () => {
                if (check.get_active()) this.marked.add(r.id);
                else this.marked.delete(r.id);
                this.updateZuordnen();
            });
            row.add_prefix(check);
            row.set_activatable_widget(check);
            row.add_suffix(amountLabel(eur(r.amount), { accent: 'error' }));
            return row;
        }

        if (isOhneBeleg(r)) {
            row.add_suffix(
                new Gtk.Label({ label: _('no receipt'), cssClasses: ['caption', 'warning'], valign: Gtk.Align.CENTER }),
            );
        }
        row.add_suffix(amountLabel(eur(r.amount), { accent: r.amount < 0 ? 'error' : 'success' }));
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.openDetail(r));
        return row;
    }

    /**
     * `STEUER_APP_TX_DETAIL=1` (dev/testing hook): open the detail sheet on the first row, so the
     * Umbuchen affordance can be captured. An Adw.Dialog renders inside the window.
     */
    private applyDetailHook(rows: EnrichedTxRow[]): void {
        if (process.env.STEUER_APP_TX_DETAIL !== '1') return;
        const first = rows.find((r) => r.category);
        if (first) this.openDetail(first);
    }

    private openDetail(r: EnrichedTxRow): void {
        {
            const entity = this.entity;
            if (!entity) return;
            new BhTxDetailDialog().open(this, r, this.paperlessBase, {
                entity,
                year: this.year,
                projekt: this.classified
                    ? {
                          projekte: loadEntityProjects(entity.id).map((p) => ({ id: p.id, name: p.name })),
                          ansicht: this.projekte?.buchungen[r.id] ?? null,
                      }
                    : undefined,
                onChanged: () => {
                    // A reclassification changes what the EÜR sums, not just this row's label.
                    appSession().invalidate(entity.id, this.year);
                    this.reload(entity, this.year);
                },
            });
        }
    }
}
