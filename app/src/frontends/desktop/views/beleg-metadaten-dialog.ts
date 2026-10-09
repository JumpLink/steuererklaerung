/**
 * Filling in a receipt's fields by hand — the KI-free path through Beleg-Eingang.
 *
 * Everything the app knows about a receipt beyond its filename comes from the AI: `extract-invoice`
 * reads the amounts, the date, the correspondent and the invoice number out of the OCR text. With
 * no model configured, a receipt stays a PDF with a name — and the EÜR, which joins on those very
 * fields, cannot see it.
 *
 * There was no way to type them in. That is what makes "ohne KI nutzbar" a claim rather than a
 * fact, so this is the dialog that closes it: the same `setMetadata` the AI review path writes
 * through, so a receipt corrected by hand is indistinguishable from one the model got right.
 *
 * A receipt that is NOT an e-invoice gets a suggestion from the sender's last invoice (VAT rate,
 * direction — `prefillFromLastInvoice`); an e-invoice arrives with its fields already filled and
 * shows its classification here. Both are suggestions: every value stays editable.
 *
 * The arithmetic lives in the kernel (`core/actions/documents.ts`), not here — the CLI and the web
 * UI need the same "net + VAT must equal gross" rule, and a second copy in a dialog is how the two
 * surfaces end up disagreeing about the same receipt.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { nimmDokumentRegelZurueck, rememberDokumentRegelFromDocument } from '../../../core/actions/dokumentregeln.ts';
import {
    deriveAmounts,
    type ReceiptMetadataInput,
    updateReceiptMetadata,
    VAT_RATES,
    validateReceiptMetadata,
} from '../../../core/actions/documents.ts';
import type { DmsDocument } from '../../../core/presenters/belege.ts';
import { dmsProviderFor } from '../data/dms.ts';
import type { AppEntity } from '../entities.ts';
import { prefillFromLastInvoice, prefillReason, type PrefillRecord } from '../../../core/invoices/e-rechnung/index.ts';
import { herkunftSatz, suggestDokumentMuster } from '../../../core/dokumentregeln/regeln.ts';
import { ACCOUNTING_CATEGORY_OPTIONS } from '../../../core/lib/select-field-constants.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { rechnungsartRow } from './rechnungsart-row.ts';
import { markup } from './util.ts';
import { parseGermanInput } from '../../../core/lib/parsing.ts';

/** Report the outcome; the caller toasts it and reloads. */
export type MetadataResult = (message: string, changed: boolean) => void;

/** First entry of the category picker: no category. */
const NO_CATEGORY = '—';
const CATEGORIES: readonly string[] = [NO_CATEGORY, ...ACCOUNTING_CATEGORY_OPTIONS];

const DIRECTIONS: Array<{ id: 'incoming' | 'outgoing' | null; label: string }> = [
    { id: null, label: '—' },
    { id: 'incoming', label: 'Eingang (Ausgabe)' },
    { id: 'outgoing', label: 'Ausgang (Einnahme)' },
];

/** `1.234,56` and `1234.56` both mean the same thing; empty means "not set". */
function parseAmount(text: string): number | null | undefined {
    if (text.trim() === '') return null;
    // undefined = unparseable, refuse it. parseGermanInput is strict on purpose: a half-read
    // amount stored without complaint is the failure this dialog exists to prevent.
    return parseGermanInput(text) ?? undefined;
}

/** Money for an entry field: German decimal comma, no thousands separator. */
function formatAmount(value: number | null): string {
    return value == null ? '' : value.toFixed(2).replace('.', ',');
}

export class BhBelegMetadatenDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhBelegMetadatenDialog' }, this);
    }

    private readonly doc: DmsDocument;
    private readonly entity: AppEntity;
    private readonly done: MetadataResult;
    private readonly history: readonly PrefillRecord[];

    // NOT `title`: Adw.Dialog already has a string property of that name and the override is a
    // type error — the sort that only surfaces once someone subclasses.
    private readonly titleRow = new Adw.EntryRow({ title: 'Titel' });
    private readonly correspondent = new Adw.EntryRow({ title: 'Korrespondent' });
    private readonly invoiceNumber = new Adw.EntryRow({ title: 'Rechnungsnummer' });
    private readonly created = new Adw.EntryRow({ title: 'Datum (JJJJ-MM-TT)' });
    private readonly direction: Adw.ComboRow;
    private readonly documentType = new Adw.EntryRow({ title: 'Dokumenttyp' });
    private readonly category: Adw.ComboRow;
    /** The picker's entries; a category outside the SKR03 list (typed into a rule) is kept, not blanked. */
    private readonly categories: readonly string[];
    private readonly remember = new Adw.SwitchRow({
        title: 'Als Regel merken',
        subtitle:
            'Künftige Belege mit diesem Korrespondenten bekommen Dokumenttyp, Kategorie und Richtung automatisch — ohne KI.',
    });
    private readonly net = new Adw.EntryRow({ title: 'Netto' });
    private readonly vat = new Adw.EntryRow({ title: 'USt' });
    private readonly gross = new Adw.EntryRow({ title: 'Brutto' });
    private readonly rate: Adw.ComboRow;
    private readonly banner = new Adw.Banner({ revealed: false });

    constructor(doc: DmsDocument, entity: AppEntity, history: readonly PrefillRecord[], done: MetadataResult) {
        super();
        this.doc = doc;
        this.entity = entity;
        this.history = history;
        this.done = done;

        this.direction = new Adw.ComboRow({
            title: 'Richtung',
            model: Gtk.StringList.new(DIRECTIONS.map((d) => d.label)),
        });
        this.categories =
            doc.category && !CATEGORIES.includes(doc.category) ? [...CATEGORIES, doc.category] : CATEGORIES;
        this.category = new Adw.ComboRow({
            title: 'Kategorie',
            model: Gtk.StringList.new([...this.categories]),
        });
        this.rate = new Adw.ComboRow({
            title: 'Steuersatz',
            subtitle: 'Ergänzen füllt aus einer Zahl die beiden anderen',
            model: Gtk.StringList.new(VAT_RATES.map((r) => `${Math.round(r * 100)} %`)),
        });
        this.rate.set_selected(VAT_RATES.indexOf(0.19));

        this.set_title('Beleg bearbeiten');
        this.set_content_width(540);
        this.set_content_height(800);
        this.set_child(this.build());
        this.fillFrom(doc);
        this.applyPrefill(doc);
    }

    // ── Layout ────────────────────────────────────────────────────────────────────────────────

    private build(): Gtk.Widget {
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 16,
            marginEnd: 16,
        });

        const identity = new Adw.PreferencesGroup({
            title: 'Beleg',
            description: markup(this.doc.title ?? 'Ohne Titel'),
        });
        identity.add(this.titleRow);
        identity.add(this.correspondent);
        identity.add(this.invoiceNumber);
        identity.add(this.created);
        identity.add(this.direction);
        identity.add(this.documentType);
        identity.add(this.category);
        box.append(identity);

        box.append(this.ruleGroup());

        const art = rechnungsartRow(this.doc);
        if (art) {
            const artGroup = new Adw.PreferencesGroup({ title: 'Rechnungsart' });
            artGroup.add(art);
            box.append(artGroup);
        }

        const amounts = new Adw.PreferencesGroup({
            title: 'Beträge',
            description: 'Zwei Zahlen genügen — die dritte wird ergänzt. Komma als Dezimaltrennzeichen.',
        });

        // Rate + "ergänzen" FIRST, and the button as a suffix on the rate row rather than a
        // trailing widget: at the window heights this dialog actually opens at, a button below
        // three entry rows falls below the fold — the affordance that makes the form quick to fill
        // was the one thing the user could not see.
        const derive = new Gtk.Button({ label: 'Ergänzen', valign: Gtk.Align.CENTER });
        derive.connect('clicked', () => this.onDerive());
        this.rate.add_suffix(derive);
        amounts.add(this.rate);

        amounts.add(this.net);
        amounts.add(this.vat);
        amounts.add(this.gross);
        box.append(amounts);
        box.append(this.banner);

        const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
        scroller.set_child(box);
        toolbar.set_content(scroller);

        const bottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
            spacing: 8,
            marginTop: 10,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        const save = new Gtk.Button({ label: 'Speichern' });
        save.add_css_class('suggested-action');
        save.add_css_class('pill');
        save.connect('clicked', () => void this.onSave());
        bottom.append(save);
        toolbar.add_bottom_bar(bottom);

        return toolbar;
    }

    /**
     * Dokumentregeln (Idee 11): where the fields above came from, if a rule set them, and the switch
     * that turns what is on screen into a rule for the next receipt of this sender.
     */
    private ruleGroup(): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Regel' });
        group.set_header_suffix(new BhGlossaryHelp('dokumentregel', lernmodusOn()));
        const origin = this.doc.ruleOrigin;
        if (origin) {
            const row = new Adw.ActionRow({ title: markup(herkunftSatz(origin)) });
            row.set_title_lines(0);
            row.add_prefix(new Gtk.Image({ iconName: 'emblem-system-symbolic', cssClasses: ['dim-label'] }));
            const undo = new Gtk.Button({
                label: 'Zurücknehmen',
                valign: Gtk.Align.CENTER,
                tooltipText: 'Werte der Regel von diesem Beleg entfernen',
            });
            undo.connect('clicked', () => void this.onUndoRule());
            row.add_suffix(undo);
            group.add(row);
        }
        group.add(this.remember);
        return group;
    }

    private fillFrom(doc: DmsDocument): void {
        this.documentType.set_text(doc.documentType ?? '');
        this.category.set_selected(Math.max(0, this.categories.indexOf(doc.category ?? NO_CATEGORY)));
        this.titleRow.set_text(doc.title ?? '');
        this.correspondent.set_text(doc.correspondent ?? '');
        this.invoiceNumber.set_text(doc.invoiceNumber ?? '');
        this.created.set_text(doc.created ?? '');
        this.direction.set_selected(
            Math.max(
                0,
                DIRECTIONS.findIndex((d) => d.id === doc.direction),
            ),
        );
        this.net.set_text(formatAmount(doc.net));
        this.vat.set_text(formatAmount(doc.vat));
        this.gross.set_text(formatAmount(doc.gross));
    }

    /**
     * Suggest the VAT rate and the direction from this sender's last invoice — only for a receipt
     * that is not an e-invoice (those carry their own values) and only into fields still empty.
     */
    private applyPrefill(doc: DmsDocument): void {
        if (doc.invoiceKind === 'e-rechnung' || !doc.correspondent) return;
        const prefill = prefillFromLastInvoice(this.history, doc.correspondent, doc.id);
        if (!prefill) return;
        const parts: string[] = [];
        if (prefill.vatRate != null && doc.net == null && doc.vat == null && doc.gross == null) {
            const index = VAT_RATES.findIndex((r) => Math.abs(r - prefill.vatRate!) < 0.001);
            if (index >= 0) {
                this.rate.set_selected(index);
                parts.push(`Steuersatz ${Math.round(VAT_RATES[index] * 100)} %`);
            }
        }
        if (prefill.direction && doc.direction == null) {
            this.direction.set_selected(
                Math.max(
                    0,
                    DIRECTIONS.findIndex((d) => d.id === prefill.direction),
                ),
            );
            parts.push(prefill.direction === 'incoming' ? 'Eingang' : 'Ausgang');
        }
        if (parts.length > 0) {
            this.rate.set_subtitle(`${prefillReason(prefill, doc.correspondent)} (${parts.join(', ')})`);
        }
    }

    // ── Reading the form ──────────────────────────────────────────────────────────────────────

    /** Null when a field is unparseable — the caller reports which one rather than saving a NaN. */
    private readAmounts(): { net: number | null; vat: number | null; gross: number | null } | null {
        const net = parseAmount(this.net.get_text() ?? '');
        const vat = parseAmount(this.vat.get_text() ?? '');
        const gross = parseAmount(this.gross.get_text() ?? '');
        if (net === undefined || vat === undefined || gross === undefined) return null;
        return { net, vat, gross };
    }

    private selectedCategory(): string | null {
        const picked = this.categories[this.category.get_selected()];
        return picked && picked !== NO_CATEGORY ? picked : null;
    }

    private collect(): ReceiptMetadataInput | null {
        const amounts = this.readAmounts();
        if (!amounts) {
            this.warn('Betrag ist keine Zahl — bitte prüfen (Komma als Dezimaltrennzeichen).');
            return null;
        }
        const text = (row: Adw.EntryRow): string | null => {
            const value = (row.get_text() ?? '').trim();
            return value === '' ? null : value;
        };
        return {
            title: text(this.titleRow),
            correspondent: text(this.correspondent),
            invoiceNumber: text(this.invoiceNumber),
            created: text(this.created),
            direction: DIRECTIONS[this.direction.get_selected()]?.id ?? null,
            documentType: text(this.documentType),
            category: this.selectedCategory(),
            ...amounts,
        };
    }

    // ── Actions ───────────────────────────────────────────────────────────────────────────────

    /** Complete the missing figure(s) from what is there, using the chosen rate. */
    private onDerive(): void {
        const amounts = this.readAmounts();
        if (!amounts) {
            this.warn('Betrag ist keine Zahl — bitte prüfen (Komma als Dezimaltrennzeichen).');
            return;
        }
        const rate = VAT_RATES[this.rate.get_selected()] ?? 0.19;
        const derived = deriveAmounts(amounts, rate);
        if (derived.net === amounts.net && derived.vat === amounts.vat && derived.gross === amounts.gross) {
            this.warn('Zu wenig Angaben — trage mindestens einen Betrag ein.');
            return;
        }
        this.net.set_text(formatAmount(derived.net));
        this.vat.set_text(formatAmount(derived.vat));
        this.gross.set_text(formatAmount(derived.gross));
        this.banner.set_revealed(false);
    }

    private async onSave(): Promise<void> {
        const input = this.collect();
        if (!input) return;

        // Validate BEFORE writing and show every problem at once — a save that reports one issue,
        // then another after the fix, is three round trips for one form.
        const problems = validateReceiptMetadata(input);
        if (problems.length > 0) {
            this.warn(problems.join(' '));
            return;
        }
        try {
            await updateReceiptMetadata(dmsProviderFor(this.entity), this.doc.id, input);
            const message = this.remember.get_active() ? this.rememberRule(input) : 'Beleg gespeichert';
            this.done(message, true);
            this.close();
        } catch (err) {
            this.warn(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Store the saved values as a Dokumentregel for this sender; the sentence is the toast. */
    private rememberRule(input: ReceiptMetadataInput): string {
        const values = {
            correspondent: input.correspondent ?? null,
            documentType: input.documentType ?? null,
            category: input.category ?? null,
            direction: input.direction ?? null,
        };
        const muster = suggestDokumentMuster(values);
        if (!muster) return 'Beleg gespeichert — für eine Regel fehlt der Korrespondent';
        try {
            const { added, changed } = rememberDokumentRegelFromDocument(this.entity.id, values, muster);
            if (added) return `Beleg gespeichert · Regel für „${muster}“ gemerkt`;
            return changed
                ? `Beleg gespeichert · Regel für „${muster}“ aktualisiert`
                : `Beleg gespeichert · Regel für „${muster}“ gab es schon`;
        } catch (err) {
            return `Beleg gespeichert — Regel nicht gemerkt: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    /** „Zurücknehmen": clear what the rule set on this receipt and say what applies then. */
    private async onUndoRule(): Promise<void> {
        try {
            const { satz } = await nimmDokumentRegelZurueck(dmsProviderFor(this.entity), this.entity.id, this.doc.id);
            this.done(satz, true);
            this.close();
        } catch (err) {
            this.warn(`Zurücknehmen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private warn(message: string): void {
        this.banner.set_title(markup(message));
        this.banner.set_revealed(true);
    }
}
