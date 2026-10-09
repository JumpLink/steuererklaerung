/**
 * Übersicht / Home view — the native counterpart of the web bh-home-view. Renders the shared
 * HomeModel (presenters/home.ts → buildHomeModel): KPI cards (with a profit sparkline), an income-vs-
 * expense bar chart, an expense-by-category breakdown, a liquidity area chart + accounts, and an
 * "Als Nächstes" list. Charts use the native BhChart snapshot widget (same @steuererklaerung/charts
 * geometry as the web SVG). Read-only.
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import Adw from '@girs/adw-1';
import Pango from '@girs/pango-1.0';
import Template from './home-view.blp';

import { loadHome } from '../../../core/presenters/home.ts';
import { loadFreiVerfuegbar } from '../../../core/presenters/frei-verfuegbar.ts';
import { loadCapabilities, loadOutgoingInvoices } from '../../../core/presenters/rechnungen.ts';
import { loadAppSettings } from '../../../core/config/index.ts';
import { appSession } from '../data/session.ts';
import { BhChart } from '../widgets/chart.ts';
import { BhGlossaryHelp } from '../widgets/glossary-help.ts';
import { loadIntoStack, LoadToken } from './util.ts';
import { BhRechnungDetailDialog } from './rechnung-detail-dialog.ts';
import { BhHerleitungDialog } from './herleitung-dialog.ts';
import { errorDialog } from './dialogs.ts';
import { runHinweisHandlung } from './hinweis-handlung.ts';
import { navigateTo } from '../nav.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import type { AppEntity } from '../entities.ts';
import type { HomeModel, HomeTask } from '../../../core/elster/home.ts';
import type { FreiErgebnis, FreiVerfuegbarModel } from '../../../core/elster/frei-verfuegbar.ts';

const ACCENT = '#3584e4';
const EXPENSE = '#c25d52';

/** "Als Nächstes" per-task marker: a symbolic icon tinted by the task tone (mirrors the web
 * `t-<tone>` badge colour + the Auswertungen-Einblicke pattern), so urgent tasks read as amber. */
const TASK_TONE: Record<HomeTask['tone'], { icon: string; css: string }> = {
    warn: { icon: 'dialog-warning-symbolic', css: 'warning' },
    accent: { icon: 'emblem-important-symbolic', css: 'accent' },
    neutral: { icon: 'view-list-symbolic', css: 'dim-label' },
};

export class BhHomeView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _content_box: Gtk.Box;
    private readonly token = new LoadToken();
    private entity: AppEntity | null = null;
    private year = 0;

    static {
        GObject.registerClass(
            { GTypeName: 'BhHomeView', Template, InternalChildren: ['stack', 'error_page', 'content_box'] },
            this,
        );
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Übersicht konnte nicht geladen werden',
            load: () =>
                Promise.all([
                    loadHome(appSession(), entity, year),
                    // Fail-soft: a broken Frei-verfügbar load shows its reason in the cards, not an error page.
                    loadFreiVerfuegbar(appSession(), entity, { year }).catch((err: unknown) =>
                        err instanceof Error ? err : new Error(String(err)),
                    ),
                ]),
            fill: ([m, frei]) => this.fill(m, frei),
        });
    }

    private fill(m: HomeModel, frei: FreiVerfuegbarModel | Error): void {
        let child = this._content_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._content_box.remove(child);
            child = next;
        }
        // Lernmodus is read once per build (the "?" glossar buttons stay hidden when it is off).
        // STEUER_APP_LERNMODUS (dev/testing hook) forces the learn-mode glossary "?" on, for screenshots.
        const lernmodus = !!process.env.STEUER_APP_LERNMODUS || loadAppSettings().lernmodus;
        this._content_box.append(this.kpiRow(m, lernmodus));
        this._content_box.append(this.freiRow(frei, lernmodus));
        if (m.tasks.length) this._content_box.append(this.tasksGroup(m));
        this._content_box.append(this.barsCard(m));
        // Design: Kategorien + Liquidität sit side by side on a wide window, stacking when narrow.
        const split = new Gtk.FlowBox({
            selectionMode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            minChildrenPerLine: 1,
            maxChildrenPerLine: 2,
            columnSpacing: 14,
            rowSpacing: 14,
            activateOnSingleClick: false,
        });
        split.append(this.catsCard(m));
        split.append(this.liqCard(m));
        this._content_box.append(split);
    }

    /** Wrap a content box in an Adwaita `.card` with inner padding. */
    private card(content: Gtk.Box): Gtk.Widget {
        content.set_margin_top(14);
        content.set_margin_bottom(14);
        content.set_margin_start(16);
        content.set_margin_end(16);
        const outer = new Gtk.Box({ cssClasses: ['card'] });
        outer.append(content);
        return outer;
    }

    private heading(text: string): Gtk.Label {
        return new Gtk.Label({ label: text, xalign: 0, cssClasses: ['heading'] });
    }

    private dim(text: string): Gtk.Label {
        return new Gtk.Label({ label: text, xalign: 0, cssClasses: ['dim-label', 'caption'] });
    }

    /** A dim caption label followed by the Lernmodus "?" glossar button (hidden unless Lernmodus is on). */
    private dimWithHelp(text: string, help: { term: string; lernmodus: boolean }): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        const label = this.dim(text);
        label.set_hexpand(true);
        box.append(label);
        box.append(new BhGlossaryHelp(help.term, help.lernmodus));
        return box;
    }

    // ── KPI cards ──
    private kpiRow(m: HomeModel, lernmodus: boolean): Gtk.Widget {
        const fb = new Gtk.FlowBox({
            selectionMode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            minChildrenPerLine: 1,
            maxChildrenPerLine: 4,
            columnSpacing: 12,
            rowSpacing: 12,
            activateOnSingleClick: false,
        });
        const k = m.kpis;
        // Demonstration of the Lernmodus glossar: the Gewinn (and, when shown, the tax) KPI carries a "?".
        fb.append(
            this.kpiCard(`Gewinn ${m.year}`, eur(k.profit), {
                accent: k.profit >= 0 ? 'success' : 'error',
                sub: 'Einnahmen − Ausgaben',
                spark: { values: m.profitSparkline, color: k.profit >= 0 ? '#26a269' : EXPENSE },
                help: { term: 'gewinn', lernmodus },
            }),
        );
        fb.append(this.kpiCard('Einnahmen', eur(k.income), { sub: `netto ${m.year}` }));
        fb.append(this.kpiCard('Ausgaben', eur(k.expense), { sub: `netto ${m.year}` }));
        if (k.tax) {
            fb.append(
                this.kpiCard(`Steuer-Prognose ${m.year}`, eur(Math.abs(k.tax.total)), {
                    accent: k.tax.total >= 0 ? 'error' : 'success',
                    sub: k.tax.label,
                    help: { term: 'ust-zahllast', lernmodus },
                }),
            );
        }
        return fb;
    }

    // ── Frei verfügbar + Steuerrücklage: two activatable cards, each opening its Herleitung ──
    private freiRow(frei: FreiVerfuegbarModel | Error, lernmodus: boolean): Gtk.Widget {
        const fb = new Gtk.FlowBox({
            selectionMode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            minChildrenPerLine: 1,
            maxChildrenPerLine: 2,
            columnSpacing: 12,
            rowSpacing: 12,
            activateOnSingleClick: false,
        });
        if (frei instanceof Error) {
            fb.append(
                this.kpiCard('Frei verfügbar', 'nicht berechenbar', {
                    sub: frei.message,
                    help: { term: 'frei-verfuegbar', lernmodus },
                }),
            );
            return fb;
        }
        const f = frei.freiVerfuegbar;
        fb.append(
            this.freiCard(f, {
                value: f.betrag == null ? 'nicht berechenbar' : eur(f.betrag),
                sub: f.vollstaendig
                    ? `Stand ${deDate(frei.stichtag)} · eine Rechnung, keine Empfehlung`
                    : 'unvollständig — siehe Herleitung',
                help: { term: 'frei-verfuegbar', lernmodus },
            }),
        );
        const r = frei.steuerruecklage;
        fb.append(
            this.freiCard(r, {
                value: r.betrag == null ? 'nicht berechenbar' : eur(Math.abs(r.betrag)),
                accent: r.erstattung ? 'success' : undefined,
                sub: r.erstattung
                    ? 'vsl. Erstattung'
                    : r.vollstaendig
                      ? 'ESt + GewSt − Vorauszahlungen'
                      : 'unvollständig — siehe Herleitung',
                help: { term: 'steuerruecklage', lernmodus },
            }),
        );
        return fb;
    }

    /** A KPI card that is a button: activating it opens the figure's Herleitung. */
    private freiCard(
        e: FreiErgebnis,
        opts: { value: string; sub: string; accent?: 'success'; help: { term: string; lernmodus: boolean } },
    ): Gtk.Widget {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        content.append(this.dimWithHelp(e.label, opts.help));
        content.append(
            new Gtk.Label({
                label: opts.value,
                xalign: 0,
                cssClasses: ['title-2', 'numeric', ...(opts.accent ? [opts.accent] : [])],
            }),
        );
        content.append(this.dim(opts.sub));
        content.set_margin_top(14);
        content.set_margin_bottom(14);
        content.set_margin_start(16);
        content.set_margin_end(16);
        // The tooltip names the action for the pointer and gives the devtools rig a text to find the card by.
        const button = new Gtk.Button({ child: content, cssClasses: ['card'], tooltipText: `Herleitung: ${e.label}` });
        button.connect('clicked', () => new BhHerleitungDialog().openErgebnis(this, e));
        return button;
    }

    private kpiCard(
        label: string,
        value: string,
        opts: {
            accent?: 'success' | 'error';
            sub?: string;
            spark?: { values: number[]; color: string };
            help?: { term: string; lernmodus: boolean };
        },
    ): Gtk.Widget {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        content.append(opts.help ? this.dimWithHelp(label, opts.help) : this.dim(label));
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        const num = new Gtk.Label({
            label: value,
            xalign: 0,
            hexpand: true,
            halign: Gtk.Align.START,
            cssClasses: ['title-2', 'numeric', ...(opts.accent ? [opts.accent] : [])],
        });
        row.append(num);
        if (opts.spark) {
            const chart = new BhChart();
            chart.setData({ type: 'sparkline', values: opts.spark.values, color: opts.spark.color });
            chart.set_size_request(90, 30);
            chart.set_halign(Gtk.Align.END);
            chart.set_valign(Gtk.Align.CENTER);
            row.append(chart);
        }
        content.append(row);
        if (opts.sub) content.append(this.dim(opts.sub));
        return this.card(content);
    }

    // ── "Als Nächstes" ──
    private tasksGroup(m: HomeModel): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Als Nächstes' });
        for (const t of m.tasks) {
            const row = new Adw.ActionRow({ title: t.title, subtitle: t.sub });
            // Leading marker tinted by the task tone (warn = amber) — same signal as the web badge.
            const meta = TASK_TONE[t.tone] ?? TASK_TONE.neutral;
            row.add_prefix(new Gtk.Image({ iconName: meta.icon, cssClasses: [meta.css], valign: Gtk.Align.CENTER }));
            if (t.kind === 'doppelzahlung' && t.ref) {
                const invoiceId = t.ref;
                row.set_activatable(true);
                row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                row.connect('activated', () => void this.openInvoice(invoiceId));
            } else if (t.kind === 'zu-pruefen' || t.kind === 'erstattungen') {
                // The open Erstattungen sit in the „Zu prüfen" queue with their Ja/Nein.
                row.set_activatable(true);
                row.set_tooltip_text('Zu prüfen öffnen');
                row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                row.connect('activated', () => navigateTo(this, 'transactions', 'zu-pruefen'));
            } else if (t.kind === 'forderungen') {
                row.set_activatable(true);
                row.set_tooltip_text('Offene Forderungen öffnen');
                row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                row.connect('activated', () => navigateTo(this, 'rechnungen', 'forderungen'));
            } else if (t.kind === 'laufende-kosten') {
                row.set_activatable(true);
                row.set_tooltip_text('Laufende Kosten öffnen');
                row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                row.connect('activated', () => navigateTo(this, 'transactions', 'laufende-kosten'));
            } else if (t.kind === 'hinweis' && t.ref && t.handlung && this.entity) {
                const entity = this.entity;
                const year = this.year;
                const { ref, handlung } = t;
                row.set_activatable(true);
                row.set_tooltip_text(handlung.label);
                row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                row.connect('activated', () =>
                    runHinweisHandlung(
                        this,
                        { entity, year, onChanged: () => this.reload(entity, year) },
                        ref,
                        handlung,
                    ),
                );
            }
            group.add(row);
        }
        return group;
    }

    /** Open the detail dialog of the invoice a "Als Nächstes" task refers to; reload the view after a decision. */
    private async openInvoice(invoiceId: string): Promise<void> {
        const entity = this.entity;
        if (!entity) return;
        try {
            const invoice = (await loadOutgoingInvoices(entity.id)).find((i) => i.id === invoiceId);
            if (!invoice) throw new Error('Die Rechnung wurde nicht gefunden.');
            const dialog = new BhRechnungDetailDialog();
            dialog.onChanged = () => this.reload(entity, this.year);
            dialog.open(this, entity, invoice, loadCapabilities(entity.id));
        } catch (err) {
            await errorDialog(this, 'Rechnung nicht ladbar', err instanceof Error ? err.message : String(err));
        }
    }

    /** A "● Label" legend entry with the swatch tinted via Pango markup. */
    private legendItem(label: string, color: string): Gtk.Label {
        return new Gtk.Label({
            useMarkup: true,
            label: `<span foreground="${color}">●</span> ${label}`,
            cssClasses: ['caption', 'dim-label'],
        });
    }

    // ── income vs expense bar chart ──
    private barsCard(m: HomeModel): Gtk.Widget {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
        const heading = this.heading('Einnahmen und Ausgaben');
        heading.set_hexpand(true);
        head.append(heading);
        const legend = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14, valign: Gtk.Align.CENTER });
        legend.append(this.legendItem('Einnahmen', ACCENT));
        legend.append(this.legendItem('Ausgaben', EXPENSE));
        head.append(legend);
        content.append(head);
        const chart = new BhChart();
        chart.setData({
            type: 'bars',
            labels: m.monthly.labels,
            series: [
                { values: m.monthly.income, color: ACCENT },
                { values: m.monthly.expense, color: EXPENSE },
            ],
        });
        content.append(chart);
        return this.card(content);
    }

    // ── expense by category ──
    private catsCard(m: HomeModel): Gtk.Widget {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        content.append(this.heading('Ausgaben nach Kategorie'));
        const max = m.categories[0]?.amount || 1;
        for (const c of m.categories) {
            const rowBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
            const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            head.append(new Gtk.Label({ label: c.name, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
            head.append(new Gtk.Label({ label: eur(c.amount), cssClasses: ['numeric', 'dim-label'] }));
            rowBox.append(head);
            rowBox.append(new Gtk.LevelBar({ minValue: 0, maxValue: 1, value: c.amount / max }));
            content.append(rowBox);
        }
        if (!m.categories.length) content.append(this.dim('Keine Ausgaben erfasst'));
        return this.card(content);
    }

    // ── liquidity area + accounts ──
    private liqCard(m: HomeModel): Gtk.Widget {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        head.append(new Gtk.Label({ label: 'Liquidität', xalign: 0, hexpand: true, cssClasses: ['heading'] }));
        head.append(new Gtk.Label({ label: eur(m.liquidity.now), cssClasses: ['numeric', 'heading'] }));
        content.append(head);
        const chart = new BhChart();
        chart.setData({ type: 'area', values: m.liquidity.series, color: ACCENT });
        content.append(chart);
        for (const a of m.liquidity.accounts) {
            const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
            row.append(new Adw.Avatar({ size: 22, text: a.name, showInitials: true, valign: Gtk.Align.CENTER }));
            row.append(new Gtk.Label({ label: a.name, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
            row.append(new Gtk.Label({ label: eur(a.balance), cssClasses: ['numeric'] }));
            content.append(row);
        }
        return this.card(content);
    }
}
