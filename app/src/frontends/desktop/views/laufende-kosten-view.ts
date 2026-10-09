/**
 * <BhLaufendeKostenView> — the „Laufende Kosten" tab of the Buchungen hub (Idee 8).
 *
 * In the Buchungen hub because a series IS a set of bookings: every row unfolds into its payments, and
 * each payment opens the booking sheet. Not entity-blind like Fristen, and for a `privat` entity too
 * (rent, insurance).
 *
 * Proposals first, each with Bestätigen · Korrigieren · „Keine laufenden Kosten" (and „Beendet" for a
 * series that stopped); then the confirmed ones with their next expected payment, then what was
 * decided otherwise — each with „Zurücknehmen". A decision is one click, stored on the entity; the tab
 * re-reads afterwards so every list shows what the core now says.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './laufende-kosten-view.blp';
import {
    entscheideLaufendeKosten,
    loadLaufendeKosten,
    type LaufendeKosten,
    type LaufendeKostenUebersicht,
    type LkEntscheidungInput,
} from '../../../core/presenters/laufende-kosten.ts';
import { ABSTAND_TEXT, zuBestaetigenTitel, type SerienAbstand } from '../../../core/elster/laufende-kosten.ts';
import { loadEnrichedTransactions } from '../../../core/presenters/buchungen.ts';
import { appSession } from '../data/session.ts';
import { loadDms } from '../data/settings.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, amountLabel, applyScrollHook, emptyState, loadIntoStack, markup } from './util.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';
import { BhTxDetailDialog } from './tx-detail-dialog.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';

const ABSTAENDE: SerienAbstand[] = ['monatlich', 'vierteljaehrlich', 'halbjaehrlich', 'jaehrlich'];

const GESPEICHERT: Record<LkEntscheidungInput['status'], string> = {
    bestaetigt: 'Als laufende Kosten bestätigt',
    abgelehnt: 'Als „keine laufenden Kosten" gemerkt',
    beendet: 'Als beendet gemerkt',
    vorschlag: 'Entscheidung zurückgenommen',
};

export class BhLaufendeKostenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _content_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhLaufendeKostenView',
                Template,
                InternalChildren: ['stack', 'error_page', 'scroller', 'content_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private entity?: AppEntity;
    private year = 0;

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Laufende Kosten konnten nicht geladen werden',
            load: () => loadLaufendeKosten(appSession(), entity),
            fill: (u) => {
                this.render(u);
                applyScrollHook(this._scroller);
                if (process.env.STEUER_APP_DEBUG) {
                    console.error(
                        `[app] Laufende Kosten ok: ${u.vorschlaege.length} offen, ${u.bestaetigt.length} bestätigt`,
                    );
                }
            },
        });
    }

    private render(u: LaufendeKostenUebersicht): void {
        for (let c = this._content_box.get_first_child(); c; c = this._content_box.get_first_child()) {
            this._content_box.remove(c);
        }
        const lernmodus = lernmodusOn();

        const offen = new Adw.PreferencesGroup({
            title: u.vorschlaege.length ? zuBestaetigenTitel(u.vorschlaege.length) : 'Laufende Kosten',
            description:
                'Regelmäßige Abbuchungen an denselben Empfänger, aus allen Buchungen erkannt. Erst bestätigte zählen in ' +
                'Frei verfügbar und fallen aus den Geld-Prüfungen.' +
                (u.datenstand ? ` Datenstand: ${deDate(u.datenstand)}.` : ''),
        });
        offen.set_header_suffix(new BhGlossaryHelp('laufende-kosten', lernmodus));
        if (u.vorschlaege.length === 0) {
            offen.add(
                emptyState({
                    icon: 'emblem-ok-symbolic',
                    title: 'Nichts zu bestätigen',
                    description: u.bestaetigt.length
                        ? 'Jede erkannte Serie ist entschieden.'
                        : 'Keine Abbuchungen im festen Abstand gefunden — monatlich und vierteljährlich ab drei, halb- und jährlich ab zwei Zahlungen.',
                }),
            );
        }
        for (const k of u.vorschlaege) offen.add(this.serieRow(k, 'vorschlag'));
        this._content_box.append(offen);

        if (u.bestaetigt.length) {
            const group = new Adw.PreferencesGroup({
                title: 'Bestätigt',
                description:
                    'Die nächste erwartete Zahlung je Serie — Frei verfügbar zieht die der nächsten 30 Tage ab.',
            });
            for (const k of u.bestaetigt) group.add(this.serieRow(k, 'bestaetigt'));
            this._content_box.append(group);
        }
        for (const [titel, liste, art] of [
            ['Keine laufenden Kosten', u.abgelehnt, 'abgelehnt'],
            ['Beendet', u.beendet, 'beendet'],
        ] as const) {
            if (!liste.length) continue;
            const group = new Adw.PreferencesGroup({ title: titel });
            for (const k of liste) group.add(this.serieRow(k, art));
            this._content_box.append(group);
        }
    }

    private untertitel(k: LaufendeKosten, art: LaufendeKosten['status']): string {
        const teile = [ABSTAND_TEXT[k.abstand], `zuletzt ${deDate(k.zuletzt)}`];
        if (art === 'bestaetigt' || art === 'vorschlag') {
            teile.push(k.aktiv ? `nächste ${deDate(k.naechste)}` : 'beendet? — seit über 1,5 Abständen keine Zahlung');
        }
        teile.push(`${k.zahlungen.length} Zahlungen`);
        const p = k.preisaenderung;
        if (p) teile.push(`Preisänderung am ${deDate(p.datum)}: ${eur(p.von)} → ${eur(p.auf)}`);
        if (k.korrigiert)
            teile.push(`korrigiert (erkannt: ${ABSTAND_TEXT[k.erkannterAbstand]}, ${eur(k.letzterBetrag)})`);
        return teile.join(' · ');
    }

    /** One series: amount + actions as suffixes, its payments inside. */
    private serieRow(k: LaufendeKosten, art: LaufendeKosten['status']): Adw.ExpanderRow {
        const row = new Adw.ExpanderRow({ title: markup(k.empfaenger), subtitle: markup(this.untertitel(k, art)) });
        row.set_subtitle_lines(0);
        row.add_suffix(amountLabel(eur(k.betrag), { heading: art === 'bestaetigt' }));
        const knopf = (label: string, tip: string, run: () => void, css?: string) => {
            // An icon label keeps the row's title readable next to three buttons and the amount.
            const icon = label.endsWith('-symbolic');
            const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: `${tip}: ${k.empfaenger}` });
            if (icon) b.set_icon_name(label);
            else b.set_label(label);
            if (css) b.add_css_class(css);
            b.connect('clicked', run);
            row.add_suffix(b);
        };
        if (art === 'vorschlag') {
            knopf(
                'Bestätigen',
                'Bestätigen',
                () => void this.entscheide(k, { status: 'bestaetigt' }),
                'suggested-action',
            );
            knopf('document-edit-symbolic', 'Korrigieren', () => void this.korrigieren(k));
            if (!k.aktiv) knopf('Beendet', 'Beendet', () => void this.entscheide(k, { status: 'beendet' }));
            knopf('Keine', 'Keine laufenden Kosten', () => void this.entscheide(k, { status: 'abgelehnt' }), 'flat');
        } else {
            if (art === 'bestaetigt')
                knopf('document-edit-symbolic', 'Korrigieren', () => void this.korrigieren(k), 'flat');
            knopf('Zurücknehmen', 'Zurücknehmen', () => void this.entscheide(k, { status: 'vorschlag' }), 'flat');
        }
        for (const z of [...k.zahlungen].reverse()) {
            const r = new Adw.ActionRow({ title: deDate(z.datum), subtitle: markup(k.empfaenger), activatable: true });
            r.add_suffix(amountLabel(eur(-z.betrag)));
            r.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
            r.connect('activated', () => void this.openTx(z.id, z.datum));
            row.add_row(r);
        }
        return row;
    }

    private async entscheide(k: LaufendeKosten, e: LkEntscheidungInput): Promise<void> {
        const entity = this.entity;
        if (!entity) return;
        try {
            entscheideLaufendeKosten(appSession(), entity, k.key, e);
            showToast(`${GESPEICHERT[e.status]}: ${k.empfaenger}`);
            this.reload(entity, this.year);
        } catch (err) {
            await errorDialog(this, 'Entscheidung nicht gespeichert', err instanceof Error ? err.message : String(err));
        }
    }

    /** Confirm with a corrected interval and/or amount. */
    private korrigieren(k: LaufendeKosten): Promise<void> {
        const dlg = new Adw.AlertDialog({
            heading: `Laufende Kosten korrigieren`,
            body: `${k.empfaenger}: erkannt ${ABSTAND_TEXT[k.erkannterAbstand]}, zuletzt ${eur(k.letzterBetrag)}. Die Korrektur gilt für die nächste erwartete Zahlung.`,
        });
        const group = new Adw.PreferencesGroup();
        const model = new Gtk.StringList();
        for (const a of ABSTAENDE) model.append(ABSTAND_TEXT[a]);
        const abstand = new Adw.ComboRow({ title: 'Abstand', model, selected: ABSTAENDE.indexOf(k.abstand) });
        const betrag = new Adw.SpinRow({
            title: 'Betrag (€)',
            adjustment: new Gtk.Adjustment({ lower: 0.01, upper: 10_000_000, stepIncrement: 0.01, pageIncrement: 10 }),
            digits: 2,
        });
        betrag.set_value(k.betrag);
        group.add(abstand);
        group.add(betrag);
        dlg.set_extra_child(group);
        dlg.add_response('cancel', 'Abbrechen');
        dlg.add_response('confirm', 'Bestätigen');
        dlg.set_response_appearance('confirm', Adw.ResponseAppearance.SUGGESTED);
        dlg.set_close_response('cancel');
        dlg.set_default_response('confirm');
        return new Promise((resolve) => {
            dlg.choose(this, null, (_s, res) => {
                if (dlg.choose_finish(res) !== 'confirm') return resolve();
                void this.entscheide(k, {
                    status: 'bestaetigt',
                    abstand: ABSTAENDE[abstand.get_selected()] ?? k.abstand,
                    betrag: Math.round(betrag.get_value() * 100) / 100,
                }).then(resolve);
            });
        });
    }

    private async openTx(id: string, datum: string): Promise<void> {
        const entity = this.entity;
        if (!entity) return;
        const year = Number(datum.slice(0, 4));
        try {
            const row = (await loadEnrichedTransactions(appSession(), entity, year)).rows.find((r) => r.id === id);
            if (!row) throw new Error('Die Buchung wurde nicht gefunden.');
            let paperlessBase: string | null = null;
            try {
                paperlessBase = loadDms(entity).paperlessUrl ?? null;
            } catch {
                paperlessBase = null;
            }
            new BhTxDetailDialog().open(this, row, paperlessBase, {
                entity,
                year,
                onChanged: () => {
                    appSession().invalidate(entity.id, year);
                    this.reload(entity, this.year);
                },
            });
        } catch (err) {
            await errorDialog(this, 'Buchung nicht geöffnet', err instanceof Error ? err.message : String(err));
        }
    }
}
