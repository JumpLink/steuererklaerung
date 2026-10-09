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
    ALTER_KLASSEN,
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

const TREND_TEXT = {
    langsamer: 'zahlt zunehmend später',
    schneller: 'zahlt zunehmend früher',
    gleich: 'gleichbleibend',
};

const tage = (n: number): string => `${n.toLocaleString('de-DE')} ${Math.abs(n) === 1 ? 'Tag' : 'Tage'}`;

/** „Handeln bis …" / „vermutlich verjährt seit …" for one open item; null without any date to compute from. */
function verjaehrungText(p: OffenerPosten): string | null {
    const v = p.verjaehrung;
    if (!v) return null;
    return v.status === 'verjaehrt'
        ? `vermutlich verjährt seit ${deDate(v.handelnBis)}`
        : `Handeln bis ${deDate(v.handelnBis)}${v.status === 'bald' ? ' (bald)' : ''}`;
}

/** „12,4 Tage nach Fälligkeit", or „… vor" for a customer that pays early on average. */
function mittelText(n: number): string {
    return n >= 0 ? `${tage(n)} nach Fälligkeit` : `${tage(-n)} vor Fälligkeit`;
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
            this._error_page.set_title('Keine Ausgangsrechnungen');
            this._error_page.set_description(block);
            this._stack.set_visible_child_name('error');
            return;
        }
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Offene Forderungen konnten nicht geladen werden',
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
                    icon: 'emblem-ok-symbolic',
                    title: 'Keine offenen Forderungen',
                    description:
                        'Sobald eine Ausgangsrechnung festgeschrieben ist und noch nicht bezahlt, steht sie hier.',
                }),
            );
            return;
        }
        const ueberfaellig = ueberfaellige(u.posten);
        const faellig = u.posten.filter((p) => p.mahnungFaellig).length;
        this._content_box.append(
            kpiFlow([
                { label: 'Offen', value: eur(u.alter.gesamt.summe), sub: `${u.alter.gesamt.anzahl} Rechnung(en)` },
                {
                    label: 'Überfällig',
                    value: eur(ueberfaellig.reduce((s, p) => s + p.offen, 0)),
                    accent: ueberfaellig.length ? 'error' : undefined,
                    sub: forderungenTitel(ueberfaellig.length),
                },
                { label: 'Mahnung fällig', value: String(faellig), sub: 'nächste Stufe fällig' },
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
            title: 'Offene Posten nach Alter',
            description: 'Tage nach der Fälligkeit; gerechnet auf den offenen Rest nach Teilzahlungen.',
        });
        for (const k of ALTER_KLASSEN) {
            const klasse = u.alter.klassen.find((x) => x.key === k.key);
            if (!klasse) continue;
            const row = new Adw.ExpanderRow({
                title: markup(k.label),
                subtitle: klasse.anzahl ? `${klasse.anzahl} Rechnung(en)` : 'keine',
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
        const total = new Adw.ActionRow({ title: 'Gesamt' });
        total.add_suffix(amountLabel(eur(u.alter.gesamt.summe), { heading: true }));
        group.add(total);
        return group;
    }

    private postenGroup(entity: AppEntity, u: ForderungenUebersicht): Gtk.Widget {
        const group = helpFor(
            helpFor(
                new Adw.PreferencesGroup({
                    title: 'Offene Rechnungen',
                    description:
                        'Mahnstufe und Verjährung je Rechnung. „Mahnung entwerfen" erzeugt nur einen Text — ' +
                        'versendet wird er von dir.',
                }),
                'mahnstufe',
            ),
            'verjaehrung',
        );
        if (u.posten.length === 0) {
            group.add(
                emptyState({
                    icon: 'emblem-ok-symbolic',
                    title: 'Nichts offen',
                    description: 'Alle Rechnungen sind bezahlt.',
                }),
            );
        }
        for (const p of u.posten) group.add(this.postenRow(entity, p));
        return group;
    }

    private postenRow(entity: AppEntity, p: OffenerPosten): Adw.ActionRow {
        const faellig =
            p.tageUeberfaellig != null && p.tageUeberfaellig > 0
                ? `${tage(p.tageUeberfaellig)} überfällig`
                : p.dueDate
                  ? 'noch nicht fällig'
                  : 'ohne Fälligkeit';
        const zeilen = [
            p.dueDate ? `fällig ${deDate(p.dueDate)} · ${faellig}` : faellig,
            p.bezahlt > 0 ? `${eur(p.bezahlt)} von ${eur(p.brutto)} eingegangen` : null,
            [
                mahnstufeLabel(p.mahnstufe) + (p.letzteMahnungAm ? ` (versandt ${deDate(p.letzteMahnungAm)})` : ''),
                p.entworfenStufe ? `Stufe ${p.entworfenStufe} entworfen, nicht als versandt markiert` : null,
                p.mahnungFaellig ? `Stufe ${p.naechsteStufe} ist fällig` : null,
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
                label: 'Mahnung entwerfen',
                valign: Gtk.Align.CENTER,
                tooltipText: `Mahnung entwerfen: ${p.nummer ?? p.rechnungId}`,
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
            title: 'Vermutlich schon bezahlt',
            description:
                'Zahlungseingänge mit der Rechnungsnummer decken den ganzen Betrag, die Rechnung ist aber nicht als ' +
                'bezahlt markiert — sie wird nicht gemahnt.',
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
            title: 'Zahlungsverhalten je Kunde',
            description:
                'Zahlungsdatum minus Fälligkeit, über die bezahlten Rechnungen. Der Trend vergleicht die letzten zwei ' +
                'mit den früheren, ab vier bezahlten Rechnungen.',
        });
        if (verhalten.length === 0) {
            group.add(
                emptyState({
                    icon: 'view-list-symbolic',
                    title: 'Noch keine bezahlten Rechnungen',
                    description:
                        'Sobald Rechnungen mit Fälligkeit und Zahlungsdatum bezahlt sind, steht hier, wie schnell jeder Kunde zahlt.',
                }),
            );
        }
        for (const v of verhalten) {
            const teile = [
                `Ø ${mittelText(v.mittel)}`,
                `schlimmster Fall ${mittelText(v.schlimmster)}`,
                `${v.anzahl} bezahlt`,
                v.trend ? `Trend: ${TREND_TEXT[v.trend]}` : null,
            ].filter(Boolean);
            const row = new Adw.ActionRow({ title: markup(v.kunde), subtitle: markup(teile.join(' · ')) });
            row.set_subtitle_lines(0);
            group.add(row);
        }
        return group;
    }
}
