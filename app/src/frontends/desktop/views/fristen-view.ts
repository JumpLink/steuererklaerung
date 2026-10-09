/**
 * Fristen — what is due, what is overdue, and what has been filed but not paid.
 *
 * `data/fristen.ts` has implemented all three layers for a while and was imported by NOTHING: a
 * grep for `loadFristen` found only its own definition. The CLI has `steuer fristen`, the MCP has
 * the tools, the web UI has `bh-fristen-view.ts` — the native app had no way to see any of it.
 *
 * Which makes it the cheapest big win in the whole plan: the work is done, the data is there, and
 * a deadline nobody is shown is a deadline that gets missed.
 *
 * Deliberately NOT entity-scoped. Every other view is about one firm in one year; this is the one
 * "damit ich das nicht vergesse" screen, and a Frist you cannot see because you happen to have a
 * different entity selected is exactly the Frist you miss.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { deDate, eur } from '../../../core/lib/format.ts';
import type { AppEntity } from '../entities.ts';
import {
    type FristenData,
    loadFristen,
    type OffeneSteuerzahlung,
    type OpenItem,
    type SteuerTermin,
} from '../data/fristen.ts';
import { showToast } from '../toast.ts';
import { amountLabel, GroupRows, LoadToken, loadIntoStack, markup } from './util.ts';
import { BhFristErledigenDialog, type FristAction, type FristTarget } from './frist-erledigen-dialog.ts';

/** How a due date reads, and how urgent it looks. */
function urgency(daysUntil: number | null, overdue: boolean): { text: string; css: string } {
    if (overdue) {
        const days = daysUntil == null ? null : Math.abs(daysUntil);
        return { text: days == null ? 'überfällig' : `${days} Tage überfällig`, css: 'error' };
    }
    if (daysUntil == null) return { text: 'ohne Frist', css: 'dim-label' };
    if (daysUntil === 0) return { text: 'heute fällig', css: 'warning' };
    if (daysUntil === 1) return { text: 'morgen fällig', css: 'warning' };
    // Two weeks is the point where a Frist stops being "later" and becomes something to act on.
    return { text: `in ${daysUntil} Tagen`, css: daysUntil <= 14 ? 'warning' : 'dim-label' };
}

export class BhFristenView extends Adw.Bin {
    static {
        GObject.registerClass({ GTypeName: 'BhFristenView' }, this);
    }

    private readonly stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE });
    private readonly errorPage = new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: 'Fristen konnten nicht geladen werden',
    });
    private readonly token = new LoadToken();

    private readonly zahlungen = new Adw.PreferencesGroup({ title: 'Offene Steuerzahlungen' });
    private readonly termine = new Adw.PreferencesGroup({ title: 'Kommende Steuertermine' });
    private readonly posten = new Adw.PreferencesGroup({ title: 'Offene Posten' });
    private readonly zahlungenRows: GroupRows;
    private readonly termineRows: GroupRows;
    private readonly postenRows: GroupRows;

    constructor() {
        super();

        const loading = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
        });
        loading.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        loading.append(new Gtk.Label({ label: 'Lade Fristen …', cssClasses: ['dim-label'] }));
        this.stack.add_named(loading, 'loading');
        this.stack.add_named(this.errorPage, 'error');

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        // Money the tax office is already waiting for comes first — it is the only layer that
        // accrues Säumniszuschläge.
        box.append(this.zahlungen);
        box.append(this.termine);
        box.append(this.posten);

        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        this.stack.add_named(
            new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp }),
            'content',
        );

        this.zahlungenRows = new GroupRows(this.zahlungen);
        this.termineRows = new GroupRows(this.termine);
        this.postenRows = new GroupRows(this.posten);
        this.set_child(this.stack);
    }

    /** Entity and year are ignored on purpose — see the module note. */
    reload(_entity: AppEntity, _year: number): void {
        this.reloadSelf();
    }

    private fill(data: FristenData): void {
        this.fillZahlungen(data.steuerzahlungen, data.errors.steuerzahlungen);
        this.fillTermine(data.steuertermine, data.errors.steuertermine);
        this.fillPosten(data.openItems, data.errors.openItems);
    }

    /**
     * A layer that failed says so IN PLACE, rather than blanking the view.
     *
     * The three layers have independent sources — Paperless, the ELSTER configs, the filing
     * register — so one being unreachable is a hole, not a broken screen. Saying which one is out
     * also tells the user which numbers they should not trust right now.
     */
    private errorRow(message: string): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: 'Konnte nicht geladen werden', subtitle: markup(message) });
        row.set_subtitle_lines(0);
        row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'] }));
        return row;
    }

    // ── Offene Steuerzahlungen ────────────────────────────────────────────────────────────────

    private fillZahlungen(items: OffeneSteuerzahlung[], error?: string): void {
        this.zahlungenRows.clear();
        this.zahlungen.set_description(
            'Abgegeben, aber noch nicht als bezahlt erfasst. Beträge und Termine sind aus den Regeln ' +
                'geschätzt — gegen Bescheid und Kontoauszug prüfen.',
        );
        if (error) {
            this.zahlungenRows.add(this.errorRow(error));
            return;
        }
        if (items.length === 0) {
            this.zahlungenRows.add(this.emptyRow('Keine offenen Steuerzahlungen'));
            return;
        }
        for (const z of items) {
            const u = urgency(z.daysUntil, z.overdue);
            const sub = [z.entityName, z.dueDate ? `fällig ${deDate(z.dueDate)}` : z.note, u.text].filter(Boolean);
            const row = new Adw.ActionRow({ title: markup(z.label), subtitle: markup(sub.join('  ·  ')) });
            row.set_subtitle_lines(0);
            row.add_suffix(amountLabel(eur(z.amount), { accent: z.overdue ? 'error' : undefined }));
            row.add_suffix(
                this.erledigenButton(
                    'Bezahlt',
                    {
                        entityId: z.entityId,
                        kind: z.kind,
                        period: z.period,
                        label: z.label,
                        amount: z.amount,
                    },
                    'paid',
                ),
            );
            this.zahlungenRows.add(row);
        }
    }

    // ── Kommende Steuertermine ────────────────────────────────────────────────────────────────

    private fillTermine(items: SteuerTermin[], error?: string): void {
        this.termineRows.clear();
        this.termine.set_description(
            'Regelfristen aus den Stammdaten der Entitäten — noch nicht als abgegeben erfasst.',
        );
        if (error) {
            this.termineRows.add(this.errorRow(error));
            return;
        }
        if (items.length === 0) {
            this.termineRows.add(this.emptyRow('Keine anstehenden Steuertermine'));
            return;
        }
        for (const t of items) {
            const u = urgency(t.daysUntil, t.overdue);
            const row = new Adw.ActionRow({
                title: markup(t.label),
                subtitle: markup([t.entityName, `fällig ${deDate(t.dueDate)}`].join('  ·  ')),
            });
            row.add_suffix(new Gtk.Label({ label: u.text, cssClasses: ['caption', u.css], valign: Gtk.Align.CENTER }));
            row.add_suffix(
                this.erledigenButton(
                    'Abgegeben',
                    {
                        entityId: t.entityId,
                        kind: t.kind,
                        period: t.period,
                        label: t.label,
                    },
                    'filed',
                ),
            );
            this.termineRows.add(row);
        }
    }

    // ── Offene Posten ─────────────────────────────────────────────────────────────────────────

    private fillPosten(items: OpenItem[], error?: string): void {
        this.postenRows.clear();
        this.posten.set_description('Belege mit Zahlungsstatus „offen".');
        if (error) {
            this.postenRows.add(this.errorRow(error));
            return;
        }
        if (items.length === 0) {
            this.postenRows.add(this.emptyRow('Keine offenen Posten'));
            return;
        }
        for (const item of items) {
            const u = urgency(item.daysUntil, item.overdue);
            const sub = [item.correspondent, item.dueDate ? `fällig ${deDate(item.dueDate)}` : null, u.text].filter(
                Boolean,
            );
            const row = new Adw.ActionRow({
                title: markup(item.title?.trim() || `Beleg #${item.id}`),
                subtitle: markup(sub.join('  ·  ')),
            });
            if (item.amount != null) {
                row.add_suffix(amountLabel(eur(item.amount), { accent: item.overdue ? 'error' : undefined }));
            }
            this.postenRows.add(row);
        }
    }

    /**
     * The action that makes this list a tool instead of a notice board.
     *
     * The register was CLI- and MCP-only, so a deadline could be seen and not ticked off — and a
     * list you cannot act on is a list you stop opening. The button sits ON the row it silences.
     */
    private erledigenButton(label: string, target: FristTarget, action: FristAction): Gtk.Button {
        // NOT `.flat`: a flat button with a TEXT label at the end of a list row renders as bold
        // text and stops reading as something you can press — the affordance disappears exactly
        // where the whole point is that the row is actionable. Flat suits icon suffixes, not this.
        const button = new Gtk.Button({ label, valign: Gtk.Align.CENTER });
        button.connect('clicked', () => {
            const dialog = new BhFristErledigenDialog(target, action, (message, changed) => {
                showToast(message);
                // The register decides what the Fristen layers still report, so reload the whole
                // view rather than removing the row here — the other layers may change too.
                if (changed) this.reloadSelf();
            });
            dialog.present(this);
        });
        return button;
    }

    /** Reload without needing the entity/year the view deliberately ignores. */
    private reloadSelf(): void {
        loadIntoStack({
            stack: this.stack,
            errorPage: this.errorPage,
            token: this.token,
            errorContext: 'Fristen konnten nicht geladen werden',
            load: () => loadFristen(),
            fill: (data) => this.fill(data),
        });
    }

    /** "Nothing here" reads as reassurance in this view, not as a missing feature. */
    private emptyRow(title: string): Adw.ActionRow {
        const row = new Adw.ActionRow({ title, cssClasses: ['dim-label'] });
        row.add_prefix(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] }));
        return row;
    }
}
