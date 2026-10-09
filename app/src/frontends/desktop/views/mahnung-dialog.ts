/**
 * The Mahnung draft (Idee 12): pick a stage, read the text, copy it / save it / open a mail draft in
 * the owner's own mail program — and only AFTER sending it there, mark the stage „Als versandt".
 *
 * The app sends nothing. The text is a read-only label (select + copy, or open the mail draft to
 * change it there): the draft stands for what the owner reviews, and a stage counts only once they
 * confirm it twice — the button, then the question.
 */

import Adw from '@girs/adw-1';
import Gdk from '@girs/gdk-4.0';
import Gtk from '@girs/gtk-4.0';
import { contactDisplayName } from '@steuererklaerung/store';

import {
    entwerfeMahnung,
    MAHNSTUFEN,
    markiereMahnungVersandt,
    type MahnungEntwurfErgebnis,
    type OffenerPosten,
} from '../../../core/presenters/forderungen.ts';
import { loadCustomers } from '../../../core/presenters/rechnungen.ts';
import { deDate } from '../../../core/lib/format.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { LoadToken, saveFileViaDialog } from './util.ts';

const STUFEN: (1 | 2 | 3)[] = [1, 2, 3];

export class BhMahnungDialog {
    private readonly dialog = new Adw.Dialog({ title: 'Mahnung entwerfen', contentWidth: 640, contentHeight: 720 });
    private readonly token = new LoadToken();
    private readonly status = new Gtk.Label({ xalign: 0, wrap: true, cssClasses: ['dim-label'] });
    private readonly betreff = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, cssClasses: ['heading'] });
    private readonly text = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, selectable: true });
    private readonly stufeRow = new Adw.ComboRow({ title: 'Stufe' });
    private readonly buttons: Gtk.Button[] = [];
    private entwurf: MahnungEntwurfErgebnis | null = null;

    /** Called after a stage was marked as sent, so the list behind can re-read. */
    onChanged: () => void = () => {};

    open(parent: Gtk.Widget, entity: AppEntity, posten: OffenerPosten): void {
        const model = new Gtk.StringList();
        for (const s of STUFEN) model.append(`${s} · ${MAHNSTUFEN[s].name} (${MAHNSTUFEN[s].ton})`);
        this.stufeRow.set_model(model);
        this.stufeRow.set_selected(STUFEN.indexOf(posten.naechsteStufe ?? 3));

        const gruppe = new Adw.PreferencesGroup({
            title: `Rechnung ${posten.nummer ?? posten.rechnungId} · ${posten.kunde}`,
            description:
                'Das ist ein Entwurf. Die App versendet nichts — den Text kopierst du oder öffnest ihn im ' +
                'Mailprogramm. Erst wenn du ihn selbst verschickt hast, merkst du die Stufe als versandt.',
        });
        gruppe.add(this.stufeRow);

        const karte = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            cssClasses: ['card'],
            marginTop: 6,
        });
        for (const w of [this.betreff, this.text]) {
            w.set_margin_start(14);
            w.set_margin_end(14);
        }
        this.betreff.set_margin_top(14);
        this.text.set_margin_bottom(14);
        karte.append(this.betreff);
        karte.append(this.text);

        const aktionen = new Gtk.Box({ spacing: 8, halign: Gtk.Align.START });
        const knopf = (label: string, run: () => void, css?: string): Gtk.Button => {
            const b = new Gtk.Button({ label, sensitive: false });
            if (css) b.add_css_class(css);
            b.connect('clicked', run);
            this.buttons.push(b);
            return b;
        };
        aktionen.append(knopf('Kopieren', () => this.kopieren()));
        aktionen.append(knopf('Als Textdatei speichern', () => this.speichern()));
        aktionen.append(knopf('Mailentwurf öffnen', () => this.mailEntwurf(entity, posten)));

        const versandt = knopf(
            'Als versandt markieren',
            () => void this.alsVersandt(entity, posten),
            'suggested-action',
        );
        versandt.set_halign(Gtk.Align.START);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            marginTop: 12,
            marginBottom: 18,
            marginStart: 18,
            marginEnd: 18,
        });
        box.append(gruppe);
        box.append(this.status);
        box.append(karte);
        box.append(aktionen);
        box.append(new Gtk.Separator());
        box.append(versandt);

        const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
        scroller.set_child(box);
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(scroller);
        this.dialog.set_child(toolbar);

        this.stufeRow.connect('notify::selected', () => void this.laden(entity, posten));
        this.dialog.present(parent);
        void this.laden(entity, posten);
    }

    private get stufe(): 1 | 2 | 3 {
        return STUFEN[this.stufeRow.get_selected()] ?? 1;
    }

    private async laden(entity: AppEntity, posten: OffenerPosten): Promise<void> {
        const token = this.token.next();
        const stufe = this.stufe;
        for (const b of this.buttons) b.set_sensitive(false);
        this.status.set_label('Entwurf wird erstellt …');
        try {
            const e = await entwerfeMahnung(entity.id, posten.rechnungId, stufe);
            if (token !== this.token.current) return;
            this.entwurf = e;
            this.betreff.set_label(`Betreff: ${e.betreff}`);
            this.text.set_label(e.text);
            this.status.set_label(
                `Entwurf Stufe ${e.stufe} · Zahlungsfrist ${deDate(e.zahlungsfrist)} · nicht versendet` +
                    (e.schonVersandt ? ' · diese Stufe ist schon als versandt vermerkt' : ''),
            );
            for (const b of this.buttons) b.set_sensitive(true);
        } catch (err) {
            if (token !== this.token.current) return;
            this.entwurf = null;
            this.betreff.set_label('');
            this.text.set_label('');
            this.status.set_label(err instanceof Error ? err.message : String(err));
        }
    }

    private volltext(): string {
        return this.entwurf ? `Betreff: ${this.entwurf.betreff}\n\n${this.entwurf.text}` : '';
    }

    private kopieren(): void {
        if (!this.entwurf) return;
        this.dialog.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(this.volltext()));
        showToast('Entwurf in die Zwischenablage kopiert');
    }

    private speichern(): void {
        const e = this.entwurf;
        if (!e) return;
        const name = `Mahnung-Stufe-${e.stufe}-${(e.nummer ?? e.rechnungId).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`;
        saveFileViaDialog(this.dialog, name, new TextEncoder().encode(this.volltext()), 'Entwurf');
    }

    /** The owner's own mail program, with subject and text filled in — it is theirs to send. */
    private mailEntwurf(entity: AppEntity, posten: OffenerPosten): void {
        const e = this.entwurf;
        if (!e) return;
        let an = '';
        try {
            const key = posten.kunde.trim().toLowerCase();
            an = loadCustomers(entity.id).find((c) => contactDisplayName(c).trim().toLowerCase() === key)?.email ?? '';
        } catch {
            an = '';
        }
        const uri = `mailto:${encodeURIComponent(an)}?subject=${encodeURIComponent(e.betreff)}&body=${encodeURIComponent(e.text)}`;
        new Gtk.UriLauncher({ uri }).launch(this.dialog.get_root() as Gtk.Window | null, null, () => {});
    }

    private async alsVersandt(entity: AppEntity, posten: OffenerPosten): Promise<void> {
        const e = this.entwurf;
        if (!e) return;
        const sure = await confirmDialog(this.dialog, {
            heading: `Stufe ${e.stufe} als versandt markieren?`,
            body:
                `Die App versendet nichts. Markiere die ${MAHNSTUFEN[e.stufe].name} zu Rechnung ${e.nummer ?? e.rechnungId} ` +
                'nur, wenn du sie selbst an den Kunden geschickt hast — danach gilt diese Stufe und die nächste wird erst nach 14 Tagen fällig.',
            confirmLabel: 'Ja, ich habe sie versendet',
            cancelLabel: 'Noch nicht',
        });
        if (!sure) return;
        try {
            await markiereMahnungVersandt(entity.id, posten.rechnungId, e.stufe);
            showToast(`Stufe ${e.stufe} zu ${e.nummer ?? e.rechnungId} als versandt vermerkt`);
            this.dialog.close();
            this.onChanged();
        } catch (err) {
            await errorDialog(this.dialog, 'Nicht gespeichert', err instanceof Error ? err.message : String(err));
        }
    }
}
