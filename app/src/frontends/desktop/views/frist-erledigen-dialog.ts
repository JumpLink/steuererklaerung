/**
 * Ticking a Frist off — recording that a declaration was submitted, or that a tax payment went out.
 *
 * The filing register is what stops the proactive Steuertermine layer from nagging: a period marked
 * eingereicht/bezahlt drops out of the list. It was CLI- and MCP-only, so from the app the Fristen
 * list could only be READ — and a list of deadlines you cannot tick off is a list you stop looking
 * at, which defeats the entire point of having it.
 *
 * The dialog sits ON the row it silences rather than in a separate register screen. That matters
 * for the Jahresformulare in particular: they are submitted BY HAND in Mein ELSTER, so the moment
 * the user has something to record is the moment they are looking at the deadline, holding a
 * Transferticket.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { parseGermanInput } from '../../../core/lib/parsing.ts';
import { saveFiling } from '../data/filings.ts';
import { markup } from './util.ts';

/** Which half of the obligation is being recorded. */
export type FristAction = 'filed' | 'paid';

export interface FristTarget {
    /** Register entity id (the ledger id the Fristen layers report). */
    entityId: string;
    /** Filing kind: ustva | ust-jahr | gewst | est | feststellung | sonstige. */
    kind: string;
    /** Period label, e.g. `2026-Q2` or `2025`. */
    period: string;
    /** What the row says, for the dialog heading. */
    label: string;
    /** Pre-fill for the amount, when the row knows one. */
    amount?: number | null;
}

export type FristResult = (message: string, changed: boolean) => void;

/** `1.234,56` and `1234.56`; empty is "not stated". */
function parseAmount(text: string): number | null | undefined {
    if (text.trim() === '') return null;
    return parseGermanInput(text) ?? undefined; // undefined = unparseable
}

export class BhFristErledigenDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhFristErledigenDialog' }, this);
    }

    private readonly target: FristTarget;
    private readonly action: FristAction;
    private readonly done: FristResult;

    private readonly date = new Adw.EntryRow({ title: 'Datum (JJJJ-MM-TT)' });
    private readonly amount = new Adw.EntryRow({ title: 'Betrag' });
    private readonly reference = new Adw.EntryRow({ title: 'Transferticket / Beleg' });
    private readonly note = new Adw.EntryRow({ title: 'Notiz' });
    private readonly banner = new Adw.Banner({ revealed: false });

    constructor(target: FristTarget, action: FristAction, done: FristResult) {
        super();
        this.target = target;
        this.action = action;
        this.done = done;

        this.set_title(action === 'filed' ? 'Als abgegeben erfassen' : 'Als bezahlt erfassen');
        this.set_content_width(500);
        this.set_content_height(480);
        this.set_child(this.build());

        this.date.set_text(new Date().toISOString().slice(0, 10));
        if (target.amount != null) this.amount.set_text(target.amount.toFixed(2).replace('.', ','));
    }

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

        const filed = this.action === 'filed';
        const group = new Adw.PreferencesGroup({
            title: markup(this.target.label),
            description: filed
                ? 'Die Jahresformulare werden von Hand in Mein ELSTER abgegeben — hier wird nur ' +
                  'festgehalten, dass es passiert ist, damit der Termin nicht weiter mahnt.'
                : 'Wird die Zahlung erfasst, verschwindet der Posten aus den offenen Steuerzahlungen.',
        });
        this.date.set_title(filed ? 'Abgegeben am (JJJJ-MM-TT)' : 'Bezahlt am (JJJJ-MM-TT)');
        group.add(this.date);
        this.amount.set_title(filed ? 'Anmeldungssoll' : 'Gezahlter Betrag');
        group.add(this.amount);
        this.reference.set_title(filed ? 'Transferticket' : 'Zahlungsbeleg');
        group.add(this.reference);
        group.add(this.note);
        box.append(group);
        box.append(this.banner);

        const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
        scroller.set_child(box);
        toolbar.set_content(scroller);

        const bottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
            marginTop: 10,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        const save = new Gtk.Button({ label: 'Erfassen' });
        save.add_css_class('suggested-action');
        save.add_css_class('pill');
        save.connect('clicked', () => this.onSave());
        bottom.append(save);
        toolbar.add_bottom_bar(bottom);
        return toolbar;
    }

    private onSave(): void {
        const date = (this.date.get_text() ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            this.warn('Datum muss im Format JJJJ-MM-TT stehen.');
            return;
        }
        const amount = parseAmount(this.amount.get_text() ?? '');
        if (amount === undefined) {
            this.warn('Betrag ist keine Zahl — bitte prüfen (Komma als Dezimaltrennzeichen).');
            return;
        }

        const filed = this.action === 'filed';
        const reference = (this.reference.get_text() ?? '').trim();
        const note = (this.note.get_text() ?? '').trim();
        // The reference belongs in the note rather than in a field of its own: the register has no
        // column for it, and inventing one would be a schema change for a string nobody queries.
        const combined = [reference ? `${filed ? 'Transferticket' : 'Beleg'}: ${reference}` : null, note || null]
            .filter(Boolean)
            .join(' · ');

        try {
            saveFiling({
                entityId: this.target.entityId,
                kind: this.target.kind,
                period: this.target.period,
                // Only the half being recorded. recordFiling MERGES, so filing a period and paying
                // it later are two writes to one entry, and neither erases the other.
                ...(filed ? { filedAt: date, declaredAmount: amount } : { paidAt: date, amount }),
                ...(combined ? { note: combined } : {}),
            });
            this.done(filed ? 'Als abgegeben erfasst' : 'Als bezahlt erfasst', true);
            this.close();
        } catch (err) {
            this.warn(`Konnte nicht erfassen: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private warn(message: string): void {
        this.banner.set_title(markup(message));
        this.banner.set_revealed(true);
    }
}
