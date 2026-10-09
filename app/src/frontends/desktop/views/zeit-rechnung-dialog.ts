/**
 * <BhZeitRechnungDialog> — asks for the terms before turning tracked time into an invoice draft.
 *
 * Deliberately small: the hours, the customer and the Leistungszeitraum are already known from the
 * entries — only the rate, the VAT rate and the rounding are decisions. It shows what the result
 * will be (hours × rate) BEFORE confirming, because the confirm is not undoable in practice: it
 * attaches the entries to the invoice, and they stop showing up as unbilled.
 *
 * There is no hourly rate in the master data yet, so it has to be entered per invoice. When rates
 * move onto the contact, this dialog is the one place that has to prefill from there.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import { parseGermanInput } from '../../../core/lib/parsing.ts';

export interface ZeitRechnungOptions {
    hourlyRate: number;
    vatRate: number;
    roundToMinutes: number;
}

export interface ZeitRechnungDialogInit {
    project: string;
    customer: string;
    hours: number;
    onConfirm: (opts: ZeitRechnungOptions) => void;
}

/** Rounding choices in combo order; the selected index maps back to these. */
const ROUNDING = [0, 15, 30, 60];
const ROUNDING_LABELS = ['exakt', 'auf 15 min', 'auf 30 min', 'auf volle Stunde'];

/** VAT choices in combo order. 19 % is the normal case; 0 % covers Kleinunternehmer/§13b. */
const VAT_RATES = [0.19, 0.07, 0];
const VAT_LABELS = ['19 %', '7 %', '0 %'];

export class BhZeitRechnungDialog {
    private readonly dialog = new Adw.PreferencesDialog();
    private readonly rateRow = new Adw.EntryRow({ title: 'Stundensatz netto (€)' });
    private readonly vatRow = new Adw.ComboRow({
        title: 'Umsatzsteuer',
        model: Gtk.StringList.new(VAT_LABELS),
    });
    private readonly roundRow = new Adw.ComboRow({
        title: 'Runden',
        subtitle: 'je Projekt, nicht je Eintrag',
        model: Gtk.StringList.new(ROUNDING_LABELS),
    });
    private readonly previewRow = new Adw.ActionRow({ title: 'Ergebnis' });

    constructor(private readonly init: ZeitRechnungDialogInit) {
        this.dialog.set_title('Rechnung aus Zeiten');

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: init.project,
            description: `${init.hours} h für ${init.customer}`,
        });

        this.rateRow.set_text('');
        this.rateRow.connect('changed', () => this.updatePreview());
        this.vatRow.connect('notify::selected', () => this.updatePreview());
        this.roundRow.connect('notify::selected', () => this.updatePreview());

        group.add(this.rateRow);
        group.add(this.vatRow);
        group.add(this.roundRow);
        group.add(this.previewRow);

        const confirm = new Adw.ButtonRow({ title: 'Entwurf erzeugen' });
        confirm.add_css_class('suggested-action');
        confirm.connect('activated', () => this.confirm());
        group.add(confirm);

        page.add(group);
        this.dialog.add(page);
        this.updatePreview();
    }

    present(parent: Gtk.Widget): void {
        this.dialog.present(parent);
        this.rateRow.grab_focus();
    }

    /** Accept both "120" and "120,50" — a German keyboard writes the comma. */
    private rate(): number {
        const n = parseGermanInput(this.rateRow.get_text());
        return n != null && n > 0 ? n : 0;
    }

    private roundedHours(): number {
        const minutes = ROUNDING[this.roundRow.get_selected()] ?? 0;
        if (!minutes) return this.init.hours;
        const step = minutes / 60;
        return Math.ceil(this.init.hours / step) * step;
    }

    private updatePreview(): void {
        const rate = this.rate();
        if (rate <= 0) {
            this.previewRow.set_subtitle('Stundensatz eingeben');
            return;
        }
        const hours = this.roundedHours();
        const vat = VAT_RATES[this.vatRow.get_selected()] ?? 0.19;
        const net = Math.round(hours * rate * 100) / 100;
        const gross = Math.round(net * (1 + vat) * 100) / 100;
        this.previewRow.set_subtitle(`${hours} h × ${rate} € = ${net} € netto · ${gross} € brutto`);
    }

    private confirm(): void {
        const hourlyRate = this.rate();
        if (hourlyRate <= 0) {
            this.rateRow.grab_focus();
            return;
        }
        this.dialog.close();
        this.init.onConfirm({
            hourlyRate,
            vatRate: VAT_RATES[this.vatRow.get_selected()] ?? 0.19,
            roundToMinutes: ROUNDING[this.roundRow.get_selected()] ?? 0,
        });
    }
}
