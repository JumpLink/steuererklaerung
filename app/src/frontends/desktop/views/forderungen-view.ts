/**
 * <BhForderungenView> — the „Offene Forderungen" tab of the Rechnungen hub (Idee 12).
 *
 * Open invoices by age (with the sum per customer inside each customer), every open invoice with its
 * Mahnstufe and the presumed Verjährung and a „Mahnung entwerfen" that opens the draft, and how each
 * customer pays (days after the due date: mean, worst case, trend). Everything comes from the app's
 * own invoices and the credits matched to them; nothing is sent from here.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './forderungen-view.blp';
import {
    alterKlassen,
    forderungenTitel,
    loadForderungen,
    mahnstufeLabel,
    ueberfaellige,
    type ForderungenUebersicht,
    type KundenVerhalten,
    type OffenerPosten,
} from '../../../core/presenters/forderungen.ts';
import { loadInvoicingBlock } from '../../../core/presenters/rechnungen.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, amountLabel, applyScrollHook, emptyState, kpiFlow, loadIntoStack, markup } from './util.ts';
import { BhMahnungDialog } from './mahnung-dialog.ts';
import { helpFor } from '../widgets/glossary-help.ts';
import { _, _n, _p, fmt } from '../i18n.ts';

function trendText(trend: 'langsamer' | 'schneller' | 'gleich'): string {
    if (trend === 'langsamer') return _('pays later and later');
    if (trend === 'schneller') return _('pays earlier and earlier');
    return _('steady');
}

const tage = (n: number): string =>
    fmt(_n('{days} day', '{days} days', Math.abs(n) === 1 ? 1 : 2), { days: n.toLocaleString('de-DE') });

/** „Handeln bis …" / „vermutlich verjährt seit …" for one open item; null without any date to compute from. */
function verjaehrungText(p: OffenerPosten): string | null {
    const v = p.verjaehrung;
    if (!v) return null;
    if (v.status === 'verjaehrt') return fmt(_('presumably time-barred since {date}'), { date: deDate(v.handelnBis) });
    const bis = fmt(_('act by {date}'), { date: deDate(v.handelnBis) });
    return v.status === 'bald' ? `${bis} ${_('(soon)')}` : bis;
}

/** „12,4 Tage nach Fälligkeit", or „… vor" for a customer that pays early on average. */
function mittelText(n: number): string {
    return n >= 0
        ? fmt(_('{days} after the due date'), { days: tage(n) })
        : fmt(_('{days} before the due date'), { days: tage(-n) });
}

export class BhForderungenView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _content_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhForderungenView',
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
        const block = loadInvoicingBlock(entity.id);
        if (block) {
            this.token.next();
            this._error_page.set_title(_('No outgoing invoices'));
            this._error_page.set_description(block);
            this._stack.set_visible_child_name('error');
            return;
        }
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Open receivables could not be loaded'),
            load: () => loadForderungen(entity.id),
            fill: (u) => {
                this.render(entity, u);
                applyScrollHook(this._scroller);
                if (process.env.STEUER_APP_DEBUG) {
                    console.error(`[app] Forderungen ok: ${u.posten.length} offen, ${u.verhalten.length} Kunden`);
                }
            },
        });
    }

    private render(entity: AppEntity, u: ForderungenUebersicht): void {
        for (let c = this._content_box.get_first_child(); c; c = this._content_box.get_first_child()) {
            this._content_box.remove(c);
        }
        if (u.posten.length === 0 && u.verhalten.length === 0 && u.vermutlichBezahlt.length === 0) {
            this._content_box.append(
                emptyState({
                    icon: 'object-select-symbolic',
                    title: _('No open receivables'),
                    description: _('As soon as an outgoing invoice is finalised and not yet paid, it appears here.'),
                }),
            );
            return;
        }
        const ueberfaellig = ueberfaellige(u.posten);
        const faellig = u.posten.filter((p) => p.mahnungFaellig).length;
        this._content_box.append(
            kpiFlow([
                {
                    label: _('Open'),
                    value: eur(u.alter.gesamt.summe),
                    sub: fmt(_n('{n} invoice', '{n} invoices', u.alter.gesamt.anzahl), { n: u.alter.gesamt.anzahl }),
                },
                {
                    label: _('Overdue'),
                    value: eur(ueberfaellig.reduce((s, p) => s + p.offen, 0)),
                    accent: ueberfaellig.length ? 'error' : undefined,
                    sub: forderungenTitel(ueberfaellig.length),
                },
                { label: _('Reminder due'), value: String(faellig), sub: _('next stage due') },
            ]),
        );
        this._content_box.append(this.alterGroup(u));
        this._content_box.append(this.postenGroup(entity, u));
        if (u.vermutlichBezahlt.length) this._content_box.append(this.vermutlichGroup(u));
        this._content_box.append(this.verhaltenGroup(u.verhalten));
    }

    /** Buckets as rows; every bucket unfolds into the customers' sums. */
    private alterGroup(u: ForderungenUebersicht): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: _('Open items by age'),
            description: _('Days past the due date; calculated on the balance left after partial payments.'),
        });
        for (const k of alterKlassen()) {
            const klasse = u.alter.klassen.find((x) => x.key === k.key);
            if (!klasse) continue;
            const row = new Adw.ExpanderRow({
                title: markup(k.label),
                subtitle: klasse.anzahl
                    ? fmt(_n('{n} invoice', '{n} invoices', klasse.anzahl), { n: klasse.anzahl })
                    : _('none'),
            });
            row.add_suffix(
                amountLabel(eur(klasse.summe), {
                    accent: k.key === 'ueber_90' && klasse.summe > 0 ? 'error' : undefined,
                }),
            );
            if (!klasse.anzahl) row.set_enable_expansion(false);
            for (const kunde of u.alter.kunden) {
                const summe = kunde.summen[k.key];
                if (!summe) continue;
                const r = new Adw.ActionRow({ title: markup(kunde.kunde) });
                r.add_suffix(amountLabel(eur(summe)));
                row.add_row(r);
            }
            group.add(row);
        }
        const total = new Adw.ActionRow({ title: _p('receivables', 'Total') });
        total.add_suffix(amountLabel(eur(u.alter.gesamt.summe), { heading: true }));
        group.add(total);
        return group;
    }

    private postenGroup(entity: AppEntity, u: ForderungenUebersicht): Gtk.Widget {
        const group = helpFor(
            helpFor(
                new Adw.PreferencesGroup({
                    title: _('Open invoices'),
                    description: _(
                        'Reminder stage and limitation period per invoice. “Draft a reminder” only produces a text — you send it yourself.',
                    ),
                }),
                'mahnstufe',
            ),
            'verjaehrung',
        );
        if (u.posten.length === 0) {
            group.add(
                emptyState({
                    icon: 'object-select-symbolic',
                    title: _('Nothing open'),
                    description: _('All invoices are paid.'),
                }),
            );
        }
        for (const p of u.posten) group.add(this.postenRow(entity, p));
        return group;
    }

    private postenRow(entity: AppEntity, p: OffenerPosten): Adw.ActionRow {
        const faellig =
            p.tageUeberfaellig != null && p.tageUeberfaellig > 0
                ? fmt(_('{days} overdue'), { days: tage(p.tageUeberfaellig) })
                : p.dueDate
                  ? _('not due yet')
                  : _('no due date');
        const zeilen = [
            p.dueDate ? `${fmt(_('due {date}'), { date: deDate(p.dueDate) })} · ${faellig}` : faellig,
            p.bezahlt > 0 ? fmt(_('{paid} of {total} received'), { paid: eur(p.bezahlt), total: eur(p.brutto) }) : null,
            [
                mahnstufeLabel(p.mahnstufe) +
                    (p.letzteMahnungAm ? ` ${fmt(_('(sent {date})'), { date: deDate(p.letzteMahnungAm) })}` : ''),
                p.entworfenStufe ? fmt(_('stage {n} drafted, not marked as sent'), { n: p.entworfenStufe }) : null,
                p.mahnungFaellig ? fmt(_('stage {n} is due'), { n: String(p.naechsteStufe) }) : null,
            ]
                .filter(Boolean)
                .join(' · '),
            verjaehrungText(p),
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(`${p.nummer ?? p.rechnungId} · ${p.kunde}`),
            subtitle: markup(zeilen.join('\n')),
        });
        row.set_subtitle_lines(0);
        row.add_suffix(amountLabel(eur(p.offen), { accent: (p.tageUeberfaellig ?? 0) > 90 ? 'error' : undefined }));
        if ((p.tageUeberfaellig ?? 0) > 0) {
            const btn = new Gtk.Button({
                label: _('Draft a reminder'),
                valign: Gtk.Align.CENTER,
                tooltipText: fmt(_('Draft a reminder: {invoice}'), { invoice: p.nummer ?? p.rechnungId }),
            });
            if (p.mahnungFaellig) btn.add_css_class('suggested-action');
            btn.connect('clicked', () => {
                const dialog = new BhMahnungDialog();
                dialog.onChanged = () => this.reload(entity, this.year);
                dialog.open(this, entity, p);
            });
            row.add_suffix(btn);
        }
        return row;
    }

    private vermutlichGroup(u: ForderungenUebersicht): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: _('Presumably already paid'),
            description: _(
                'Incoming payments carrying the invoice number cover the full amount, but the invoice is not marked as paid — no reminder is sent for it.',
            ),
        });
        for (const r of u.vermutlichBezahlt) {
            const row = new Adw.ActionRow({ title: markup(r.nummer ?? r.rechnungId), subtitle: markup(r.kunde) });
            row.add_suffix(amountLabel(eur(r.brutto)));
            group.add(row);
        }
        return group;
    }

    private verhaltenGroup(verhalten: KundenVerhalten[]): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: _('Payment behaviour per customer'),
            description: _(
                'Payment date minus due date, across the paid invoices. The trend compares the last two with the earlier ones, from four paid invoices on.',
            ),
        });
        if (verhalten.length === 0) {
            group.add(
                emptyState({
                    icon: 'view-list-symbolic',
                    title: _('No paid invoices yet'),
                    description: _(
                        'As soon as invoices with a due date and a payment date are paid, this shows how quickly each customer pays.',
                    ),
                }),
            );
        }
        for (const v of verhalten) {
            const teile = [
                `Ø ${mittelText(v.mittel)}`,
                fmt(_('worst case {value}'), { value: mittelText(v.schlimmster) }),
                fmt(_('{n} paid'), { n: v.anzahl }),
                v.trend ? fmt(_('Trend: {trend}'), { trend: trendText(v.trend) }) : null,
            ].filter(Boolean);
            const row = new Adw.ActionRow({ title: markup(v.kunde), subtitle: markup(teile.join(' · ')) });
            row.set_subtitle_lines(0);
            group.add(row);
        }
        return group;
    }
}
