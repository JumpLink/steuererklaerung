/**
 * <BhSteuerView> — the Steuer/EÜR view.
 *
 * Mirrors the EÜR card of the web "Steuer" view (bh-tax-view): the four headline figures
 * (Betriebseinnahmen · Betriebsausgaben · Gewinn · USt-Zahllast), an "unclassified" banner, the
 * per-category Einnahmen/Ausgaben breakdown, and the Anlage-EÜR Kennzahlen (in an expander).
 *
 * The EÜR is computed by the same action the web server calls (see presenters/steuer.ts). That call is
 * async and fetches Paperless docs, so this view loads with a spinner (via loadIntoStack) and drops
 * a stale result if the entity/year changes mid-fetch. Only entities with an ELSTER config reach
 * this view (the nav filters it out otherwise).
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './steuer-view.blp';
import {
    loadEuer,
    loadEuerPdf,
    loadUste,
    loadGewst,
    loadFeststellung,
    loadUstePdf,
    loadGewstPdf,
    loadFeststellungPdf,
    type EuerData,
} from '../../../core/presenters/steuer.ts';
import { appSession } from '../data/session.ts';
import type { EuerCategoryTotal } from '../../../core/elster/euer-aggregate.ts';
import type { EuerTotalId, FigureKind, FigureRef } from '../../../core/actions/elster/explain.ts';
import type { UsteAggregate } from '../../../core/elster/uste-aggregate.ts';
import type { GewstReport } from '../../../core/actions/elster/gewst.ts';
import type { FeststellungReport } from '../../../core/actions/elster/feststellung.ts';
import type { AppEntity } from '../entities.ts';
import { eur, pct } from '../../../core/lib/format.ts';

/** The four tax reports the Steuer view shows; the last three are null when they don't apply. */
interface SteuerViewData {
    euer: EuerData;
    uste: UsteAggregate | null;
    gewst: GewstReport | null;
    fest: FeststellungReport | null;
}

/** One report → its PDF loader + save-toast label (for the shared exportPdf). */
type PdfLoader = (entity: AppEntity, year: number) => Promise<{ filename: string; bytes: Uint8Array }>;
import { GroupRows, LoadToken, amountLabel, loadIntoStack, markup, saveFileViaDialog } from './util.ts';
import { errorDialog } from './dialogs.ts';
import { BhHerleitungDialog } from './herleitung-dialog.ts';

export class BhSteuerView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _unclassified_banner: Adw.Banner;
    declare private _summary_group: Adw.PreferencesGroup;
    declare private _income_group: Adw.PreferencesGroup;
    declare private _expense_group: Adw.PreferencesGroup;
    declare private _kennzahlen_group: Adw.PreferencesGroup;
    declare private _uste_group: Adw.PreferencesGroup;
    declare private _gewst_group: Adw.PreferencesGroup;
    declare private _fest_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhSteuerView',
                Template,
                InternalChildren: [
                    'stack',
                    'error_page',
                    'unclassified_banner',
                    'summary_group',
                    'income_group',
                    'expense_group',
                    'kennzahlen_group',
                    'uste_group',
                    'gewst_group',
                    'fest_group',
                ],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly summary: GroupRows;
    private readonly income: GroupRows;
    private readonly expense: GroupRows;
    private readonly kennzahlen: GroupRows;
    private readonly uste: GroupRows;
    private readonly gewst: GroupRows;
    private readonly fest: GroupRows;
    private readonly pdfButton: Gtk.Button;
    private readonly ustePdfButton: Gtk.Button;
    private readonly gewstPdfButton: Gtk.Button;
    private readonly festPdfButton: Gtk.Button;
    private currentEntity: AppEntity | null = null;
    private currentYear = 0;

    constructor() {
        super();
        this.summary = new GroupRows(this._summary_group);
        this.income = new GroupRows(this._income_group);
        this.expense = new GroupRows(this._expense_group);
        this.kennzahlen = new GroupRows(this._kennzahlen_group);
        this.uste = new GroupRows(this._uste_group);
        this.gewst = new GroupRows(this._gewst_group);
        this.fest = new GroupRows(this._fest_group);

        // A "Prüf-Datenblatt als PDF" save button in each report group's header — renders the same
        // datasheet the CLI (`--pdf`) and web (`/api/<kind>/pdf`) produce, then Save-As. Disabled
        // until the report has loaded.
        this.pdfButton = this.makePdfButton(this._summary_group, () =>
            this.exportPdf((e, y) => loadEuerPdf(appSession(), e, y), 'EÜR-Prüfblatt'),
        );
        this.ustePdfButton = this.makePdfButton(this._uste_group, () =>
            this.exportPdf((e, y) => loadUstePdf(appSession(), e, y), 'USt-Prüfblatt'),
        );
        this.gewstPdfButton = this.makePdfButton(this._gewst_group, () =>
            this.exportPdf((e, y) => loadGewstPdf(appSession(), e, y), 'GewSt-Prüfblatt'),
        );
        this.festPdfButton = this.makePdfButton(this._fest_group, () =>
            this.exportPdf((e, y) => loadFeststellungPdf(appSession(), e, y), 'Feststellungs-Prüfblatt'),
        );
    }

    /** Create a disabled flat save button, wire its click, and set it as a group's header suffix. */
    private makePdfButton(group: Adw.PreferencesGroup, onClick: () => void): Gtk.Button {
        const btn = new Gtk.Button({
            iconName: 'document-save-symbolic',
            tooltipText: 'Prüf-Datenblatt als PDF speichern',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: false,
        });
        btn.connect('clicked', onClick);
        group.set_header_suffix(btn);
        return btn;
    }

    reload(entity: AppEntity, year: number): void {
        this.currentEntity = entity;
        this.currentYear = year;
        for (const b of [this.pdfButton, this.ustePdfButton, this.gewstPdfButton, this.festPdfButton]) {
            b.set_sensitive(false);
        }
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'EÜR konnte nicht berechnet werden',
            // The EÜR is required; the annual USt/GewSt/Feststellung derive from the SAME cached
            // aggregate (one Paperless fetch) and are optional — an Einzelunternehmer has no
            // Feststellung, a services entity may lack a Gewerbe block, so those resolve to null.
            load: async (): Promise<SteuerViewData> => {
                const session = appSession();
                const euer = await loadEuer(session, entity, year);
                const [uste, gewst, fest] = await Promise.all([
                    loadUste(session, entity, year).catch(() => null),
                    loadGewst(session, entity, year).catch(() => null),
                    loadFeststellung(session, entity, year).catch(() => null),
                ]);
                return { euer, uste, gewst, fest };
            },
            fill: (data) => this.fill(data, year),
        });
    }

    private fill(data: SteuerViewData, year: number): void {
        const { euer, uste, gewst, fest } = data;
        this.pdfButton.set_sensitive(true);
        const t = euer.aggregate.totals;
        this.fillSummary(t, year);
        this.fillBanner(euer.aggregate.coverage.unclassified.length);
        this.fillCategories(this.income, euer.aggregate.income, t.incomeNet, 'Summe Einnahmen (netto)', 'income', year);
        this.fillCategories(
            this.expense,
            euer.aggregate.expenses,
            t.expenseNet,
            'Summe Ausgaben (netto)',
            'expense',
            year,
        );
        this.fillKennzahlen(euer.kennzahlen);
        this.fillUste(uste);
        this.fillGewst(gewst);
        this.fillFeststellung(fest);
        if (process.env.STEUER_APP_DEBUG) {
            const a = euer.aggregate;
            console.error(
                `[app] Steuer ${year} ok: EÜR ${a.income.length}+${a.expenses.length} Kat, ` +
                    `USt-Jahr ${uste ? '✓' : '–'}, GewSt ${gewst ? '✓' : '–'}, Feststellung ${fest ? '✓' : '–'}, ` +
                    `${a.coverage.unclassified.length} unklassifiziert`,
            );
        }
    }

    private fillSummary(t: EuerData['aggregate']['totals'], year: number): void {
        this.summary.clear();
        this._summary_group.set_title(`Anlage EÜR ${year}`);
        this._summary_group.set_description('Gewinnermittlung nach §4 Abs. 3 EStG');

        // Each headline figure drills into its Herleitung (S1): a total ref → child terms + bookings.
        const add = (title: string, label: Gtk.Label, id: EuerTotalId) => {
            const row = new Adw.ActionRow({ title });
            row.add_suffix(label);
            this.makeDrillable(row, { domain: 'euer', year, kind: 'total', id });
            this.summary.add(row);
        };
        add('Betriebseinnahmen (netto)', amountLabel(eur(t.incomeNet)), 'betriebseinnahmen');
        add('Betriebsausgaben (netto)', amountLabel(eur(t.expenseNet)), 'betriebsausgaben');
        add(
            'Gewinn',
            amountLabel(eur(t.profit), { accent: t.profit >= 0 ? 'success' : 'error', heading: true }),
            'gewinn',
        );
        add('USt-Zahllast', amountLabel(eur(t.vatPayable)), 'ust-zahllast');
    }

    /** Make a figure row activatable: a "go-next" chevron + open its Herleitung drill-down on click. */
    private makeDrillable(row: Adw.ActionRow, ref: FigureRef): void {
        row.set_activatable(true);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.openHerleitung(ref));
    }

    /** Present the Herleitung overlay for one figure, scoped to the current entity/year. */
    private openHerleitung(ref: FigureRef): void {
        const entity = this.currentEntity;
        if (!entity) return;
        new BhHerleitungDialog().open(this, entity, this.currentYear, ref);
    }

    private fillBanner(unclassified: number): void {
        if (unclassified > 0) {
            this._unclassified_banner.set_title(
                `${unclassified} Buchung${unclassified === 1 ? '' : 'en'} unklassifiziert — bitte prüfen`,
            );
            this._unclassified_banner.set_revealed(true);
        } else {
            this._unclassified_banner.set_revealed(false);
        }
    }

    private fillCategories(
        rows: GroupRows,
        cats: EuerCategoryTotal[],
        sumNet: number,
        sumLabel: string,
        kind: FigureKind,
        year: number,
    ): void {
        rows.clear();
        for (const cat of cats) {
            const row = rows.add(
                new Adw.ActionRow({
                    title: markup(cat.bucket || cat.category),
                    subtitle: markup(`${cat.category} · ${cat.count} Buchung${cat.count === 1 ? '' : 'en'}`),
                }),
            );
            row.add_suffix(amountLabel(eur(cat.net)));
            // Drill into the category's bookings. The full category label is an exact-match id for the
            // resolver, so each row resolves to precisely its own line (see resolveEuerFigure).
            this.makeDrillable(row, { domain: 'euer', year, kind, id: cat.category });
        }
        const sum = rows.add(new Adw.ActionRow({ title: sumLabel }));
        sum.add_suffix(amountLabel(eur(sumNet), { heading: true }));
    }

    private fillKennzahlen(kennzahlen: EuerData['kennzahlen']): void {
        this.kennzahlen.clear();
        this._kennzahlen_group.set_title('Kennzahlen');

        const expander = this.kennzahlen.add(
            new Adw.ExpanderRow({
                title: 'Anlage-EÜR Kennzahlen',
                subtitle: 'best-effort — vor Abgabe gegen die Anlage-EÜR prüfen',
            }),
        );
        for (const k of kennzahlen) {
            const row = new Adw.ActionRow({ title: markup(`Kz ${k.kz} · ${k.label}`) });
            row.add_suffix(amountLabel(eur(k.amount)));
            expander.add_row(row);
        }
    }

    private fillUste(u: UsteAggregate | null): void {
        this.uste.clear();
        this._uste_group.set_visible(u != null);
        if (!u) return;
        this._uste_group.set_title(`USt-Jahreserklärung ${u.year}`);
        this.ustePdfButton.set_sensitive(true);
        const add = (title: string, label: Gtk.Label) => this.uste.add(new Adw.ActionRow({ title })).add_suffix(label);
        add('USt-Zahllast (Jahr)', amountLabel(eur(u.vatPayable)));
        add('− angemeldete Vorauszahlungen', amountLabel(eur(u.prepaidVat)));
        add(
            u.closingBalance >= 0 ? 'Abschlusszahlung' : 'Erstattung',
            // A refund (negative balance) reads green — same accent semantics as the USt-VA Zahllast.
            amountLabel(eur(Math.abs(u.closingBalance)), {
                heading: true,
                accent: u.closingBalance < 0 ? 'success' : undefined,
            }),
        );
        if (u.reverseCharge && u.reverseCharge.count > 0) {
            add(
                '§13b geschuldete USt (zahllastneutral)',
                amountLabel(eur(u.reverseCharge.abs1Tax + u.reverseCharge.abs2Tax)),
            );
        }
    }

    private fillGewst(r: GewstReport | null): void {
        this.gewst.clear();
        this._gewst_group.set_visible(r != null);
        if (!r) return;
        this._gewst_group.set_title('Gewerbesteuer (GewSt 1 A)');
        this.gewstPdfButton.set_sensitive(true);
        const g = r.result;
        const add = (title: string, label: Gtk.Label) => this.gewst.add(new Adw.ActionRow({ title })).add_suffix(label);
        add('Gewerbeertrag (abgerundet)', amountLabel(eur(g.gewerbeertragRounded)));
        add('Steuermessbetrag', amountLabel(eur(g.messbetrag), { heading: true }));
        if (g.messbetrag === 0) {
            // A Messbetrag of 0 € is the expected, positive case (below the Freibetrag) — render it as
            // an ok-status note with a proper title/subtitle rather than a glyph-prefixed dim string.
            const note = new Adw.ActionRow({
                title: 'Unter dem Freibetrag',
                subtitle: 'Messbetrag 0 € — die Erklärung wird dennoch abgegeben',
            });
            note.add_prefix(
                new Gtk.Image({ iconName: 'emblem-ok-symbolic', cssClasses: ['success'], valign: Gtk.Align.CENTER }),
            );
            this.gewst.add(note);
        }
    }

    private fillFeststellung(r: FeststellungReport | null): void {
        this.fest.clear();
        this._fest_group.set_visible(r != null);
        if (!r) return;
        this._fest_group.set_title('Feststellung (GbR)');
        this.festPdfButton.set_sensitive(true);
        const f = r.result;
        this.fest
            .add(new Adw.ActionRow({ title: 'Einkünfte aus Gewerbebetrieb' }))
            .add_suffix(amountLabel(eur(f.einkuenfteGesamt), { heading: true }));
        for (const a of f.allocations) {
            const row = new Adw.ActionRow({
                title: markup(a.gesellschafter.name),
                subtitle: markup(`${pct(a.gesellschafter.quote)} · IdNr ${a.gesellschafter.steuerId}`),
            });
            row.add_suffix(amountLabel(eur(a.gesamtAnteil)));
            this.fest.add(row);
        }
    }

    /** Render a report's Prüf-Datenblatt to PDF and Save-As (shared helper, also used by the wizard). */
    private async exportPdf(loader: PdfLoader, toastLabel: string): Promise<void> {
        const entity = this.currentEntity;
        if (!entity) return;
        try {
            const { filename, bytes } = await loader(entity, this.currentYear);
            saveFileViaDialog(this, filename, bytes, toastLabel);
        } catch (err) {
            await errorDialog(this, 'PDF nicht verfügbar', err instanceof Error ? err.message : String(err));
        }
    }
}
