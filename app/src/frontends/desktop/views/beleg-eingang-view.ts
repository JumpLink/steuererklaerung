/**
 * <BhBelegEingangView> — the guided Beleg-Eingang confirm flow (v3 redesign).
 *
 * Split view: the queue (unlinked receipts, newest first) with a session progress bar on the left;
 * on the right the confirm detail for the selected receipt — KI-Hinweis, the Beleg's read-only
 * facts, the candidate BOOKINGS (link-first-then-classify: a confirm needs a booking) and the
 * Kategorie/Begründung form. "Bestätigen und weiter" writes through the shared core action
 * (link + ledger decision + Paperless mark-up), marks the row ✓, advances to the next open receipt
 * and offers an Undo-Toast instead of a confirmation dialog (HIG). ←/→ step through the open
 * receipts, Enter confirms. Confirmed rows stay listed (struck through) until the next reload.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gdk from '@girs/gdk-4.0';
import GObject from '@girs/gobject-2.0';
import GLib from '@girs/glib-2.0';
import Gio from '@girs/gio-2.0';

import Template from './beleg-eingang-view.blp';
import {
    loadBelegEingang,
    nextOpenId,
    reviewProgressLabel,
    stepOpenId,
    type DmsDocument,
} from '../../../core/presenters/belege.ts';
import { impliedRate } from '../../../core/elster/euer-transactions.ts';
import { navigateTo } from '../nav.ts';
import { isConfidentPair } from '../../../core/lib/transactions/auto-link.ts';
import { appSession } from '../data/session.ts';
import { dmsProviderFor } from '../data/dms.ts';
import { loadEuerCategories } from '../data/decisions.ts';
import { loadLinkCandidates, type LinkCandidate } from '../data/link-candidates.ts';
import { confirmBeleg, undoConfirmBeleg, type BelegConfirmUndo } from '../data/beleg-review.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, amountLabel, loadIntoStack, markup } from './util.ts';
import { showToast, showUndoToast } from '../toast.ts';
import { paperlessZuordnungRow, regelHerkunftRow } from './dokumentregel-row.ts';
import { rechnungsartRow } from './rechnungsart-row.ts';
import { errorDialog } from './dialogs.ts';
import { scoreBadge } from './beleg-link-dialog.ts';
import { neueBelegeAusMailZaehlen } from '../../../core/actions/mail-eingang.ts';
import { herkunftSatz as mailHerkunftSatz, neueBelegeSatz } from '../../../core/mail-eingang/herkunft.ts';

const DMS_LABEL: Record<string, string> = { builtin: 'eigenes DMS', paperless: 'Paperless' };

/** The accept option's combo label (index 0) — a category only on an explicit correction. */
const ACCEPT_LABEL = '— unverändert (KI-Vorschlag übernehmen) —';

interface QueueRow {
    row: Gtk.ListBoxRow;
    action: Adw.ActionRow;
    amount: Gtk.Label;
    check: Gtk.Image;
}

export class BhBelegEingangView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _progress_label: Gtk.Label;
    declare private _progress_bar: Gtk.ProgressBar;
    declare private _list_box: Gtk.ListBox;
    declare private _detail_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhBelegEingangView',
                Template,
                InternalChildren: ['stack', 'error_page', 'progress_label', 'progress_bar', 'list_box', 'detail_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    /** Guards the async candidate load against a stale fill after the selection moved on. */
    private readonly detailToken = new LoadToken();
    private entity?: AppEntity;
    private year = 0;

    private docs: DmsDocument[] = [];
    private kind: 'builtin' | 'paperless' = 'builtin';
    private categories: string[] = [];
    /** Confirmed this session: doc id → the undo snapshot the toast needs. */
    private readonly done = new Map<string, BelegConfirmUndo>();
    private currentId: string | null = null;
    /** Candidate bookings per receipt (loaded once per selection). */
    private readonly candidates = new Map<string, LinkCandidate[]>();
    /** Failed candidate loads per receipt (NOT cached as "no match" — rendered with a retry). */
    private readonly candidateErrors = new Map<string, string>();
    /** The chosen booking per receipt (preselected when unambiguous). */
    private readonly selectedTx = new Map<string, string>();
    /** Form edits per receipt, kept across ←/→ navigation. */
    private readonly edits = new Map<string, { categoryIndex: number; note: string }>();
    private readonly rows = new Map<string, QueueRow>();
    private confirmButton: Gtk.Button | null = null;
    private confirmBusy = false;
    /** True while select() drives the list selection — the row-selected handler must not re-enter. */
    private selecting = false;

    constructor() {
        super();
        this._list_box.connect('row-selected', (_l, row) => {
            if (this.selecting || !row) return;
            const id = row.get_name();
            if (id && id !== this.currentId) {
                this.currentId = id;
                this.detailToken.next();
                this.renderDetail();
            }
        });
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
            errorContext: 'Beleg-Eingang konnte nicht geladen werden',
            load: async () => {
                const data = await loadBelegEingang(appSession(), entity, year);
                // Category options are best-effort — without them the confirm is accept-only.
                let categories: string[] = [];
                try {
                    categories = await loadEuerCategories(entity, year);
                } catch {
                    /* accept-only confirm */
                }
                return { data, categories };
            },
            fill: ({ data, categories }) => {
                this.docs = data.docs;
                this.kind = data.kind;
                this.categories = categories;
                this.done.clear();
                this.candidates.clear();
                this.selectedTx.clear();
                this.edits.clear();
                this.detailToken.next();
                this.currentId = this.docs[0]?.id ?? null;
                this.renderList();
                this.updateProgress();
                this.renderDetail();
                // Give the queue keyboard focus right away, so ←/→/Enter work without a click.
                this.focusCurrentRow();
                if (process.env.STEUER_APP_DEBUG)
                    console.error(`[app] Beleg-Eingang ${year} ok: ${this.docs.length} offen`);
            },
        });
    }

    // ---------- queue list ----------

    private renderList(): void {
        this.selecting = true;
        let child = this._list_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list_box.remove(child);
            child = next;
        }
        this.rows.clear();
        for (const d of this.docs) {
            const action = new Adw.ActionRow();
            const amount = new Gtk.Label({ cssClasses: ['numeric', 'caption'], valign: Gtk.Align.CENTER });
            action.add_suffix(amount);
            const check = new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] });
            action.add_suffix(check);
            const row = new Gtk.ListBoxRow({ child: action, name: d.id });
            this.rows.set(d.id, { row, action, amount, check });
            this.fillRow(d);
            this._list_box.append(row);
        }
        this.selecting = false;
        this.selectRow(this.currentId);
    }

    /** One queue row: vendor · date/Nr. · amount; struck through + ✓ once confirmed. */
    private fillRow(d: DmsDocument): void {
        const entry = this.rows.get(d.id);
        if (!entry) return;
        const isDone = this.done.has(d.id);
        const vendor = markup(d.correspondent?.trim() || d.title?.trim() || '(ohne Titel)');
        entry.action.set_title(isDone ? `<s>${vendor}</s>` : vendor);
        const sub = [d.created ? deDate(d.created) : null, d.invoiceNumber ? `Nr. ${d.invoiceNumber}` : null]
            .filter(Boolean)
            .join('  ·  ');
        entry.action.set_subtitle(markup(sub));
        const amount = d.gross ?? d.net;
        entry.amount.set_label(amount != null ? eur(amount) : '');
        entry.check.set_visible(isDone);
    }

    private selectRow(id: string | null): void {
        this.selecting = true;
        const row = id != null ? this.rows.get(id)?.row : undefined;
        if (row) this._list_box.select_row(row);
        else this._list_box.unselect_all();
        this.selecting = false;
    }

    private updateProgress(): void {
        const total = this.docs.length;
        const done = this.done.size;
        const fromMail = neueBelegeAusMailZaehlen(this.docs.filter((d) => !this.done.has(d.id)));
        this._progress_label.set_label(
            fromMail > 0
                ? `${reviewProgressLabel(total, done)}\n${neueBelegeSatz(fromMail)}`
                : reviewProgressLabel(total, done),
        );
        this._progress_bar.set_fraction(total > 0 ? done / total : 0);
    }

    private doneIds(): Set<string> {
        return new Set(this.done.keys());
    }

    private currentDoc(): DmsDocument | null {
        return this.docs.find((d) => d.id === this.currentId) ?? null;
    }

    // ---------- keyboard ----------

    /** ←/→ step through the OPEN receipts, Enter confirms — unless a text field owns the arrows. */
    private onKeyPressed(keyval: number): boolean {
        if (this.docs.length === 0) return false;
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            void this.confirm();
            return true;
        }
        if (keyval !== Gdk.KEY_Left && keyval !== Gdk.KEY_Right) return false;
        const focus = (this.get_root() as Gtk.Window | null)?.get_focus();
        if (focus instanceof Gtk.Text || focus instanceof Gtk.TextView) return false;
        this.step(keyval === Gdk.KEY_Right ? 1 : -1);
        return true;
    }

    /** Skip to the neighbouring open receipt (clamped, no wrap) without confirming anything. */
    private step(dir: 1 | -1): void {
        const next = stepOpenId(this.docs, this.doneIds(), this.currentId, dir);
        if (next == null || next === this.currentId) return;
        this.currentId = next;
        this.detailToken.next();
        this.selectRow(next);
        this.renderDetail();
        // The rebuild may have destroyed the focused widget (e.g. the Überspringen button) — without
        // a focus target the window drops keyboard events and ←/→/Enter die after the first use.
        this.focusCurrentRow();
    }

    // ---------- detail pane ----------

    private clearDetail(): void {
        let child = this._detail_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._detail_box.remove(child);
            child = next;
        }
        this.confirmButton = null;
    }

    private renderDetail(): void {
        this.clearDetail();
        const doc = this.currentDoc();
        if (!doc) {
            this.renderAllDone();
            return;
        }
        if (this.done.has(doc.id)) {
            this.renderDoneDetail(doc);
            return;
        }

        this._detail_box.append(this.hinweisGroup(doc));
        this._detail_box.append(this.belegGroup(doc));

        const cands = this.candidates.get(doc.id);
        const failure = this.candidateErrors.get(doc.id);
        if (cands) {
            this._detail_box.append(this.candidatesGroup(doc, cands));
            this._detail_box.append(this.formGroup(doc));
            this._detail_box.append(this.actionsRow());
            this.updateConfirmSensitive();
        } else if (failure != null) {
            this._detail_box.append(this.candidatesErrorGroup(doc, failure));
        } else {
            this._detail_box.append(this.loadingCandidatesGroup());
            void this.loadCandidates(doc);
        }
    }

    /** A failed candidate load — clearly NOT the same as "no match"; retry re-runs the search. */
    private candidatesErrorGroup(doc: DmsDocument, message: string): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Buchung zuordnen' });
        const row = new Adw.ActionRow({
            title: 'Buchungs-Kandidaten konnten nicht ermittelt werden',
            subtitle: markup(message),
        });
        row.set_subtitle_lines(0);
        row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'] }));
        const retry = new Gtk.Button({ label: 'Erneut versuchen', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
        retry.connect('clicked', () => {
            this.candidateErrors.delete(doc.id);
            this.renderDetail();
        });
        row.add_suffix(retry);
        group.add(row);
        return group;
    }

    /** Why is this receipt here — the AI's rationale when it has one, the plain gap otherwise. */
    private hinweisGroup(doc: DmsDocument): Gtk.Widget {
        const group = new Adw.PreferencesGroup();
        const row = doc.aiNote
            ? new Adw.ActionRow({ title: 'KI-Hinweis', subtitle: markup(doc.aiNote) })
            : new Adw.ActionRow({
                  title: 'Noch keiner Buchung zugeordnet',
                  subtitle: 'Passende Buchung wählen, dann bestätigen.',
              });
        row.set_subtitle_lines(0);
        row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'] }));
        row.add_css_class('warning');
        group.add(row);
        return group;
    }

    /** The receipt's read-only facts: Lieferant · Datum · Nr. · Beträge · Original öffnen. */
    private belegGroup(doc: DmsDocument): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: 'Beleg',
            description: DMS_LABEL[this.kind] ?? this.kind,
        });
        const title = new Adw.ActionRow({
            title: markup(doc.title?.trim() || doc.correspondent?.trim() || '(ohne Titel)'),
            subtitle: markup(doc.correspondent?.trim() ?? ''),
        });
        const gross = doc.gross ?? doc.net;
        if (gross != null) title.add_suffix(amountLabel(eur(gross), { heading: true }));
        group.add(title);

        const fact = (label: string, value: string | null) => {
            if (!value) return;
            const row = new Adw.ActionRow({ title: label });
            row.add_suffix(new Gtk.Label({ label: value, cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }));
            group.add(row);
        };
        fact('Datum', doc.created ? deDate(doc.created) : null);
        fact('Rechnungsnr.', doc.invoiceNumber);
        if (doc.net != null && doc.vat != null) {
            fact('Netto', eur(doc.net));
            fact('USt', eur(doc.vat));
        }

        const art = rechnungsartRow(doc);
        if (art) group.add(art);

        // Where its sender / type / category came from: the stored rule (built-in) or Paperless' own.
        const herkunft =
            this.kind === 'paperless' && this.entity
                ? paperlessZuordnungRow(this.entity.id, doc)
                : regelHerkunftRow(doc);
        if (herkunft) group.add(herkunft);

        if (doc.origin?.kind === 'mail') {
            const where = new Adw.ActionRow({ title: 'Herkunft', subtitle: markup(mailHerkunftSatz(doc.origin)) });
            where.add_prefix(new Gtk.Image({ iconName: 'mail-unread-symbolic' }));
            group.add(where);
        }

        const open = new Adw.ActionRow({ title: 'Original öffnen', subtitle: 'Beleg-Datei anzeigen' });
        open.add_prefix(new Gtk.Image({ iconName: 'document-open-symbolic' }));
        open.set_activatable(true);
        open.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        open.connect('activated', () => void this.openOriginal(doc));
        group.add(open);
        return group;
    }

    private loadingCandidatesGroup(): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Buchung zuordnen' });
        const row = new Adw.ActionRow({ title: 'Suche passende Buchungen …' });
        row.add_prefix(new Adw.Spinner());
        group.add(row);
        return group;
    }

    private async loadCandidates(doc: DmsDocument): Promise<void> {
        if (!this.entity) return;
        const token = this.detailToken.current;
        let cands: LinkCandidate[] | null = null;
        let failure: string | null = null;
        try {
            cands = await loadLinkCandidates(this.entity, { documentId: doc.id });
        } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
        }
        if (token !== this.detailToken.current || this.currentId !== doc.id) return; // stale
        if (cands == null) {
            // A failed load must NOT masquerade as "no match" — offer a retry, cache nothing.
            this.candidateErrors.set(doc.id, failure ?? 'Unbekannter Fehler');
            this.renderDetail();
            return;
        }
        this.candidateErrors.delete(doc.id);
        this.candidates.set(doc.id, cands);
        // Preselect only the unambiguous winner (pickBestMatch's raw-score rule).
        if (!this.selectedTx.has(doc.id)) {
            const [best, second] = cands;
            if (best?.transactionId && isConfidentPair(best, second)) this.selectedTx.set(doc.id, best.transactionId);
        }
        this.renderDetail();
    }

    /** The candidate bookings as a radio list — the chosen one backs the confirm. */
    private candidatesGroup(doc: DmsDocument, cands: LinkCandidate[]): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: 'Buchung zuordnen',
            description: 'Der Beleg wird mit der gewählten Buchung verknüpft.',
        });
        if (cands.length === 0) {
            group.add(
                new Adw.ActionRow({
                    title: 'Keine passende Buchung gefunden',
                    subtitle: 'Keine unverknüpfte Buchung passt auf Betrag, Datum und Gegenseite — überspringen.',
                    cssClasses: ['dim-label'],
                }),
            );
            return group;
        }
        let radio: Gtk.CheckButton | null = null;
        for (const c of cands) {
            if (!c.transactionId) continue;
            const txId = c.transactionId;
            const check = new Gtk.CheckButton({ active: this.selectedTx.get(doc.id) === txId });
            if (radio) check.set_group(radio);
            else radio = check;
            const row = new Adw.ActionRow({
                title: markup(c.counterparty?.trim() || c.title?.trim() || 'Buchung'),
                subtitle: markup([deDate(c.date), ...c.reasons].join('  ·  ')),
            });
            row.set_subtitle_lines(0);
            row.add_prefix(check);
            row.set_activatable_widget(check);
            row.add_suffix(scoreBadge(c.score));
            row.add_suffix(amountLabel(eur(c.amount), { accent: c.amount < 0 ? 'error' : 'success' }));
            check.connect('toggled', () => {
                if (!check.get_active()) return;
                this.selectedTx.set(doc.id, txId);
                this.updateConfirmSensitive();
            });
            group.add(row);
        }
        return group;
    }

    /** Kategorie (accept per default, correcting moves the number) + Begründung. */
    private formGroup(doc: DmsDocument): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            // PreferencesGroup titles parse Pango markup — a raw & would swallow the title.
            title: markup('Prüfen & bestätigen'),
            description: 'Kategorie unverändert lassen (KI-Vorschlag übernehmen) oder korrigieren.',
        });
        const edit = this.edits.get(doc.id) ?? { categoryIndex: 0, note: '' };

        const model = new Gtk.StringList();
        model.append(ACCEPT_LABEL);
        for (const cat of this.categories) model.append(cat);
        const combo = new Adw.ComboRow({ title: 'Kategorie', model });
        combo.set_selected(Math.min(edit.categoryIndex, this.categories.length));
        const syncRateHint = () => {
            const sel = combo.get_selected();
            if (sel > 0) {
                const kind = doc.direction === 'outgoing' ? 'income' : 'expense';
                const rate = impliedRate(this.categories[sel - 1], kind);
                combo.set_subtitle(`abgeleiteter USt-Satz: ${Math.round(rate * 100)} %`);
            } else {
                combo.set_subtitle('USt-Satz wird aus der Kategorie abgeleitet');
            }
        };
        syncRateHint();
        combo.connect('notify::selected', () => {
            const e = this.edits.get(doc.id) ?? { categoryIndex: 0, note: '' };
            e.categoryIndex = combo.get_selected();
            this.edits.set(doc.id, e);
            syncRateHint();
        });
        group.add(combo);

        const note = new Adw.EntryRow({ title: 'Begründung (optional)' });
        if (edit.note) note.set_text(edit.note);
        note.connect('changed', () => {
            const e = this.edits.get(doc.id) ?? { categoryIndex: 0, note: '' };
            e.note = note.get_text();
            this.edits.set(doc.id, e);
        });
        group.add(note);
        return group;
    }

    /** Überspringen · Bestätigen und weiter, plus the keyboard hint. */
    private actionsRow(): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
        const skip = new Gtk.Button({ label: 'Überspringen', cssClasses: ['flat'] });
        skip.connect('clicked', () => this.step(1));
        buttons.append(skip);
        buttons.append(new Gtk.Box({ hexpand: true }));
        const confirm = new Gtk.Button({ label: 'Bestätigen und weiter', cssClasses: ['suggested-action', 'pill'] });
        confirm.connect('clicked', () => void this.confirm());
        buttons.append(confirm);
        this.confirmButton = confirm;
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

    private updateConfirmSensitive(): void {
        const doc = this.currentDoc();
        const ready = doc != null && !this.confirmBusy && this.selectedTx.get(doc.id) != null;
        this.confirmButton?.set_sensitive(ready);
    }

    /** A confirmed receipt reopened from the list: the facts + a way back (Undo). */
    private renderDoneDetail(doc: DmsDocument): void {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({
            title: 'Bestätigt',
            subtitle: 'Dieser Beleg wurde in dieser Sitzung bestätigt und verbucht.',
        });
        row.add_prefix(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] }));
        group.add(row);
        this._detail_box.append(group);
        this._detail_box.append(this.belegGroup(doc));
        const undoBtn = new Gtk.Button({
            label: 'Rückgängig machen',
            cssClasses: ['pill'],
            halign: Gtk.Align.CENTER,
        });
        undoBtn.connect('clicked', () => void this.undo(doc.id));
        this._detail_box.append(undoBtn);
    }

    /** Everything confirmed — the design's all-clear with the jump to the bookings. */
    private renderAllDone(): void {
        const fresh = this.done.size === 0; // queue was empty on load, nothing confirmed here
        const page = new Adw.StatusPage({
            iconName: 'object-select-symbolic',
            title: fresh ? 'Alles zugeordnet' : 'Alles geprüft',
            description: fresh
                ? `Jeder Beleg in ${this.year} ist einer Buchung zugeordnet. Neue Belege erscheinen hier.`
                : 'Alle Belege im Eingang sind bestätigt und verbucht. Neue Belege aus Paperless und E-Mail-Import erscheinen automatisch hier.',
            vexpand: true,
        });
        page.add_css_class('compact');
        if (!fresh) {
            const btn = new Gtk.Button({
                label: 'Zu den Buchungen',
                cssClasses: ['suggested-action', 'pill'],
                halign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => {
                // Was 'transaktionen' — the id is 'transactions'. selectNavByView found nothing
                // and returned silently, so this button did nothing at all. navigateTo type-checks it.
                navigateTo(this, 'transactions');
            });
            page.set_child(btn);
        }
        this._detail_box.append(page);
    }

    // ---------- writes ----------

    /** Confirm the current receipt against the chosen booking, toast Undo, advance. */
    private async confirm(): Promise<void> {
        const doc = this.currentDoc();
        if (!doc || !this.entity || this.confirmBusy || this.done.has(doc.id)) return;
        const txId = this.selectedTx.get(doc.id);
        if (!txId) return;
        const edit = this.edits.get(doc.id);
        const category = edit && edit.categoryIndex > 0 ? this.categories[edit.categoryIndex - 1] : undefined;
        const note = edit?.note.trim() || undefined;

        const entity = this.entity;
        this.confirmBusy = true;
        this.updateConfirmSensitive();
        try {
            const result = await confirmBeleg(entity, {
                documentId: doc.id,
                txId,
                category,
                note,
                aiNote: doc.aiNote,
            });
            this.done.set(doc.id, result.undo);
            this.fillRow(doc);
            this.updateProgress();
            // Toast titles parse Pango markup — Paperless-authored vendor names MUST be escaped.
            const vendor = markup(doc.correspondent?.trim() || doc.title?.trim() || 'Beleg');
            if (result.documentWrite === 'failed') {
                // Decision + link stand; only the Paperless mark-up (Tag/Kategorie) did not land.
                showToast(`Beleg „${vendor}" gebucht — Paperless-Markierung fehlgeschlagen`);
            } else {
                // The closure carries entity + snapshot so Undo still works after a view reload.
                showUndoToast(`Beleg „${vendor}" gebucht`, () => void this.undo(doc.id, entity, result.undo));
            }
            // Advance only when the user did not navigate elsewhere during the write.
            if (this.currentId === doc.id) {
                this.currentId = nextOpenId(this.docs, this.doneIds(), doc.id);
                this.detailToken.next();
                this.selectRow(this.currentId);
                this.renderDetail();
                this.focusCurrentRow();
            }
        } catch (err) {
            await errorDialog(this, 'Bestätigen fehlgeschlagen', err instanceof Error ? err.message : String(err));
        } finally {
            this.confirmBusy = false;
            this.updateConfirmSensitive();
        }
    }

    /**
     * Take one confirm back (Undo-Toast or the done detail's button). The write runs against the
     * snapshot captured at confirm time, so it works even after the view reloaded or switched
     * entity/year meanwhile — only the UI update is skipped when the view moved on.
     */
    private async undo(docId: string, entity?: AppEntity, snapshot?: BelegConfirmUndo): Promise<void> {
        const useEntity = entity ?? this.entity;
        const useSnapshot = snapshot ?? this.done.get(docId);
        if (!useSnapshot || !useEntity) {
            showToast('Rückgängig nicht mehr möglich');
            return;
        }
        try {
            await undoConfirmBeleg(useEntity, useSnapshot);
            showToast('Rückgängig gemacht');
            // Update the queue UI only when this view still shows the receipt's entity state.
            if (this.done.delete(docId)) {
                const doc = this.docs.find((d) => d.id === docId);
                if (doc) this.fillRow(doc);
                this.updateProgress();
                this.currentId = docId;
                this.detailToken.next();
                this.selectRow(docId);
                this.renderDetail();
                this.focusCurrentRow();
            }
        } catch (err) {
            await errorDialog(this, 'Rückgängig fehlgeschlagen', err instanceof Error ? err.message : String(err));
        }
    }

    /** Put keyboard focus back on the queue after a rebuild destroyed the focused widget. */
    private focusCurrentRow(): void {
        const row = this.currentId != null ? this.rows.get(this.currentId)?.row : undefined;
        row?.grab_focus();
    }

    /** Show the receipt's original file via the system handler (works for both DMS kinds). */
    private async openOriginal(doc: DmsDocument): Promise<void> {
        if (!this.entity) return;
        try {
            const file = await dmsProviderFor(this.entity).getFile(doc.id);
            if (!file) throw new Error('Die Beleg-Datei ist nicht verfügbar.');
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'steuererklaerung', 'belege']);
            GLib.mkdir_with_parents(dir, 0o755);
            const safe = doc.id.replace(/[^A-Za-z0-9_-]/g, '_');
            const path = GLib.build_filenamev([dir, `beleg-${safe}.${extForMime(file.mimeType)}`]);
            GLib.file_set_contents(path, file.bytes);
            const launcher = new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) });
            launcher.launch(this.get_root() as Gtk.Window | null, null, (_l, res) => {
                try {
                    launcher.launch_finish(res);
                } catch {
                    /* user cancelled / no handler */
                }
            });
        } catch (err) {
            await errorDialog(this, 'Original konnte nicht geöffnet werden', errText(err));
        }
    }
}

function extForMime(mime: string): string {
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    return 'bin';
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
