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
import { abstandText, zuBestaetigenTitel, type SerienAbstand } from '../../../core/elster/laufende-kosten.ts';
import { loadEnrichedTransactions } from '../../../core/presenters/buchungen.ts';
import { appSession } from '../data/session.ts';
import { loadDms } from '../data/settings.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { _, _n, _p, fmt } from '../i18n.ts';
import { LoadToken, amountLabel, applyScrollHook, emptyState, loadIntoStack, markup } from './util.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';
import { BhTxDetailDialog } from './tx-detail-dialog.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { pinnableCluster, rowActions } from '../widgets/responsive.ts';

const ABSTAENDE: SerienAbstand[] = ['monatlich', 'vierteljaehrlich', 'halbjaehrlich', 'jaehrlich'];

/**
 * What the toast says after a decision.
 *
 * A function, not a `Record` constant: a constant is built at import time, and a label resolved
 * before the frontend registers its translator stays English for good.
 */
function gespeichertText(status: LkEntscheidungInput['status']): string {
    switch (status) {
        case 'bestaetigt':
            return _('Confirmed as a recurring cost');
        case 'abgelehnt':
            return _('Remembered as “no recurring cost”');
        case 'beendet':
            return _('Remembered as ended');
        case 'vorschlag':
            return _('Decision taken back');
    }
}

export class BhLaufendeKostenView extends Adw.Bin {
    declare private _breakpoint_bin: Adw.BreakpointBin;
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _content_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhLaufendeKostenView',
                Template,
                InternalChildren: ['breakpoint_bin', 'stack', 'error_page', 'scroller', 'content_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private entity?: AppEntity;
    private year = 0;

    /** One per visible row — the breakpoint flips them all, see pinnableCluster(). */
    private readonly clusterPins: ((narrow: boolean) => void)[] = [];

    constructor(params?: Partial<Adw.Bin.ConstructorProps>) {
        super(params);
        // The rows are rebuilt on every reload, so the switch has to be re-applied rather than
        // connected once per cluster: `current-breakpoint` fires only when the width crosses 450 px,
        // and a row built afterwards would never hear it.
        this._breakpoint_bin.connect('notify::current-breakpoint', () => {
            for (const pin of this.clusterPins) pin(this.narrow);
        });
    }

    private get narrow(): boolean {
        return this._breakpoint_bin.get_current_breakpoint() !== null;
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Recurring costs could not be loaded'),
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
        // The rows are gone, so are their pins — serieRow() registers the new ones.
        this.clusterPins.length = 0;
        const lernmodus = lernmodusOn();

        const offen = new Adw.PreferencesGroup({
            // markup-ok: numbers / catalogue text only
            title: u.vorschlaege.length ? zuBestaetigenTitel(u.vorschlaege.length) : _('Recurring costs'),
            // markup-ok: numbers / catalogue text only
            description:
                _(
                    'Regular debits to the same recipient, detected from all bookings. Only confirmed ones count in Free to spend and drop out of the money checks.',
                ) + (u.datenstand ? ' ' + fmt(_('Data as of {date}.'), { date: deDate(u.datenstand) }) : ''),
        });
        offen.set_header_suffix(new BhGlossaryHelp('laufende-kosten', lernmodus));
        if (u.vorschlaege.length === 0) {
            offen.add(
                emptyState({
                    icon: 'object-select-symbolic',
                    title: _('Nothing to confirm'),
                    description: u.bestaetigt.length
                        ? _('Every detected series is decided.')
                        : _(
                              'No debits at a fixed interval found — monthly and quarterly need three payments, twice a year and yearly need two.',
                          ),
                }),
            );
        }
        for (const k of u.vorschlaege) offen.add(this.serieRow(k, 'vorschlag'));
        this._content_box.append(offen);

        if (u.bestaetigt.length) {
            const group = new Adw.PreferencesGroup({
                title: _('Confirmed'),
                description: _(
                    'The next expected payment per series — Free to spend subtracts those of the next 30 days.',
                ),
            });
            for (const k of u.bestaetigt) group.add(this.serieRow(k, 'bestaetigt'));
            this._content_box.append(group);
        }
        for (const [titel, liste, art] of [
            [_('No recurring cost'), u.abgelehnt, 'abgelehnt'],
            [_('Ended'), u.beendet, 'beendet'],
        ] as const) {
            if (!liste.length) continue;
            const group = new Adw.PreferencesGroup({ title: titel });
            for (const k of liste) group.add(this.serieRow(k, art));
            this._content_box.append(group);
        }
    }

    private untertitel(k: LaufendeKosten, art: LaufendeKosten['status']): string {
        const teile = [abstandText(k.abstand), fmt(_('last {date}'), { date: deDate(k.zuletzt) })];
        if (art === 'bestaetigt' || art === 'vorschlag') {
            teile.push(
                k.aktiv
                    ? fmt(_('next {date}'), { date: deDate(k.naechste) })
                    : _('ended? — no payment for more than 1.5 intervals'),
            );
        }
        teile.push(fmt(_n('{n} payment', '{n} payments', k.zahlungen.length), { n: k.zahlungen.length }));
        const p = k.preisaenderung;
        if (p)
            teile.push(
                fmt(_('price change on {date}: {from} → {to}'), {
                    date: deDate(p.datum),
                    from: eur(p.von),
                    to: eur(p.auf),
                }),
            );
        if (k.korrigiert)
            teile.push(
                fmt(_('corrected (detected: {interval}, {amount})'), {
                    interval: abstandText(k.erkannterAbstand),
                    amount: eur(k.letzterBetrag),
                }),
            );
        return teile.join(' · ');
    }

    /** One series: amount + actions as suffixes, its payments inside. */
    private serieRow(k: LaufendeKosten, art: LaufendeKosten['status']): Adw.ExpanderRow {
        const row = new Adw.ExpanderRow({ title: markup(k.empfaenger), subtitle: markup(this.untertitel(k, art)) });
        row.set_subtitle_lines(0);
        // One wrapping cluster instead of four separate suffixes — see rowActions().
        const actions = rowActions([amountLabel(eur(k.betrag), { heading: art === 'bestaetigt' })]);
        row.add_suffix(actions);
        // …but only wrap when the view really is narrow, see pinnableCluster().
        this.clusterPins.push(pinnableCluster(actions));
        const knopf = (label: string, tip: string, run: () => void, css?: string) => {
            // An icon label keeps the row's title readable next to three buttons and the amount.
            const icon = label.endsWith('-symbolic');
            const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: `${tip}: ${k.empfaenger}` });
            if (icon) b.set_icon_name(label);
            else b.set_label(label);
            if (css) b.add_css_class(css);
            b.connect('clicked', run);
            // PREPEND, because an Adw.ExpanderRow packs its suffixes from the end: each
            // `add_suffix` landed to the LEFT of the one before it, so the row read
            // „Keine · ✏ · Bestätigen · 12,44 €". Appending into the cluster would silently turn
            // that around and put the amount first — same widgets, mirrored row.
            actions.prepend(b);
        };
        if (art === 'vorschlag') {
            knopf(
                _('Confirm'),
                _('Confirm'),
                () => void this.entscheide(k, { status: 'bestaetigt' }),
                'suggested-action',
            );
            knopf('document-edit-symbolic', _('Correct'), () => void this.korrigieren(k));
            if (!k.aktiv) knopf(_('Ended'), _('Ended'), () => void this.entscheide(k, { status: 'beendet' }));
            knopf(
                _p('button', 'None'),
                _('No recurring cost'),
                () => void this.entscheide(k, { status: 'abgelehnt' }),
                'flat',
            );
        } else {
            if (art === 'bestaetigt')
                knopf('document-edit-symbolic', _('Correct'), () => void this.korrigieren(k), 'flat');
            knopf(_('Take back'), _('Take back'), () => void this.entscheide(k, { status: 'vorschlag' }), 'flat');
        }
        for (const z of [...k.zahlungen].reverse()) {
            const r = new Adw.ActionRow({
                title: markup(deDate(z.datum)),
                subtitle: markup(k.empfaenger),
                activatable: true,
            });
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
            showToast(`${gespeichertText(e.status)}: ${k.empfaenger}`);
            this.reload(entity, this.year);
        } catch (err) {
            await errorDialog(this, _('Decision not saved'), err instanceof Error ? err.message : String(err));
        }
    }

    /** Confirm with a corrected interval and/or amount. */
    private korrigieren(k: LaufendeKosten): Promise<void> {
        const dlg = new Adw.AlertDialog({
            heading: _('Correct the recurring cost'),
            body: fmt(
                _('{name}: detected {interval}, last {amount}. The correction applies to the next expected payment.'),
                { name: k.empfaenger, interval: abstandText(k.erkannterAbstand), amount: eur(k.letzterBetrag) },
            ),
        });
        const group = new Adw.PreferencesGroup();
        const model = new Gtk.StringList();
        for (const a of ABSTAENDE) model.append(abstandText(a));
        const abstand = new Adw.ComboRow({
            title: _p('series', 'Interval'),
            model,
            selected: ABSTAENDE.indexOf(k.abstand),
        });
        const betrag = new Adw.SpinRow({
            title: _('Amount (€)'),
            adjustment: new Gtk.Adjustment({ lower: 0.01, upper: 10_000_000, stepIncrement: 0.01, pageIncrement: 10 }),
            digits: 2,
        });
        betrag.set_value(k.betrag);
        group.add(abstand);
        group.add(betrag);
        dlg.set_extra_child(group);
        dlg.add_response('cancel', _('Cancel'));
        dlg.add_response('confirm', _('Confirm'));
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
            if (!row) throw new Error(_('The booking was not found.'));
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
            await errorDialog(this, _('Booking not opened'), err instanceof Error ? err.message : String(err));
        }
    }
}
