/**
 * Regel aus Auswahl — the marked bookings propose a pattern and a category, and before anything is
 * saved the dialog lists EVERY existing booking of the year the rule would classify. Deselecting a
 * hit makes it an exception of the rule (`ausnahmen`), so the person decides on the real list, not on
 * the pattern's promise. Pattern, hits and the reasons an example is not caught all come from the
 * core (`presenters/zu-pruefen.ts`); this dialog only shows them and saves.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { regelAusAuswahl, saveRegelAusAuswahl, type RegelAusAuswahl } from '../../../core/presenters/zu-pruefen.ts';
import { appSession } from '../data/session.ts';
import { loadEuerCategories } from '../data/decisions.ts';
import type { AppEntity } from '../entities.ts';
import { markup } from './util.ts';

const KEINE_KATEGORIE = '— Kategorie wählen —';

export class BhRegelAusAuswahlDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhRegelAusAuswahlDialog' }, this);
    }

    private readonly entity: AppEntity;
    private readonly year: number;
    private readonly ids: string[];
    private readonly saved: (message: string) => void;

    private readonly stack = new Gtk.Stack();
    private readonly banner = new Adw.Banner({ revealed: false });
    private categories: string[] = [];
    private vorschau: RegelAusAuswahl | null = null;
    private musterRow: Adw.EntryRow | null = null;
    private combo: Adw.ComboRow | null = null;
    private options: string[] = [];
    /** Hits the person deselected — they become the rule's `ausnahmen`. */
    private readonly abgewaehlt = new Set<string>();
    private saveButton: Gtk.Button | null = null;

    constructor(entity: AppEntity, year: number, ids: string[], saved: (message: string) => void) {
        super();
        this.entity = entity;
        this.year = year;
        this.ids = ids;
        this.saved = saved;
        this.set_title('Regel aus Auswahl');
        this.set_content_width(620);
        this.set_content_height(720);

        const loading = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
        });
        loading.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        loading.append(new Gtk.Label({ label: 'Suche das gemeinsame Muster …', cssClasses: ['dim-label'] }));
        this.stack.add_named(loading, 'loading');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.stack);
        this.set_child(toolbar);
        void this.load();
    }

    private async load(opts: { muster?: string; kategorie?: string } = {}): Promise<void> {
        try {
            if (this.categories.length === 0) {
                this.categories = await loadEuerCategories(this.entity, this.year).catch(() => []);
            }
            this.vorschau = await regelAusAuswahl(appSession(), this.entity, this.year, this.ids, opts);
            this.abgewaehlt.clear();
            this.showContent(this.build(this.vorschau));
        } catch (err) {
            const page = new Adw.StatusPage({
                iconName: 'dialog-error-symbolic',
                title: 'Keine Vorschau möglich',
                description: markup(err instanceof Error ? err.message : String(err)),
            });
            this.showContent(page);
        }
    }

    private showContent(widget: Gtk.Widget): void {
        const existing = this.stack.get_child_by_name('content');
        if (existing) this.stack.remove(existing);
        this.stack.add_named(widget, 'content');
        this.stack.set_visible_child_name('content');
    }

    private build(v: RegelAusAuswahl): Gtk.Widget {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 16,
            marginEnd: 16,
        });

        const regel = new Adw.PreferencesGroup({
            title: 'Regel',
            description: markup(
                `Aus ${this.ids.length} markierten Buchung(en). Das Muster wird als Text im Buchungstext gesucht ` +
                    '(Gegenseite, Verwendungszweck, Referenz), Groß- und Kleinschreibung egal.',
            ),
        });
        this.musterRow = new Adw.EntryRow({ title: 'Muster', showApplyButton: true });
        this.musterRow.set_text(v.muster);
        this.musterRow.connect('apply', () => this.refreshPreview());
        regel.add(this.musterRow);
        this.options = [KEINE_KATEGORIE, ...this.categories];
        if (v.kategorie && !this.options.includes(v.kategorie)) this.options.splice(1, 0, v.kategorie);
        this.combo = new Adw.ComboRow({ title: 'Kategorie', model: Gtk.StringList.new(this.options) });
        this.combo.set_selected(Math.max(0, this.options.indexOf(v.kategorie)));
        this.combo.connect('notify::selected', () => this.refreshPreview());
        regel.add(this.combo);
        box.append(regel);

        if (v.eingaenge > 0) {
            const hint = new Adw.Banner({
                title: markup(
                    `${v.eingaenge} der markierten Buchungen sind Eingänge — eigene Regeln buchen als Ausgabe. ` +
                        'Kunden besser unter Einstellungen → Klassifizierung eintragen.',
                ),
                revealed: true,
            });
            box.append(hint);
        }

        const treffer = new Adw.PreferencesGroup({
            title: `Trifft ${v.treffer.length} Buchung(en)`,
            description:
                v.treffer.length > 0
                    ? 'Abgewählte Buchungen werden Ausnahmen der Regel und bleiben, wie sie sind.'
                    : 'Mit diesem Muster und dieser Kategorie erfasst die Regel keine vorhandene Buchung.',
        });
        for (const t of v.treffer) {
            const check = new Gtk.CheckButton({ active: true, valign: Gtk.Align.CENTER });
            check.set_tooltip_text(`Erfassen: ${t.zeile}`);
            const row = new Adw.ActionRow({
                title: markup(t.zeile),
                subtitle: markup(`jetzt: ${t.category} · ${t.herkunft}${t.beispiel ? ' · markiert' : ''}`),
            });
            row.set_title_lines(1);
            row.add_prefix(check);
            row.set_activatable_widget(check);
            check.connect('toggled', () => {
                if (check.get_active()) this.abgewaehlt.delete(t.id);
                else this.abgewaehlt.add(t.id);
                this.updateSave();
            });
            treffer.add(row);
        }
        box.append(treffer);

        if (v.nichtErfasst.length > 0) {
            const nicht = new Adw.PreferencesGroup({ title: 'Nicht erfasst' });
            for (const n of v.nichtErfasst) {
                const row = new Adw.ActionRow({ title: markup(n.zeile), subtitle: markup(n.warum) });
                row.set_title_lines(1);
                row.add_prefix(new Gtk.Image({ iconName: 'dialog-information-symbolic', cssClasses: ['dim-label'] }));
                nicht.add(row);
            }
            box.append(nicht);
        }

        box.append(this.banner);

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
        this.saveButton = new Gtk.Button({ label: 'Regel speichern', cssClasses: ['suggested-action', 'pill'] });
        this.saveButton.connect('clicked', () => this.onSave());
        bottom.append(this.saveButton);
        wrapper.append(bottom);
        this.updateSave();
        return wrapper;
    }

    private selectedKategorie(): string {
        const k = this.options[this.combo?.get_selected() ?? 0] ?? '';
        return k === KEINE_KATEGORIE ? '' : k;
    }

    /** Recompute the hits for the edited pattern / category — the preview must never show stale hits. */
    private refreshPreview(): void {
        const muster = (this.musterRow?.get_text() ?? '').trim();
        const kategorie = this.selectedKategorie();
        if (muster === this.vorschau?.muster && kategorie === this.vorschau?.kategorie) return;
        this.stack.set_visible_child_name('loading');
        void this.load({ muster, kategorie });
    }

    private updateSave(): void {
        const v = this.vorschau;
        const kept = v ? v.treffer.filter((t) => !this.abgewaehlt.has(t.id)).length : 0;
        this.saveButton?.set_sensitive(!!v?.muster && !!v?.kategorie && kept > 0);
    }

    private onSave(): void {
        const v = this.vorschau;
        if (!v || !v.muster || !v.kategorie) return;
        try {
            const result = saveRegelAusAuswahl(appSession(), this.entity, v.muster, v.kategorie, [...this.abgewaehlt]);
            const ausnahmen = this.abgewaehlt.size > 0 ? ` · ${this.abgewaehlt.size} Ausnahme(n)` : '';
            this.saved(
                `${result.added ? 'Regel gespeichert' : 'Regel bestand bereits'}: „${markup(v.muster)}“ → ${markup(v.kategorie)}${ausnahmen}`,
            );
            this.close();
        } catch (err) {
            this.banner.set_title(
                markup(`Konnte nicht speichern: ${err instanceof Error ? err.message : String(err)}`),
            );
            this.banner.set_revealed(true);
        }
    }
}
