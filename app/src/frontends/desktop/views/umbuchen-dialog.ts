/**
 * Umbuchen — change a booking's category, record why, or take the change back.
 *
 * The capability existed and had exactly one door: the Herleitung dialog, reachable only from a
 * figure in the EÜR. From the Buchungen list — the view a person actually scrolls when they think
 * "that one is booked wrong" — the detail sheet was read-only, and its own header comment said so.
 *
 * `removeClassificationDecision` and `restoreClassificationDecision` had NO caller outside the
 * beleg-review Undo path at all: once a booking was reclassified by hand, the app offered no way
 * back to what the rule or the receipt said.
 *
 * A focused dialog rather than an extraction of the Herleitung's leaf page: that leaf is bound to
 * `FigureRow`, the dialog's NavigationView and a `spawningPage` reloader. Pulling those apart would
 * have been a refactor of the EÜR drill-down in service of a different view — this needs a
 * transaction id, its current category, and the year's category list.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { rememberRule, suggestPattern } from '../../../core/actions/classification-rules.ts';
import { removeDecision, saveDecision } from '../data/decisions.ts';
import { loadEuerCategories } from '../data/decisions.ts';
import type { AppEntity } from '../entities.ts';
import { markup } from './util.ts';

/** The booking being reclassified — the subset both call sites can supply. */
export interface UmbuchenTarget {
    transactionId: string;
    /** The category it is booked under right now. */
    category: string;
    /** How that category was arrived at — `manual` means a decision exists to take back. */
    source: string;
    counterparty?: string;
    purpose?: string;
    note?: string;
    /** What applies once the manual decision is taken back („Danach gilt wieder: …"). */
    danach?: string;
}

export type UmbuchenResult = (message: string, changed: boolean) => void;

export class BhUmbuchenDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhUmbuchenDialog' }, this);
    }

    private readonly entity: AppEntity;
    private readonly year: number;
    private readonly target: UmbuchenTarget;
    private readonly done: UmbuchenResult;

    private readonly stack = new Gtk.Stack();
    private readonly banner = new Adw.Banner({ revealed: false });
    private combo: Adw.ComboRow | null = null;
    private note: Adw.EntryRow | null = null;
    private rememberRow: Adw.SwitchRow | null = null;
    /** The pattern the row offers to remember — empty when the booking suggests none. */
    private pattern = '';
    private categories: string[] = [];

    constructor(entity: AppEntity, year: number, target: UmbuchenTarget, done: UmbuchenResult) {
        super();
        this.entity = entity;
        this.year = year;
        this.target = target;
        this.done = done;

        this.set_title('Umbuchen');
        this.set_content_width(520);
        this.set_content_height(520);

        const loading = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
        });
        loading.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        loading.append(new Gtk.Label({ label: 'Lade Kategorien …', cssClasses: ['dim-label'] }));
        this.stack.add_named(loading, 'loading');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.stack);
        this.set_child(toolbar);

        void this.load();
    }

    private async load(): Promise<void> {
        try {
            this.categories = await loadEuerCategories(this.entity, this.year);
        } catch {
            // A missing category list is not a reason to refuse the edit: the current category is
            // always offered, so a booking can still be given a Begründung.
            this.categories = [];
        }
        const content = this.build();
        const existing = this.stack.get_child_by_name('content');
        if (existing) this.stack.remove(existing);
        this.stack.add_named(content, 'content');
        this.stack.set_visible_child_name('content');
    }

    private build(): Gtk.Widget {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 16,
            marginEnd: 16,
        });

        const summary = new Adw.PreferencesGroup({ title: 'Buchung' });
        summary.add(
            new Adw.ActionRow({
                title: markup(this.target.counterparty?.trim() || this.target.purpose?.trim() || '—'),
                subtitle: markup(this.target.purpose?.trim() ?? ''),
            }),
        );
        box.append(summary);

        const group = new Adw.PreferencesGroup({
            title: 'Kategorie',
            description: 'Eine manuelle Buchung gewinnt über Beleg und Regel.',
        });
        // The current category is always in the list, even when it is not among the year's
        // categories — otherwise reopening the dialog would silently propose a different one.
        const options = this.categories.includes(this.target.category)
            ? this.categories
            : [this.target.category, ...this.categories];
        this.combo = new Adw.ComboRow({ title: 'Kategorie', model: Gtk.StringList.new(options) });
        this.combo.set_selected(Math.max(0, options.indexOf(this.target.category)));
        group.add(this.combo);

        this.note = new Adw.EntryRow({ title: 'Begründung' });
        this.note.set_text(this.target.note ?? '');
        group.add(this.note);
        box.append(group);

        // "Als Regel merken" — the moment the judgement is made is the only moment it is cheap to
        // record. Without it, a person working without AI reclassifies one booking at a time
        // forever and never teaches the program anything; the rule chain then keeps asking the same
        // question of every future booking from the same supplier.
        //
        // Only offered when the booking suggests a pattern that could match a FUTURE booking (see
        // suggestPattern): a rule built from an invoice number catches one payment and nothing else,
        // which is a switch that promises learning and delivers noise.
        const pattern = suggestPattern(this.target);
        if (pattern) {
            const learn = new Adw.PreferencesGroup({
                title: 'Merken',
                description: 'Damit die nächste Buchung dieser Gegenseite von selbst richtig landet.',
            });
            this.rememberRow = new Adw.SwitchRow({
                title: markup(`Als Regel merken: „${pattern}“`),
                subtitle: 'Wird in den Einstellungen unter Klassifizierung gepflegt.',
                active: false,
            });
            this.pattern = pattern;
            learn.add(this.rememberRow);
            box.append(learn);
        }

        box.append(this.banner);

        // Only offered when there IS a manual decision to take back. Showing it otherwise promises
        // an undo for something the user never did.
        if (this.target.source === 'manual') {
            const undo = new Adw.PreferencesGroup({
                title: 'Zurücknehmen',
                description: markup(
                    this.target.danach ??
                        'Entfernt die manuelle Entscheidung. Die Buchung fällt danach wieder auf das zurück, ' +
                            'was Beleg oder Regel sagen.',
                ),
            });
            const row = new Adw.ActionRow({ title: 'Umbuchung zurücknehmen' });
            const button = new Gtk.Button({ label: 'Zurücknehmen', valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.connect('clicked', () => this.onRemove());
            row.add_suffix(button);
            undo.add(row);
            box.append(undo);
        }

        const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
        scroller.set_child(box);

        const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        wrapper.append(scroller);

        const bottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
            marginTop: 10,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        const save = new Gtk.Button({ label: 'Speichern' });
        save.add_css_class('suggested-action');
        save.add_css_class('pill');
        save.connect('clicked', () => this.onSave());
        bottom.append(save);
        wrapper.append(bottom);
        return wrapper;
    }

    private onSave(): void {
        const combo = this.combo;
        const note = this.note;
        if (!combo || !note) return;

        const model = combo.get_model() as Gtk.StringList | null;
        const category = model?.get_string(combo.get_selected()) ?? this.target.category;
        const text = (note.get_text() ?? '').trim();

        // recordClassificationDecision refuses an empty decision, and rightly so — but the user
        // pressing Speichern without changing anything deserves an explanation, not that error.
        if (category === this.target.category && text === (this.target.note ?? '')) {
            this.warn('Nichts geändert.');
            return;
        }
        try {
            saveDecision(this.entity, {
                transactionId: this.target.transactionId,
                category,
                note: text || null,
                decidedBy: 'app',
            });
            // The rule is a SEPARATE, secondary write: the reclassification already succeeded, so a
            // failing rule must be reported without pretending the booking was not rebooked.
            let learned = '';
            if (this.rememberRow?.get_active() && this.pattern) {
                try {
                    const result = rememberRule(this.entity.id, this.pattern, category);
                    learned = result.added ? ' · Regel gemerkt' : ' · Regel bestand bereits';
                } catch (err) {
                    learned = ` · Regel NICHT gemerkt (${err instanceof Error ? err.message : String(err)})`;
                }
            }
            this.done(`Umgebucht auf ${category}${learned}`, true);
            this.close();
        } catch (err) {
            this.warn(`Konnte nicht speichern: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private onRemove(): void {
        try {
            removeDecision(this.entity, this.target.transactionId);
            this.done('Umbuchung zurückgenommen', true);
            this.close();
        } catch (err) {
            this.warn(`Konnte nicht zurücknehmen: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private warn(message: string): void {
        this.banner.set_title(markup(message));
        this.banner.set_revealed(true);
    }
}
