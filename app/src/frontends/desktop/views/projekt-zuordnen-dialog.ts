/**
 * Projekt zuordnen (Idee 14) — assign the marked expenses to a project. The same dialog serves the
 * Buchungen list (N marked bookings) and the booking detail (one booking).
 *
 * Optionally the text the bookings share is remembered as a project RULE: before anything is saved the
 * dialog lists every existing expense of the year that rule would take (`projektRegelVorschau`), and a
 * deselected hit becomes an exception of the rule, so the person decides on the real list. A decision
 * on a booking always wins over a rule. All matching lives in the core; this dialog shows and saves.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { projektRegelVorschau, weiseProjektZu, type ProjektRegelVorschau } from '../../../core/presenters/projekt.ts';
import { appSession } from '../data/session.ts';
import type { AppEntity } from '../entities.ts';
import { markup } from './util.ts';

export interface ProjektOption {
    id: string;
    name: string;
}

const KEIN_PROJEKT = 'Kein Projekt';

export class BhProjektZuordnenDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhProjektZuordnenDialog' }, this);
    }

    private readonly stack = new Gtk.Stack();
    private readonly banner = new Adw.Banner({ revealed: false });
    private readonly options: string[];
    private combo: Adw.ComboRow | null = null;
    private ruleSwitch: Adw.SwitchRow | null = null;
    private musterRow: Adw.EntryRow | null = null;
    private trefferGroup: Adw.PreferencesGroup | null = null;
    private trefferRows: Gtk.Widget[] = [];
    private vorschau: ProjektRegelVorschau | null = null;
    /** Hits the person deselected — they become the rule's `ausnahmen`. */
    private readonly abgewaehlt = new Set<string>();
    private saveButton: Gtk.Button | null = null;
    private loadSeq = 0;

    /**
     * @param erlaubeKein offer „Kein Projekt" (deciding that a booking belongs to none, so a rule leaves it
     *   alone) as an entry of the project list.
     */
    constructor(
        private readonly entity: AppEntity,
        private readonly year: number,
        private readonly ids: string[],
        private readonly projekte: ProjektOption[],
        private readonly erlaubeKein: boolean,
        private readonly saved: (message: string, ids: string[]) => void,
    ) {
        super();
        this.set_title('Projekt zuordnen');
        this.set_content_width(560);
        this.set_content_height(640);
        this.options = [...projekte.map((p) => p.name), ...(erlaubeKein ? [KEIN_PROJEKT] : [])];

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.projekte.length === 0 ? this.leer() : this.build());
        this.set_child(toolbar);
    }

    private leer(): Gtk.Widget {
        return new Adw.StatusPage({
            iconName: 'folder-symbolic',
            title: 'Noch kein Projekt',
            description: markup('Lege zuerst unter „Projekte“ ein Projekt an, dem die Ausgaben gehören sollen.'),
        });
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

        const ziel = new Adw.PreferencesGroup({
            title: this.ids.length === 1 ? '1 Ausgabe' : `${this.ids.length} Ausgaben`,
            description: markup('Die Zuordnung ändert keine Zahl der EÜR, nur das Projektergebnis.'),
        });
        this.combo = new Adw.ComboRow({ title: 'Projekt', model: Gtk.StringList.new(this.options) });
        this.combo.set_selected(0);
        this.combo.connect('notify::selected', () => this.projektGeaendert());
        ziel.add(this.combo);
        box.append(ziel);

        const regel = new Adw.PreferencesGroup({
            title: 'Regel',
            description: markup(
                'Künftige Ausgaben mit demselben Text kommen dann von selbst in das Projekt. ' +
                    'Eine Zuordnung von Hand gewinnt immer gegen eine Regel.',
            ),
        });
        this.ruleSwitch = new Adw.SwitchRow({
            title: 'Als Regel merken',
            subtitle: markup('Das gemeinsame Muster der Buchungen wird als Projektregel gespeichert'),
        });
        this.ruleSwitch.connect('notify::active', () => this.regelUmgeschaltet());
        regel.add(this.ruleSwitch);
        this.musterRow = new Adw.EntryRow({ title: 'Muster', showApplyButton: true, visible: false });
        this.musterRow.connect('apply', () => void this.ladeVorschau(this.musterRow?.get_text().trim()));
        regel.add(this.musterRow);
        box.append(regel);

        this.trefferGroup = new Adw.PreferencesGroup({ visible: false });
        box.append(this.trefferGroup);
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
        this.saveButton = new Gtk.Button({ label: 'Zuordnen', cssClasses: ['suggested-action', 'pill'] });
        this.saveButton.connect('clicked', () => void this.onSave());
        bottom.append(this.saveButton);
        wrapper.append(bottom);
        this.stack.add_named(wrapper, 'content');
        return this.stack;
    }

    /** The chosen project id, or null for „Kein Projekt". */
    private gewaehlt(): string | null {
        const i = this.combo?.get_selected() ?? 0;
        return this.projekte[i]?.id ?? null;
    }

    private projektGeaendert(): void {
        const kein = this.gewaehlt() == null;
        this.ruleSwitch?.set_sensitive(!kein);
        if (kein && this.ruleSwitch?.get_active()) this.ruleSwitch.set_active(false);
        else if (this.ruleSwitch?.get_active()) void this.ladeVorschau(this.musterRow?.get_text().trim());
    }

    private regelUmgeschaltet(): void {
        const an = this.ruleSwitch?.get_active() ?? false;
        this.musterRow?.set_visible(an);
        this.trefferGroup?.set_visible(an);
        if (an) void this.ladeVorschau(this.musterRow?.get_text().trim() || undefined);
        this.updateSave();
    }

    private async ladeVorschau(muster?: string): Promise<void> {
        const projectId = this.gewaehlt();
        if (projectId == null) return;
        const seq = ++this.loadSeq;
        try {
            const v = await projektRegelVorschau(appSession(), this.entity, this.year, this.ids, projectId, {
                muster: muster || undefined,
            });
            if (seq !== this.loadSeq) return;
            this.vorschau = v;
            this.abgewaehlt.clear();
            if (this.musterRow && this.musterRow.get_text() !== v.muster) this.musterRow.set_text(v.muster);
            this.zeigeTreffer(v);
        } catch (err) {
            this.zeigeFehler(err);
        }
        this.updateSave();
    }

    private zeigeTreffer(v: ProjektRegelVorschau): void {
        const group = this.trefferGroup;
        if (!group) return;
        for (const r of this.trefferRows) group.remove(r);
        this.trefferRows = [];
        group.set_title(`Trifft ${v.treffer.length} Ausgabe(n)`);
        group.set_description(
            markup(
                v.treffer.length > 0
                    ? 'Abgewählte Ausgaben werden Ausnahmen der Regel und bleiben ohne Projekt.'
                    : v.muster
                      ? 'Mit diesem Muster erfasst die Regel keine vorhandene Ausgabe.'
                      : 'Kein gemeinsames Muster — tippe eines ein.',
            ),
        );
        for (const t of v.treffer) {
            const check = new Gtk.CheckButton({ active: true, valign: Gtk.Align.CENTER });
            check.set_tooltip_text(`Erfassen: ${t.zeile}`);
            const row = new Adw.ActionRow({
                title: markup(t.zeile),
                subtitle: t.beispiel ? 'markiert' : 'weitere Ausgabe mit diesem Muster',
            });
            row.set_title_lines(1);
            row.add_prefix(check);
            row.set_activatable_widget(check);
            check.connect('toggled', () => {
                if (check.get_active()) this.abgewaehlt.delete(t.id);
                else this.abgewaehlt.add(t.id);
            });
            group.add(row);
            this.trefferRows.push(row);
        }
        for (const n of v.nichtErfasst) {
            const row = new Adw.ActionRow({ title: markup(n.zeile), subtitle: markup(`nicht erfasst: ${n.warum}`) });
            row.set_title_lines(1);
            row.add_prefix(new Gtk.Image({ iconName: 'dialog-information-symbolic', cssClasses: ['dim-label'] }));
            group.add(row);
            this.trefferRows.push(row);
        }
    }

    private updateSave(): void {
        const regelAn = this.ruleSwitch?.get_active() ?? false;
        this.saveButton?.set_sensitive(!regelAn || !!this.vorschau?.muster);
    }

    private zeigeFehler(err: unknown): void {
        this.banner.set_title(markup(`Konnte nicht speichern: ${err instanceof Error ? err.message : String(err)}`));
        this.banner.set_revealed(true);
    }

    private async onSave(): Promise<void> {
        const projectId = this.gewaehlt();
        const regelAn = (this.ruleSwitch?.get_active() ?? false) && projectId != null;
        const muster = (this.musterRow?.get_text() ?? '').trim();
        try {
            const ausnahmen = [...this.abgewaehlt];
            const r = await weiseProjektZu(appSession(), this.entity, this.year, this.ids, projectId, {
                decidedBy: 'app',
                regel: regelAn ? { muster, ausnahmen } : undefined,
            });
            const name = this.projekte.find((p) => p.id === projectId)?.name;
            const n = r.zugeordnet.length + r.unveraendert.length + r.viaRegel.length;
            const was =
                projectId == null
                    ? `${n} Ausgabe(n): kein Projekt`
                    : `${n} Ausgabe(n) → Projekt „${markup(name ?? projectId)}“`;
            const regelText = r.regel
                ? ` · Regel „${markup(muster)}“ ${r.regel.added ? 'gemerkt' : 'gab es schon'}`
                : '';
            const skip = r.uebersprungen.length ? ` · ${r.uebersprungen.length} übersprungen` : '';
            this.saved(`${was}${regelText}${skip}`, [...r.zugeordnet, ...r.viaRegel]);
            this.close();
        } catch (err) {
            this.zeigeFehler(err);
        }
    }
}
