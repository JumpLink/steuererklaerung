/**
 * „Aufteilen" (Idee 13, Splitbuchung) — split one booking into parts with their own amount, category
 * and VAT rate. One row per part; the remainder row has no entry and shows what is left, recomputed
 * on every keystroke. Saving validates in the core (`berechneTeile`), and a booking in an already
 * filed period asks for confirmation first — the core writes nothing without it.
 *
 * `aufteilungAufheben` is the undo used by the booking detail and the Herleitung: a confirmation that
 * says what applies afterwards, plus the same filed-period guard.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import {
    aufteilungAnsicht,
    bewirtungsTeile,
    hebeAufteilungAuf,
    restBetrag,
    speichereAufteilung,
    type AufteilungAnsicht,
} from '../../../core/presenters/aufteilung.ts';
import {
    berechneTeile,
    doppelzaehlungHinweis,
    PRIVAT_KATEGORIE,
    type TeilEingabe,
} from '../../../core/elster/splitbuchung.ts';
import { fmtDe, round2 } from '../../../core/lib/money.ts';
import { appSession } from '../data/session.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { markup } from './util.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { _, _n, fmt } from '../i18n.ts';

const satzLabel = (s: number) => `${Math.round(s * 100)} %`;

/** „59,50" / „59.50" → 59.5; empty → null; anything else → NaN (the core then says what is wrong). */
function parseBetrag(text: string): number | null {
    const t = text.trim();
    if (!t) return null;
    return Number(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
}

interface TeilZeile {
    row: Adw.ActionRow;
    kategorie: Gtk.DropDown;
    satz: Gtk.DropDown;
    betrag: Gtk.Entry | null;
    restLabel: Gtk.Label | null;
}

/** The filed-period confirmation; resolves true when the owner wants to go ahead anyway. */
function trotzAbgabeFragen(parent: Gtk.Widget, warnung: string, confirmLabel: string): Promise<boolean> {
    return confirmDialog(parent, {
        heading: _('Period already filed'),
        body: warnung,
        confirmLabel,
        destructive: true,
    });
}

/**
 * „Aufteilung aufheben": confirm (with „Danach gilt wieder: …"), then remove — asking once more when
 * the period is filed. `onDone` runs after a removal.
 */
export async function aufteilungAufheben(
    parent: Gtk.Widget,
    entity: AppEntity,
    year: number,
    txId: string,
    danach: string | null,
    onDone: () => void,
): Promise<void> {
    const ok = await confirmDialog(parent, {
        heading: _('Remove split?'),
        body: `${_('The parts are deleted, the transaction counts as a whole again.')} ${danach ?? ''}`.trim(),
        confirmLabel: _('Remove split'),
        destructive: true,
    });
    if (!ok) return;
    try {
        let r = await hebeAufteilungAuf(appSession(), entity, year, txId);
        if (!r.ok && 'bestaetigungNoetig' in r) {
            if (!(await trotzAbgabeFragen(parent, r.warnung, _('Remove anyway')))) return;
            r = await hebeAufteilungAuf(appSession(), entity, year, txId, { trotzAbgabe: true });
        }
        appSession().invalidate(entity.id, year);
        showToast(_('Split removed'));
        onDone();
    } catch (err) {
        void errorDialog(parent, _('Could not remove'), err instanceof Error ? err.message : String(err));
    }
}

export class BhAufteilenDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhAufteilenDialog' }, this);
    }

    private readonly teileGroup = new Adw.PreferencesGroup({ title: _('Parts') });
    private readonly hinweis = new Gtk.Label({
        wrap: true,
        xalign: 0,
        cssClasses: ['caption'],
        marginTop: 6,
        visible: false,
    });
    private readonly save = new Gtk.Button({ label: _('Save'), cssClasses: ['suggested-action'], sensitive: false });
    private zeilen: TeilZeile[] = [];
    private ansicht: AufteilungAnsicht | null = null;

    constructor(
        private readonly entity: AppEntity,
        private readonly year: number,
        private readonly txId: string,
        private readonly done: () => void,
    ) {
        super({ title: _('Split transaction'), contentWidth: 720, contentHeight: 600 });
        const header = new Adw.HeaderBar();
        header.pack_end(this.save);
        this.save.connect('clicked', () => void this.speichern());
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        const loading = new Adw.Spinner({ widthRequest: 32, heightRequest: 32, valign: Gtk.Align.CENTER });
        toolbar.set_content(loading);
        this.set_child(toolbar);

        aufteilungAnsicht(appSession(), entity, year, txId)
            .then((a) => {
                this.ansicht = a;
                toolbar.set_content(this.build(a));
                this.pruefen();
            })
            .catch((err) => {
                void errorDialog(this, _('Split'), err instanceof Error ? err.message : String(err));
                this.close();
            });
    }

    private build(a: AufteilungAnsicht): Gtk.Widget {
        const page = new Adw.PreferencesPage();
        const summary = new Adw.PreferencesGroup({
            title: _('Transaction'),
            description: _(
                'Each part counts with its own amount, category and tax rate. One part takes the remainder.',
            ),
        });
        summary.set_header_suffix(new BhGlossaryHelp('splitbuchung', lernmodusOn()));
        const betrag = new Adw.ActionRow({
            title: _('Amount'),
            subtitle: `${a.bookingDate.split('-').reverse().join('.')}`,
        });
        betrag.add_suffix(new Gtk.Label({ label: `${fmtDe(a.amount)} €`, cssClasses: ['numeric', 'title-4'] }));
        summary.add(betrag);
        if (a.abgaben.length > 0) {
            const row = new Adw.ActionRow({
                title: _('Period already filed'),
                subtitle: markup(
                    fmt(_('{periods} — saving asks once more.'), { periods: a.abgaben.map((x) => x.label).join(', ') }),
                ),
            });
            row.set_subtitle_lines(0);
            row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'] }));
            summary.add(row);
        }
        if (a.gesperrt) {
            const row = new Adw.ActionRow({ title: _('Not possible'), subtitle: markup(a.gesperrt) });
            row.set_subtitle_lines(0);
            summary.add(row);
        }
        page.add(summary);

        const actions = new Gtk.Box({ spacing: 6 });
        const bewirtung = new Gtk.Button({ label: _('Business meals 70/30'), cssClasses: ['flat'] });
        bewirtung.set_tooltip_text(
            _('70 % business meals, 30 % not deductible — the input VAT stays fully deductible'),
        );
        bewirtung.connect('clicked', () => this.setTeile(bewirtungsTeile(a.amount, a.belegSatz ?? 0.19)));
        const plus = new Gtk.Button({ iconName: 'list-add-symbolic', cssClasses: ['flat'] });
        plus.set_tooltip_text(_('Add part'));
        plus.connect('clicked', () => {
            const eingaben = this.eingaben();
            const rest = eingaben.pop()!;
            this.setTeile([...eingaben, { category: a.kategorieOhne, betrag: null, vatRate: a.belegSatz }, rest]);
        });
        actions.append(bewirtung);
        actions.append(plus);
        this.teileGroup.set_header_suffix(actions);
        page.add(this.teileGroup);

        const pruef = new Adw.PreferencesGroup();
        pruef.add(this.hinweis);
        page.add(pruef);

        this.setTeile(
            a.teile
                ? a.teile.map((t) => ({
                      category: t.category,
                      betrag: t.rest ? null : t.betrag,
                      vatRate: t.vatRate,
                      rest: t.rest,
                  }))
                : [
                      // Half and half as the starting point: one amount to correct, the rest follows.
                      { category: a.kategorieOhne, betrag: round2(Math.abs(a.amount) / 2), vatRate: a.belegSatz },
                      { category: PRIVAT_KATEGORIE, rest: true, vatRate: a.belegSatz },
                  ],
        );
        if (a.gesperrt) this.teileGroup.set_sensitive(false);
        return page;
    }

    /** Rebuild the part rows; the LAST row (or the one flagged) is the remainder. */
    private setTeile(eingaben: TeilEingabe[]): void {
        const a = this.ansicht!;
        for (const z of this.zeilen) this.teileGroup.remove(z.row);
        this.zeilen = [];
        let restIndex = eingaben.findIndex((t) => t.rest);
        if (restIndex < 0) restIndex = eingaben.length - 1;
        // Keep the remainder at the bottom: it is what the other rows leave.
        const ordered = [...eingaben.filter((_, i) => i !== restIndex), eingaben[restIndex]];
        ordered.forEach((t, i) => {
            const rest = i === ordered.length - 1;
            const row = new Adw.ActionRow({
                title: rest ? fmt(_('Part {n} · Remainder'), { n: i + 1 }) : fmt(_('Part {n}'), { n: i + 1 }),
            });
            const kategorie = Gtk.DropDown.new_from_strings([...a.kategorien]);
            kategorie.set_selected(Math.max(0, a.kategorien.indexOf(t.category)));
            kategorie.set_valign(Gtk.Align.CENTER);
            kategorie.connect('notify::selected', () => this.pruefen());
            const satz = Gtk.DropDown.new_from_strings(a.steuersaetze.map(satzLabel));
            const rate = t.vatRate ?? a.belegSatz ?? 0.19;
            satz.set_selected(
                Math.max(
                    0,
                    a.steuersaetze.findIndex((s) => Math.abs(s - rate) < 1e-9),
                ),
            );
            satz.set_valign(Gtk.Align.CENTER);
            satz.connect('notify::selected', () => this.pruefen());
            row.add_suffix(kategorie);
            row.add_suffix(satz);
            let betrag: Gtk.Entry | null = null;
            let restLabel: Gtk.Label | null = null;
            if (rest) {
                restLabel = new Gtk.Label({ cssClasses: ['numeric', 'heading'], widthChars: 11, xalign: 1 });
                row.add_suffix(restLabel);
            } else {
                betrag = new Gtk.Entry({
                    text: t.betrag != null ? fmtDe(t.betrag) : '',
                    placeholderText: '0,00',
                    widthChars: 9,
                    xalign: 1,
                    valign: Gtk.Align.CENTER,
                    inputPurpose: Gtk.InputPurpose.NUMBER,
                });
                betrag.connect('changed', () => this.pruefen());
                row.add_suffix(betrag);
                if (ordered.length > 2) {
                    const del = new Gtk.Button({
                        iconName: 'user-trash-symbolic',
                        cssClasses: ['flat'],
                        valign: Gtk.Align.CENTER,
                    });
                    del.set_tooltip_text(fmt(_('Remove part {n}'), { n: i + 1 }));
                    del.connect('clicked', () => this.setTeile(this.eingaben().filter((_, j) => j !== i)));
                    row.add_suffix(del);
                }
            }
            this.teileGroup.add(row);
            this.zeilen.push({ row, kategorie, satz, betrag, restLabel });
        });
        this.pruefen();
    }

    private eingaben(): TeilEingabe[] {
        const a = this.ansicht!;
        return this.zeilen.map((z, i) => ({
            category: a.kategorien[z.kategorie.get_selected()] ?? '',
            vatRate: a.steuersaetze[z.satz.get_selected()] ?? 0,
            ...(i === this.zeilen.length - 1 ? { rest: true } : { betrag: parseBetrag(z.betrag?.get_text() ?? '') }),
        }));
    }

    /** Live: the remainder, the validation sentence and the double-count note. */
    private pruefen(): void {
        const a = this.ansicht;
        if (!a || this.zeilen.length === 0) return;
        const eingaben = this.eingaben();
        const rest = restBetrag(a.amount, eingaben, eingaben.length - 1);
        const restZeile = this.zeilen[this.zeilen.length - 1];
        restZeile.restLabel?.set_label(`${fmtDe(rest)} €`);
        restZeile.restLabel?.set_css_classes(['numeric', 'heading', ...(rest > 0 ? [] : ['error'])]);
        let fehler: string | null = null;
        let hinweis: string | null = null;
        try {
            const teile = berechneTeile(a.amount, eingaben);
            hinweis = doppelzaehlungHinweis(teile, a.privatanteile);
        } catch (err) {
            fehler = err instanceof Error ? err.message : String(err);
        }
        this.save.set_sensitive(!fehler && !a.gesperrt);
        const text = fehler ?? hinweis;
        this.hinweis.set_label(text ?? '');
        this.hinweis.set_css_classes(['caption', ...(fehler ? ['error'] : hinweis ? ['warning'] : [])]);
        this.hinweis.set_visible(Boolean(text));
    }

    private async speichern(): Promise<void> {
        const eingaben = this.eingaben();
        try {
            let r = await speichereAufteilung(appSession(), this.entity, this.year, this.txId, eingaben);
            if (!r.ok) {
                if (!(await trotzAbgabeFragen(this, r.warnung, _('Split anyway')))) return;
                r = await speichereAufteilung(appSession(), this.entity, this.year, this.txId, eingaben, {
                    trotzAbgabe: true,
                });
            }
            if (!r.ok) return;
            appSession().invalidate(this.entity.id, this.year);
            showToast(fmt(_n('Split into {n} part', 'Split into {n} parts', r.teile.length), { n: r.teile.length }));
            this.close();
            this.done();
        } catch (err) {
            void errorDialog(this, _('Could not split'), err instanceof Error ? err.message : String(err));
        }
    }
}
