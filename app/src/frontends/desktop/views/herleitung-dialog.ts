/**
 * <BhHerleitungDialog> — the "Herleitung" (derivation) drill-down for a single tax figure
 * (roadmap S1, the keystone verification primitive). Given a {@link FigureRef} it presents:
 *
 *   - a header with the figure's label, value and human formula,
 *   - for a composite total (Gewinn / USt-Zahllast / Betriebseinnahmen/-ausgaben) its child terms,
 *     each PUSHABLE to drill one level deeper, and
 *   - the list of contributing bookings, each carrying a provenance chip (via Beleg / via Regel /
 *     manuell / unklassifiziert) so the number's trust is visible at a glance.
 *
 * DESIGN — an `Adw.Dialog` hosting an `Adw.NavigationView` (not a NavigationPage pushed onto the
 * window's split view): a self-contained overlay that owns its own back-stack, so drilling
 * Gewinn → Betriebsausgaben → a category pushes deeper pages WITHOUT disturbing the app's content
 * stack or nav rail. Each figure is one `Adw.NavigationPage`; tapping a drillable child term pushes
 * a fresh page for that ref. This mirrors the invoice detail dialog's self-contained overlay idiom.
 *
 * Numbers are rendered straight from the core resolver ({@link loadFigureExplanation}) — no
 * recomputation here. A booking row is ACTIVATABLE: tapping it pushes the S2 "Buchungs-Detail" leaf
 * ({@link buildLeafPage}) onto this same NavigationView, an evidence-and-edit surface where the owner
 * can inspect the linked Beleg + KI-Hinweis and CORRECT the booking's classification. Every decision
 * is written through the shared core action ({@link saveDecision}); the write drops the entity's EÜR
 * aggregate cache, so on `back` the Herleitung reloads with the moved figure.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './herleitung-dialog.blp';

import { loadFigureExplanation } from '../../../core/presenters/steuer.ts';
import { appSession } from '../data/session.ts';
import {
    loadDecision,
    loadDecisionLog,
    loadDocMeta,
    loadEuerCategories,
    removeDecision,
    saveDecision,
    type ClassificationDecisionInput,
    type ClassificationRecord,
    type DecisionLogEntry,
    type DocMeta,
} from '../data/decisions.ts';
import type {
    FigureChild,
    FigureExplanation,
    FigureProvenance,
    FigureProvenanceSource,
    FigureRef,
    FigureRow,
} from '../../../core/actions/elster/explain.ts';
import type { FreiErgebnis, FreiTerm } from '../../../core/elster/frei-verfuegbar.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, deDateTime, eur } from '../../../core/lib/format.ts';
import { errorDialog } from './dialogs.ts';
import { herkunftText, istAufteilung, istErstattung, wasGiltDanach } from '../../../core/elster/zu-pruefen.ts';
import { aufteilungAufheben } from './aufteilen-dialog.ts';
import { loeseErstattung } from '../../../core/presenters/erstattungen.ts';
import { showToast } from '../toast.ts';
import { LoadToken, amountLabel, currentOperator, loadIntoStack, markup } from './util.ts';

/** Everything the leaf needs, loaded in one pass (categories + persisted decision/log + Beleg meta). */
interface LeafData {
    categories: string[];
    decision: ClassificationRecord | null;
    log: DecisionLogEntry[];
    docMeta: DocMeta | null;
}

/** Provenance source → chip label + style class (the app's caption-badge idiom, see rechnungen-view). */
const PROVENANCE_META: Record<FigureProvenanceSource, { label: string; css: string }> = {
    document: { label: 'via Beleg', css: 'success' },
    rule: { label: 'via Regel', css: 'accent' },
    manual: { label: 'manuell', css: 'dim-label' },
    unclassified: { label: 'unklassifiziert', css: 'warning' },
};

/** A small colored caption chip for a booking's provenance; the rule text becomes its tooltip. */
function provenanceChip(prov: FigureProvenance): Gtk.Label {
    const meta = PROVENANCE_META[prov.source];
    const chip = new Gtk.Label({ label: meta.label, cssClasses: ['caption', meta.css], valign: Gtk.Align.CENTER });
    if (prov.source === 'rule' && (prov.matchedRule || prov.rule)) {
        chip.set_tooltip_text(prov.matchedRule ? herkunftText(prov) : (prov.rule ?? null));
    }
    return chip;
}

/** One-line trust summary over the provenance mix, e.g. "12 via Beleg · 18 via Regel". */
function provenanceSummary(mix: FigureExplanation['provenanceMix']): string {
    const parts: string[] = [];
    if (mix.document) parts.push(`${mix.document} via Beleg`);
    if (mix.rule) parts.push(`${mix.rule} via Regel`);
    if (mix.manual) parts.push(`${mix.manual} manuell`);
    if (mix.unclassified) parts.push(`${mix.unclassified} unklassifiziert`);
    return parts.length ? parts.join(' · ') : 'keine Buchungen';
}

/** One NavigationPage of the dialog: header bar + loading/error stack; "content" is added once loaded. */
class BhHerleitungPage extends Adw.NavigationPage {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _loading_label: Gtk.Label;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhHerleitungPage',
                Template,
                InternalChildren: ['stack', 'error_page', 'loading_label'],
            },
            this,
        );
    }

    constructor(title: string, loadingText: string) {
        super();
        this.set_title(title);
        this._loading_label.set_label(loadingText);
    }

    get stack(): Gtk.Stack {
        return this._stack;
    }

    get errorPage(): Adw.StatusPage {
        return this._error_page;
    }
}

export class BhHerleitungDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly navView = new Adw.NavigationView();
    private entity!: AppEntity;
    private year = 0;
    /** Per Herleitung page: rebuild its content from the (now cache-cleared) aggregate after a decision. */
    private readonly reloaders = new Map<Adw.NavigationPage, () => void>();

    constructor() {
        this.dialog.set_title('Herleitung');
        this.dialog.set_content_width(720);
        this.dialog.set_content_height(760);
        this.dialog.set_child(this.navView);
    }

    /** Present the dialog on a parent view and drill into `ref` as the root page. */
    open(parent: Gtk.Widget, entity: AppEntity, year: number, ref: FigureRef | string): void {
        this.entity = entity;
        this.year = year;
        this.navView.push(this.buildPage(ref));
        this.dialog.present(parent);
    }

    /**
     * Present an already-computed combined figure (Frei verfügbar / Steuerrücklage): the result with
     * its formula, then every term — each pushable to its own derivation lines. Nothing is loaded or
     * recomputed here; the figure comes complete from core/elster/frei-verfuegbar.ts.
     */
    openErgebnis(parent: Gtk.Widget, ergebnis: FreiErgebnis): void {
        this.dialog.set_title(ergebnis.label);
        this.navView.push(this.staticPage(ergebnis.label, this.ergebnisContent(ergebnis)));
        this.dialog.present(parent);
    }

    /** A Herleitung page whose content is ready — the loading/error stack goes straight to it. */
    private staticPage(title: string, content: Gtk.Widget): Adw.NavigationPage {
        const page = new BhHerleitungPage(title, '');
        page.stack.add_named(content, 'content');
        page.stack.set_visible_child_name('content');
        return page;
    }

    private scrolled(box: Gtk.Box): Gtk.Widget {
        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        return new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    }

    private ergebnisContent(e: FreiErgebnis): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        const summary = new Adw.PreferencesGroup({ description: markup(e.hinweis) });
        const head = new Adw.ActionRow({ title: markup(e.label), subtitle: markup(`= ${e.formel}`) });
        head.add_suffix(
            e.betrag == null
                ? new Gtk.Label({ label: 'nicht berechenbar', cssClasses: ['warning'], valign: Gtk.Align.CENTER })
                : amountLabel(eur(e.betrag), { heading: true }),
        );
        summary.add(head);
        if (!e.vollstaendig) {
            summary.add(
                new Adw.ActionRow({
                    title: 'Unvollständig',
                    subtitle: markup(
                        'Mindestens ein Posten ist nicht berechenbar — er ist nicht enthalten, siehe unten.',
                    ),
                    cssClasses: ['warning'],
                }),
            );
        }
        box.append(summary);

        const comp = new Adw.PreferencesGroup({ title: 'Zusammensetzung' });
        for (const t of e.terme) comp.add(this.termRow(t));
        box.append(comp);
        return this.scrolled(box);
    }

    /** One term: `± label   amount` with its explanation; tappable to its derivation lines. */
    private termRow(t: FreiTerm): Adw.ActionRow {
        const counted = t.status === 'ok' || t.status === 'teilweise';
        const row = new Adw.ActionRow({ title: markup(t.label), subtitle: markup(t.erklaerung) });
        row.add_prefix(
            new Gtk.Label({
                label: t.op === '-' ? '−' : '+',
                cssClasses: ['dim-label', 'numeric'],
                valign: Gtk.Align.CENTER,
            }),
        );
        if (counted) row.add_suffix(amountLabel(eur(t.betrag)));
        else
            row.add_suffix(
                new Gtk.Label({
                    label: t.status === 'entfaellt' ? 'entfällt' : 'nicht berechenbar',
                    cssClasses: ['caption', t.status === 'entfaellt' ? 'dim-label' : 'warning'],
                    valign: Gtk.Align.CENTER,
                }),
            );
        if (t.zeilen.length) {
            row.set_activatable(true);
            row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
            row.connect('activated', () => this.navView.push(this.staticPage(t.label, this.termContent(t))));
        }
        return row;
    }

    private termContent(t: FreiTerm): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        const head = new Adw.PreferencesGroup();
        head.add(this.termRow({ ...t, zeilen: [] }));
        box.append(head);
        const lines = new Adw.PreferencesGroup({ title: 'Herleitung' });
        for (const z of t.zeilen) {
            const row = new Adw.ActionRow({ title: markup(z.label), subtitle: z.herkunft ? markup(z.herkunft) : '' });
            row.set_title_lines(0);
            if (z.betrag != null) row.add_suffix(amountLabel(eur(z.betrag)));
            lines.add(row);
        }
        box.append(lines);
        return this.scrolled(box);
    }

    /** Push a deeper Herleitung page (a drillable child term of a composite figure). */
    private pushRef(ref: FigureRef | string): void {
        this.navView.push(this.buildPage(ref));
    }

    /**
     * Build a NavigationPage that loads its figure asynchronously (spinner → content/error via the
     * shared loadIntoStack). The HeaderBar shows the page title (and, for non-root pages, a back
     * button) automatically inside the NavigationView.
     */
    private buildPage(ref: FigureRef | string): Adw.NavigationPage {
        const page = new BhHerleitungPage('Herleitung', 'Berechne Herleitung …');
        const { stack, errorPage } = page;
        const token = new LoadToken();

        // A reloadable load: re-run after a leaf decision (cache cleared) so the figure recomputes.
        const reload = () =>
            loadIntoStack({
                stack,
                errorPage,
                token,
                errorContext: 'Herleitung konnte nicht berechnet werden',
                load: () => loadFigureExplanation(appSession(), this.entity, this.year, ref),
                fill: (ex) => {
                    page.set_title(ex.label);
                    const content = this.buildContent(ex, page);
                    const existing = stack.get_child_by_name('content');
                    if (existing) stack.remove(existing);
                    stack.add_named(content, 'content');
                },
            });
        this.reloaders.set(page, reload);
        reload();
        return page;
    }

    /** The scrollable content for one resolved figure: header · Zusammensetzung · Buchungen. */
    private buildContent(ex: FigureExplanation, page: Adw.NavigationPage): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });

        // Header — label + formula (dim subtitle) + the value (right, tabular; green iff positive Gewinn).
        const summary = new Adw.PreferencesGroup();
        const isGewinn = ex.ref.kind === 'total' && ex.ref.id === 'gewinn';
        const accent = isGewinn ? (ex.value >= 0 ? 'success' : 'error') : undefined;
        const headRow = new Adw.ActionRow({ title: markup(ex.label), subtitle: markup(ex.formula) });
        headRow.add_suffix(amountLabel(eur(ex.value), { heading: true, accent }));
        summary.add(headRow);
        box.append(summary);

        // Zusammensetzung — the child terms of a composite total (drillable when they carry a ref).
        if (ex.children.length > 0) {
            const comp = new Adw.PreferencesGroup({ title: 'Zusammensetzung' });
            for (const child of ex.children) comp.add(this.childRow(child));
            box.append(comp);
        }

        // Buchungen — the contributing transactions, with a provenance chip each.
        const bookings = new Adw.PreferencesGroup({
            title: 'Buchungen',
            description: provenanceSummary(ex.provenanceMix),
        });
        if (ex.contributors.length === 0) {
            bookings.add(new Adw.ActionRow({ title: 'Keine Buchungen', cssClasses: ['dim-label'] }));
        } else {
            for (const row of ex.contributors) bookings.add(this.contributorRow(row, page));
        }
        box.append(bookings);

        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        return new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    }

    /** A child term row: `± label   value`, tappable to push its own Herleitung when it has a ref. */
    private childRow(child: FigureChild): Adw.ActionRow {
        const op = child.op === '-' ? '−' : '+';
        const row = new Adw.ActionRow({ title: markup(child.label) });
        row.add_prefix(new Gtk.Label({ label: op, cssClasses: ['dim-label', 'numeric'], valign: Gtk.Align.CENTER }));
        row.add_suffix(amountLabel(eur(child.value)));
        const ref = child.ref;
        if (ref) {
            row.set_activatable(true);
            row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
            row.connect('activated', () => this.pushRef(ref));
        }
        return row;
    }

    /**
     * One contributing booking: counterparty · date/purpose/category · provenance chip · net amount.
     * ACTIVATABLE — tapping it drills into the S2 "Buchungs-Detail" leaf (evidence + reclassify).
     */
    private contributorRow(r: FigureRow, page: Adw.NavigationPage): Adw.ActionRow {
        const subParts = [
            deDate(r.date),
            r.purpose ?? undefined,
            r.category,
            r.provenance.source === 'rule' && r.provenance.matchedRule
                ? herkunftText(r.provenance)
                : r.provenance.source === 'rule' && r.provenance.rule
                  ? `Regel: ${r.provenance.rule}`
                  : undefined,
            r.provenance.documentId != null ? `Beleg #${r.provenance.documentId}` : undefined,
            r.provenance.aufteilung
                ? `Teil ${r.provenance.aufteilung.teilNr} von ${r.provenance.aufteilung.teile.length}`
                : undefined,
        ].filter((p): p is string => Boolean(p));
        const row = new Adw.ActionRow({
            title: markup(r.counterparty || '—'),
            subtitle: markup(subParts.join(' · ')),
        });
        row.add_suffix(provenanceChip(r.provenance));
        row.add_suffix(amountLabel(eur(r.net)));
        row.set_activatable(true);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.navView.push(this.buildLeafPage(r, page)));
        if (!r.included) row.add_css_class('dim-label');
        return row;
    }

    // ── S2 — Buchungs-Detail leaf ────────────────────────────────────────────────────────────────

    /**
     * The "Buchungs-Detail" leaf for one booking: a NavigationPage that loads its evidence (categories,
     * persisted decision + log, linked Beleg meta) async, then renders the Buchung · Beleg · Umbuchen ·
     * Begründung · Entscheidungs-Log surface. Pushed onto the dialog's NavigationView so `back` returns
     * to the (reloaded) Herleitung — `spawningPage` is the page to reload after a decision write.
     */
    private buildLeafPage(r: FigureRow, spawningPage: Adw.NavigationPage): Adw.NavigationPage {
        const page = new BhHerleitungPage('Buchungs-Detail', 'Lade Buchung …');
        const { stack, errorPage } = page;
        const token = new LoadToken();

        loadIntoStack({
            stack,
            errorPage,
            token,
            errorContext: 'Buchungs-Detail konnte nicht geladen werden',
            load: () => this.loadLeaf(r),
            fill: (data) => {
                const content = this.buildLeafContent(r, data, spawningPage);
                const existing = stack.get_child_by_name('content');
                if (existing) stack.remove(existing);
                stack.add_named(content, 'content');
            },
        });
        return page;
    }

    /** Load everything the leaf renders in one pass (categories + decision/log + Beleg meta). */
    private async loadLeaf(r: FigureRow): Promise<LeafData> {
        const documentId = r.provenance.documentId ?? null;
        const [categories, docMeta] = await Promise.all([
            loadEuerCategories(this.entity, this.year),
            documentId != null ? loadDocMeta(this.entity, documentId) : Promise.resolve(null),
        ]);
        return {
            categories,
            docMeta,
            decision: loadDecision(this.entity, r.transactionId),
            log: loadDecisionLog(this.entity, r.transactionId),
        };
    }

    /** The scrollable leaf content: Buchung · Beleg · Umbuchen · Begründung · Entscheidungs-Log. */
    private buildLeafContent(r: FigureRow, data: LeafData, spawningPage: Adw.NavigationPage): Gtk.Widget {
        // `filling` guards the programmatic ComboRow/EntryRow fills so they don't trigger a write.
        let filling = true;

        /** Persist a decision, toast, and pop back to the (now recomputed) Herleitung. Never crashes. */
        const commit = (input: ClassificationDecisionInput): void => {
            try {
                saveDecision(this.entity, input);
                showToast('Buchung aktualisiert');
                this.navView.pop();
                this.reloaders.get(spawningPage)?.();
            } catch (err) {
                void errorDialog(
                    this.dialog,
                    'Konnte nicht speichern',
                    err instanceof Error ? err.message : String(err),
                );
            }
        };

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });

        // Buchung — date · counterparty · purpose · amount (tabular) · current category + provenance chip.
        const buchung = new Adw.PreferencesGroup({ title: 'Buchung' });
        buchung.add(this.kvRow('Datum', deDate(r.date)));
        buchung.add(this.kvRow('Gegenseite', r.counterparty || '—'));
        if (r.purpose) buchung.add(this.kvRow('Verwendungszweck', r.purpose));
        const betrag = new Adw.ActionRow({ title: 'Betrag' });
        betrag.add_suffix(amountLabel(eur(r.amount)));
        buchung.add(betrag);
        if (Math.abs(r.net - r.amount) > 0.005) {
            const netto = new Adw.ActionRow({ title: 'Netto (Beitrag)' });
            netto.add_suffix(amountLabel(eur(r.net)));
            buchung.add(netto);
        }
        const catRow = new Adw.ActionRow({ title: 'Kategorie', subtitle: markup(r.category) });
        catRow.set_subtitle_lines(0);
        catRow.add_suffix(provenanceChip(r.provenance));
        buchung.add(catRow);
        buchung.add(this.kvRow('Herkunft', herkunftText(r.provenance)));
        box.append(buchung);

        // Aufteilung — every part of a split booking; the one this figure counts is marked.
        const aufteilung = r.provenance.aufteilung;
        if (aufteilung) {
            const teile = new Adw.PreferencesGroup({
                title: 'Aufteilung',
                description: 'Die Buchung ist aufgeteilt; jeder Teil zählt in seiner eigenen Kategorie.',
            });
            for (const p of aufteilung.teile) {
                const hier = p.nr === aufteilung.teilNr ? ' · diese Zahl' : '';
                const row = new Adw.ActionRow({
                    title: markup(`Teil ${p.nr}${p.rest ? ' · Rest' : ''}${hier}`),
                    subtitle: markup(
                        `${p.category} · ${Math.round(p.vatRate * 100)} %${p.betrieblich ? '' : ' · privat, keine Vorsteuer'}`,
                    ),
                });
                row.set_subtitle_lines(0);
                row.add_suffix(amountLabel(eur(p.betrag)));
                teile.add(row);
            }
            box.append(teile);
        }

        // Beleg — the linked document's correspondent/title + its KI-Hinweis, or a dim placeholder.
        box.append(this.belegGroup(r, data.docMeta, () => filling, commit));

        // Umbuchen — reclassify via a ComboRow over the year's categories (current preselected).
        const umbuchen = new Adw.PreferencesGroup({
            title: 'Umbuchen',
            description: 'Bucht diese Transaktion manuell auf eine andere Kategorie (überschreibt Beleg/Regel).',
        });
        const options = data.categories.includes(r.category) ? data.categories : [r.category, ...data.categories];
        const model = new Gtk.StringList();
        for (const o of options) model.append(o);
        const combo = new Adw.ComboRow({ title: 'Kategorie', model });
        combo.set_selected(Math.max(0, options.indexOf(r.category))); // set before connect → no fill-time write
        combo.connect('notify::selected', () => {
            if (filling) return;
            const category = options[combo.get_selected()];
            if (!category || category === r.category) return;
            commit({ transactionId: r.transactionId, category, decidedBy: currentOperator() });
        });
        umbuchen.add(combo);
        // Only with a manual decision there is something to take back — and the row says what then
        // applies, computed by the same classification without the override.
        const danach = wasGiltDanach(r.provenance);
        if (danach && istAufteilung(r.provenance)) {
            const undo = new Adw.ActionRow({ title: 'Aufteilung aufheben', subtitle: markup(danach) });
            undo.set_subtitle_lines(0);
            const button = new Gtk.Button({ label: 'Aufheben', valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.connect(
                'clicked',
                () =>
                    void aufteilungAufheben(this.dialog, this.entity, this.year, r.transactionId, danach, () => {
                        this.navView.pop();
                        this.reloaders.get(spawningPage)?.();
                    }),
            );
            undo.add_suffix(button);
            umbuchen.add(undo);
        } else if (danach) {
            // A linked Erstattung is undone by lifting the link, not by removing an Umbuchung.
            const erstattung = istErstattung(r.provenance);
            const undo = new Adw.ActionRow({
                title: erstattung ? 'Verknüpfung lösen' : 'Umbuchung zurücknehmen',
                subtitle: markup(danach),
            });
            undo.set_subtitle_lines(0);
            const button = new Gtk.Button({ label: erstattung ? 'Lösen' : 'Zurücknehmen', valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.connect('clicked', () => {
                try {
                    if (erstattung) loeseErstattung(appSession(), this.entity, r.transactionId);
                    else removeDecision(this.entity, r.transactionId);
                    appSession().invalidate(this.entity.id);
                    showToast(erstattung ? 'Verknüpfung gelöst' : 'Umbuchung zurückgenommen');
                    this.navView.pop();
                    this.reloaders.get(spawningPage)?.();
                } catch (err) {
                    void errorDialog(
                        this.dialog,
                        'Konnte nicht zurücknehmen',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            });
            undo.add_suffix(button);
            umbuchen.add(undo);
        }
        box.append(umbuchen);

        // Begründung — the owner's note (why booked this way).
        const begruendung = new Adw.PreferencesGroup({ title: 'Begründung' });
        const noteRow = new Adw.EntryRow({ title: 'Warum so gebucht?' });
        noteRow.set_show_apply_button(true);
        noteRow.set_text(data.decision?.note ?? r.provenance.note ?? '');
        noteRow.connect('apply', () => {
            if (filling) return;
            const note = (noteRow.get_text() ?? '').trim();
            commit({ transactionId: r.transactionId, note });
        });
        begruendung.add(noteRow);
        box.append(begruendung);

        // Entscheidungs-Log — the append-only history (read-only).
        const logGroup = new Adw.PreferencesGroup({ title: 'Entscheidungs-Log' });
        if (data.log.length === 0) {
            logGroup.add(new Adw.ActionRow({ title: 'Noch keine Entscheidung', cssClasses: ['dim-label'] }));
        } else {
            for (const entry of [...data.log].reverse()) logGroup.add(this.decisionLogRow(entry));
        }
        box.append(logGroup);

        filling = false;

        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        return new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    }

    /** The "Beleg" group: the linked document + its KI-Hinweis (accept affordance), or a placeholder. */
    private belegGroup(
        r: FigureRow,
        meta: DocMeta | null,
        isFilling: () => boolean,
        commit: (input: ClassificationDecisionInput) => void,
    ): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: 'Beleg' });
        const documentId = r.provenance.documentId ?? null;
        if (documentId == null) {
            group.add(new Adw.ActionRow({ title: 'kein Beleg verknüpft', cssClasses: ['dim-label'] }));
            return group;
        }
        group.add(
            new Adw.ActionRow({
                title: markup(meta?.correspondent || `Beleg #${documentId}`),
                subtitle: markup(meta?.title || `#${documentId}`),
            }),
        );
        const aiNote = meta?.aiNote;
        if (aiNote) {
            const aiRow = new Adw.ActionRow({ title: 'KI-Hinweis', subtitle: markup(aiNote) });
            aiRow.set_subtitle_lines(0);
            aiRow.add_css_class('dim-label');
            const accept = new Gtk.Button({ label: 'Übernehmen', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
            accept.connect('clicked', () => {
                if (isFilling()) return;
                commit({
                    transactionId: r.transactionId,
                    aiNoteAccepted: true,
                    aiNote,
                    documentId,
                    decidedBy: currentOperator(),
                });
            });
            aiRow.add_suffix(accept);
            group.add(aiRow);
        }
        return group;
    }

    /** A read-only key/value ActionRow (dim value suffix) for the Buchung group. */
    private kvRow(key: string, value: string): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: key });
        row.add_suffix(new Gtk.Label({ label: value, cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }));
        return row;
    }

    /** One append-only decision-log entry: the change summary + a dim `timestamp · wer` subtitle. */
    private decisionLogRow(entry: DecisionLogEntry): Adw.ActionRow {
        const d = entry.detail && typeof entry.detail === 'object' ? (entry.detail as Record<string, unknown>) : {};
        const cat = typeof d.category === 'string' ? d.category : null;
        const prev = typeof d.previousCategory === 'string' ? d.previousCategory : null;
        const note = typeof d.note === 'string' ? d.note : null;
        const who = typeof d.decidedBy === 'string' ? d.decidedBy : null;
        const parts: string[] = [];
        if (entry.action === 'classification.remove') {
            parts.push(prev ? `Umbuchung «${prev}» zurückgenommen` : 'Zurückgesetzt');
        } else {
            if (cat) parts.push(prev && prev !== cat ? `«${prev}» → «${cat}»` : `Kategorie «${cat}»`);
            if (d.aiNoteAccepted === true) parts.push('KI-Hinweis übernommen');
            if (note) parts.push(`Notiz: „${note}“`);
        }
        const sub = [deDateTime(entry.at), who].filter((p): p is string => Boolean(p)).join(' · ');
        const row = new Adw.ActionRow({
            title: markup(parts.length ? parts.join(' · ') : 'Entscheidung'),
            subtitle: markup(sub),
        });
        row.set_title_lines(0);
        return row;
    }
}
