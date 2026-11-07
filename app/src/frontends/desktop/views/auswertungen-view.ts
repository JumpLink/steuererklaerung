/**
 * <BhAuswertungenView> — the Auswertungen view.
 *
 * The v2 design puts the whole business picture on ONE stacked screen (no BWA|Einblicke tabs): a
 * KPI-card row (Gesamtleistung · Rohertrag · Betriebskosten · Betriebsergebnis), the monthly BWA
 * matrix, then the Einblicke card grid (data-derived advisory notices). Both the BWA and the
 * Hinweise are computed off the SAME EÜR aggregate, loaded once (see data/auswertungen.ts).
 *
 * Static chrome + section headings live in auswertungen-view.blp; the KPI cards, the matrix and the
 * Einblicke cards are built here because they're data-driven.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import GLib from '@girs/glib-2.0';
import Pango from '@girs/pango-1.0';

import Template from './auswertungen-view.blp';
import { type AuswertungenData, type BwaLine, type BwaResult, type Hinweis } from '../data/auswertungen.ts';
import { reads } from '../read/index.ts';
import type { AppEntity } from '../entities.ts';
import { eur, pct } from '../../../core/lib/format.ts';
import { LoadToken, MONTHS, applyScrollHook, kpiFlow, loadIntoStack, markup } from './util.ts';
import { chipScroller } from '../widgets/responsive.ts';
import { onNarrow } from '../widgets/narrow.ts';
import { bwaDefaultMonth, bwaMonthColumnStart, bwaMonthScrollTarget } from '../widgets/phone-rules.ts';
import { _, fmt } from '../i18n.ts';
import { hinweisDetails } from './hinweis-handlung.ts';

/** Per-level icon + colour class + sort order (most urgent first) — mirrors the web dot levels. */
const LEVEL: Record<string, { icon: string; css: string; order: number }> = {
    warnung: { icon: 'dialog-warning-symbolic', css: 'warning', order: 0 },
    tipp: { icon: 'emblem-important-symbolic', css: 'accent', order: 1 },
    info: { icon: 'dialog-information-symbolic', css: 'dim-label', order: 2 },
};

export class BhAuswertungenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _kpi_box: Gtk.Box;
    declare private _table_box: Gtk.Box;
    declare private _einblicke_box: Gtk.FlowBox;
    declare private _scroller: Gtk.ScrolledWindow;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhAuswertungenView',
                Template,
                InternalChildren: ['stack', 'error_page', 'kpi_box', 'table_box', 'einblicke_box', 'scroller'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private year = 0;
    private entity: AppEntity | null = null;
    private bwa: BwaResult | null = null;
    private phone = false;

    constructor() {
        super();
        onNarrow(this, (narrow) => {
            if (narrow === this.phone) return;
            this.phone = narrow;
            if (this.bwa) this.fillGrid(this.bwa);
        });
    }

    reload(entity: AppEntity, year: number): void {
        this.year = year;
        this.entity = entity;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('The reports could not be calculated'),
            load: () => reads.auswertungen(entity, year),
            fill: (data) => this.fill(data),
        });
    }

    private fill(data: AuswertungenData): void {
        this.bwa = data.bwa;
        this.fillKpi(data.bwa);
        this.fillGrid(data.bwa);
        this.fillEinblicke(data.hinweise);
        applyScrollHook(this._scroller);
        if (process.env.STEUER_APP_DEBUG) {
            console.error(
                `[app] Auswertungen ${data.bwa.year} ok: ${data.bwa.lines.length} BWA-Zeilen, ${data.hinweise.length} Hinweise`,
            );
        }
    }

    // ── KPI row ──────────────────────────────────────────────────────────
    private fillKpi(r: BwaResult): void {
        this.clearBox(this._kpi_box);
        const ergebnis = r.totals.betriebsergebnis;
        this._kpi_box.append(
            kpiFlow([
                {
                    label: 'Gesamtleistung',
                    value: eur(r.totals.gesamtleistung),
                    sub: `BWA ${r.year}`,
                    help: 'gesamtleistung',
                },
                { label: 'Rohertrag', value: eur(r.totals.rohertrag), help: 'rohertrag' },
                // German like its three neighbours and like the BWA row right below it
                // (core/elster/bwa.ts) — the BWA metric names are the labels, in both languages.
                { label: 'Summe Betriebskosten', value: eur(r.totals.betriebskosten) },
                {
                    label: 'Betriebsergebnis',
                    value: eur(ergebnis),
                    accent: ergebnis >= 0 ? 'success' : 'error',
                    help: 'betriebsergebnis',
                },
            ]),
        );
    }

    // ── BWA · monatlich matrix ───────────────────────────────────────────
    private fillGrid(r: BwaResult): void {
        this.clearTableBox();
        const table = this.phone ? this.buildPhoneGrid(r) : this.buildDesktopGrid(r);
        this._table_box.append(table);
    }

    /** Desktop: one horizontal scroller around a card-wrapped grid. */
    private buildDesktopGrid(r: BwaResult): Gtk.Widget {
        const grid = new Gtk.Grid({
            columnSpacing: 24,
            rowSpacing: 8,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        const lastCol = r.months.length + 1;
        grid.attach(this.headerCell(_('Item'), false), 0, 0, 1, 1);
        r.months.forEach((m, i) => grid.attach(this.headerCell(MONTHS[m] ?? String(m), true), i + 1, 0, 1, 1));
        grid.attach(this.headerCell(_('Σ year'), true), lastCol, 0, 1, 1);
        r.lines.forEach((line, idx) => {
            const row = idx + 1;
            grid.attach(this.labelCell(line), 0, row, 1, 1);
            line.perMonth.forEach((v, i) => grid.attach(this.valueCell(v, line), i + 1, row, 1, 1));
            grid.attach(this.valueCell(line.total, line), lastCol, row, 1, 1);
        });
        return new Gtk.ScrolledWindow({
            hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
            vscrollbarPolicy: Gtk.PolicyType.NEVER,
            propagateNaturalWidth: false,
            child: new Adw.Bin({ cssClasses: ['card'], child: grid }),
        });
    }

    /**
     * Phone: frozen item column on the left, horizontally scrollable month + total columns on the
     * right. A chip row above the table jumps to the selected month; the table opens on the current
     * month instead of January.
     */
    private buildPhoneGrid(r: BwaResult): Gtk.Widget {
        const itemGrid = new Gtk.Grid({
            rowHomogeneous: true,
            rowSpacing: 8,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 12,
        });
        itemGrid.attach(this.headerCell(_('Item'), false), 0, 0, 1, 1);
        r.lines.forEach((line, idx) => itemGrid.attach(this.labelCell(line, true), 0, idx + 1, 1, 1));

        const monthGrid = new Gtk.Grid({
            rowHomogeneous: true,
            columnHomogeneous: true,
            columnSpacing: 24,
            rowSpacing: 8,
            marginTop: 12,
            marginBottom: 12,
            marginEnd: 12,
        });
        const totalCol = r.months.length;
        const monthHeaders: Gtk.Label[] = [];
        r.months.forEach((m, i) => {
            const cell = this.headerCell(MONTHS[m] ?? String(m), true);
            monthHeaders[i] = cell;
            monthGrid.attach(cell, i, 0, 1, 1);
        });
        monthGrid.attach(this.headerCell(_('Σ year'), true), totalCol, 0, 1, 1);
        r.lines.forEach((line, idx) => {
            const row = idx + 1;
            line.perMonth.forEach((v, i) => monthGrid.attach(this.valueCell(v, line), i, row, 1, 1));
            monthGrid.attach(this.valueCell(line.total, line), totalCol, row, 1, 1);
        });

        const hscroller = new Gtk.ScrolledWindow({
            hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
            vscrollbarPolicy: Gtk.PolicyType.NEVER,
            propagateNaturalWidth: false,
            hexpand: true,
            child: monthGrid,
        });

        const rowBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
        rowBox.append(itemGrid);
        rowBox.append(hscroller);

        const sizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
        sizeGroup.add_widget(itemGrid);
        sizeGroup.add_widget(hscroller);

        const card = new Gtk.Box({ cssClasses: ['card'], orientation: Gtk.Orientation.VERTICAL });
        card.append(rowBox);

        const chipBox = this.buildMonthChips(r.months, hscroller, monthHeaders, monthGrid);
        const chipScrollerWidget = chipScroller(chipBox);

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        box.append(chipScrollerWidget);
        box.append(card);

        const defaultMonth = bwaDefaultMonth(r.months);
        this.scrollToMonthOnMap(hscroller, defaultMonth, r.months, monthHeaders, monthGrid);

        return box;
    }

    private buildMonthChips(
        months: number[],
        hscroller: Gtk.ScrolledWindow,
        headers: Gtk.Label[],
        monthGrid: Gtk.Grid,
    ): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        const defaultMonth = bwaDefaultMonth(months);
        let group: Gtk.ToggleButton | null = null;
        for (const m of months) {
            const btn = new Gtk.ToggleButton({ label: MONTHS[m] ?? String(m), active: m === defaultMonth });
            if (group) btn.set_group(group);
            else group = btn;
            btn.connect('toggled', () => {
                if (!btn.get_active()) return;
                this.scrollToMonth(hscroller, m, months, headers, monthGrid);
            });
            box.append(btn);
        }
        return box;
    }

    private scrollToMonthOnMap(
        hscroller: Gtk.ScrolledWindow,
        month: number,
        months: number[],
        headers: Gtk.Label[],
        monthGrid: Gtk.Grid,
    ): void {
        // The widget is built before it is added to the widget tree. Scrolling before mapping has
        // no effect (or is reset by GTK's own allocation), so wait for the first map and then keep
        // retrying in idle until the scroller has a real allocation.
        const schedule = () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                const adjustment = hscroller.get_hadjustment();
                const index = months.indexOf(month);
                const header = headers[index];
                if (
                    adjustment.get_page_size() <= 0 ||
                    adjustment.get_upper() <= adjustment.get_page_size() ||
                    !header ||
                    header.get_allocated_width() <= 0
                ) {
                    return GLib.SOURCE_CONTINUE;
                }
                this.scrollToMonth(hscroller, month, months, headers, monthGrid);
                return GLib.SOURCE_REMOVE;
            });
        };
        if (hscroller.get_mapped()) {
            schedule();
        } else {
            const mapHandler = hscroller.connect('map', () => {
                hscroller.disconnect(mapHandler);
                schedule();
            });
        }
    }

    private scrollToMonth(
        hscroller: Gtk.ScrolledWindow,
        month: number,
        months: number[],
        headers: Gtk.Label[],
        monthGrid: Gtk.Grid,
    ): void {
        const adjustment = hscroller.get_hadjustment();
        const index = months.indexOf(month);
        if (index < 0) return;
        const header = headers[index];
        if (!header) return;
        // With homogeneous columns every month column has the same width. Derive it from the grid's
        // own allocation: child label allocations are still settling when the first map fires, so
        // reading a single header gives 18 px while the grid already knows it is 1005 px wide.
        const spacing = monthGrid.get_column_spacing();
        const numColumns = months.length + 1; // months + Σ year
        const gridWidth = monthGrid.get_allocated_width();
        const totalSpacing = (numColumns - 1) * spacing;
        const columnWidth = (gridWidth - monthGrid.get_margin_end() - totalSpacing) / numColumns;
        const start = bwaMonthColumnStart(index, columnWidth, spacing);
        const target = bwaMonthScrollTarget({
            start,
            value: adjustment.get_value(),
            page: adjustment.get_page_size(),
            upper: adjustment.get_upper(),
        });
        if (target !== null) adjustment.set_value(target);
    }

    private headerCell(text: string, numeric: boolean): Gtk.Label {
        return new Gtk.Label({
            label: text,
            xalign: numeric ? 1 : 0,
            halign: numeric ? Gtk.Align.END : Gtk.Align.START,
            cssClasses: ['heading', 'caption'],
        });
    }

    private labelCell(line: BwaLine, phone = false): Gtk.Label {
        const emphasised = line.level === 'subtotal' || line.level === 'result';
        return new Gtk.Label({
            label: line.label,
            xalign: 0,
            halign: Gtk.Align.START,
            marginStart: line.level === 'line' ? 12 : 0,
            cssClasses: emphasised ? ['heading'] : line.level === 'margin' ? ['dim-label'] : [],
            maxWidthChars: phone ? 12 : -1,
            ellipsize: phone ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE,
            singleLineMode: phone,
            tooltipText: phone ? line.label : null,
        });
    }

    private valueCell(value: number | null, line: BwaLine): Gtk.Label {
        const text = value == null ? '—' : line.level === 'margin' ? pct(value) : eur(value);
        const classes = ['numeric'];
        if (line.level === 'subtotal' || line.level === 'result') classes.push('heading');
        if (line.level === 'margin') classes.push('dim-label');
        return new Gtk.Label({ label: text, xalign: 1, halign: Gtk.Align.END, cssClasses: classes });
    }

    // ── Einblicke cards ──────────────────────────────────────────────────
    private fillEinblicke(hinweise: Hinweis[]): void {
        this.clearFlowBox();
        if (hinweise.length === 0) {
            this._einblicke_box.append(this.einblickeEmptyCard());
            return;
        }
        const sorted = [...hinweise].sort((a, b) => (LEVEL[a.level]?.order ?? 9) - (LEVEL[b.level]?.order ?? 9));
        for (const h of sorted) this._einblicke_box.append(this.einblickeCard(h));
    }

    private einblickeCard(h: Hinweis): Gtk.Widget {
        const meta = LEVEL[h.level] ?? LEVEL.info;
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            marginTop: 14,
            marginBottom: 14,
            marginStart: 16,
            marginEnd: 16,
        });

        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        head.append(new Gtk.Image({ iconName: meta.icon, cssClasses: [meta.css], valign: Gtk.Align.START }));
        head.append(
            new Gtk.Label({
                label: markup(h.title),
                useMarkup: true,
                xalign: 0,
                hexpand: true,
                wrap: true,
                cssClasses: ['heading'],
            }),
        );
        if (h.ref) {
            head.append(new Gtk.Label({ label: h.ref, cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.START }));
        }
        body.append(head);

        body.append(
            new Gtk.Label({ label: markup(h.text), useMarkup: true, xalign: 0, wrap: true, cssClasses: ['dim-label'] }),
        );
        const entity = this.entity;
        if (entity) {
            const year = this.year;
            const details = hinweisDetails(this, { entity, year, onChanged: () => this.reload(entity, year) }, h);
            if (details) body.append(details);
        }

        const card = new Gtk.Box({ cssClasses: ['card'], valign: Gtk.Align.START });
        card.append(body);
        return card;
    }

    private einblickeEmptyCard(): Gtk.Widget {
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            marginTop: 14,
            marginBottom: 14,
            marginStart: 16,
            marginEnd: 16,
        });
        body.append(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] }));
        body.append(new Gtk.Label({ label: fmt(_('No hints for {year}'), { year: this.year }), xalign: 0 }));
        const card = new Gtk.Box({ cssClasses: ['card'], valign: Gtk.Align.START });
        card.append(body);
        return card;
    }

    // ── clearing helpers ─────────────────────────────────────────────────
    private clearBox(box: Gtk.Box): void {
        let child = box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }

    private clearTableBox(): void {
        let child = this._table_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._table_box.remove(child);
            child = next;
        }
    }

    private clearFlowBox(): void {
        let child = this._einblicke_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._einblicke_box.remove(child);
            child = next;
        }
    }
}
