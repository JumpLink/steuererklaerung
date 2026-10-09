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

import Template from './auswertungen-view.blp';
import {
    loadAuswertungen,
    type AuswertungenData,
    type BwaLine,
    type BwaResult,
    type Hinweis,
} from '../data/auswertungen.ts';
import type { AppEntity } from '../entities.ts';
import { eur, pct } from '../../../core/lib/format.ts';
import { LoadToken, MONTHS, applyScrollHook, kpiFlow, loadIntoStack, markup } from './util.ts';
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
    declare private _grid: Gtk.Grid;
    declare private _einblicke_box: Gtk.FlowBox;
    declare private _scroller: Gtk.ScrolledWindow;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhAuswertungenView',
                Template,
                InternalChildren: ['stack', 'error_page', 'kpi_box', 'grid', 'einblicke_box', 'scroller'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private year = 0;
    private entity: AppEntity | null = null;

    reload(entity: AppEntity, year: number): void {
        this.year = year;
        this.entity = entity;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Auswertungen konnten nicht berechnet werden',
            load: () => loadAuswertungen(entity, year),
            fill: (data) => this.fill(data),
        });
    }

    private fill(data: AuswertungenData): void {
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
        this.clearGrid();
        const lastCol = r.months.length + 1;

        this._grid.attach(this.headerCell('Position', false), 0, 0, 1, 1);
        r.months.forEach((m, i) => this._grid.attach(this.headerCell(MONTHS[m] ?? String(m), true), i + 1, 0, 1, 1));
        this._grid.attach(this.headerCell('Σ Jahr', true), lastCol, 0, 1, 1);

        r.lines.forEach((line, idx) => {
            const row = idx + 1;
            this._grid.attach(this.labelCell(line), 0, row, 1, 1);
            line.perMonth.forEach((v, i) => this._grid.attach(this.valueCell(v, line), i + 1, row, 1, 1));
            this._grid.attach(this.valueCell(line.total, line), lastCol, row, 1, 1);
        });
    }

    private headerCell(text: string, numeric: boolean): Gtk.Label {
        return new Gtk.Label({
            label: text,
            xalign: numeric ? 1 : 0,
            halign: numeric ? Gtk.Align.END : Gtk.Align.START,
            cssClasses: ['heading', 'caption'],
        });
    }

    private labelCell(line: BwaLine): Gtk.Label {
        const emphasised = line.level === 'subtotal' || line.level === 'result';
        return new Gtk.Label({
            label: line.label,
            xalign: 0,
            halign: Gtk.Align.START,
            marginStart: line.level === 'line' ? 12 : 0,
            cssClasses: emphasised ? ['heading'] : line.level === 'margin' ? ['dim-label'] : [],
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
        body.append(new Gtk.Label({ label: `Keine Hinweise für ${this.year}`, xalign: 0 }));
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

    private clearGrid(): void {
        let child = this._grid.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._grid.remove(child);
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
