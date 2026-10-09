/**
 * <BhSteuerkontoView> — the Zahlungen / Steuerkonto view.
 *
 * Mirrors the web "Zahlungen" (bh-steuerkonto-view): the actual tax flows to/from the authorities
 * over this entity's accounts. A summary (gezahlt · erstattet · Netto), an internal-reserve banner,
 * then one expander per tax type (USt/GewSt/ESt/Sonstige) revealing the individual bookings.
 * Pure store (see presenters/steuer.ts `loadSteuerkonto`) — a fast synchronous load.
 */

import Adw from '@girs/adw-1';
import type Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './steuerkonto-view.blp';
import { loadSteuerkonto, type SteuerkontoReport } from '../../../core/presenters/steuer.ts';
import { appSession } from '../data/session.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { GroupRows, LoadToken, amountLabel, loadIntoStack, markup } from './util.ts';

export class BhSteuerkontoView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _reserve_banner: Adw.Banner;
    declare private _summary_group: Adw.PreferencesGroup;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhSteuerkontoView',
                Template,
                InternalChildren: ['stack', 'error_page', 'reserve_banner', 'summary_group', 'list_group'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly summary: GroupRows;
    private readonly list: GroupRows;

    constructor() {
        super();
        this.summary = new GroupRows(this._summary_group);
        this.list = new GroupRows(this._list_group);
    }

    reload(entity: AppEntity, year: number): void {
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Steuerzahlungen konnten nicht geladen werden',
            load: () => loadSteuerkonto(appSession(), entity, year),
            fill: (report) => this.fill(report),
        });
    }

    private fill(r: SteuerkontoReport): void {
        this.fillBanner(r);
        this.fillSummary(r);
        this.fillGroups(r);
        if (process.env.STEUER_APP_DEBUG) {
            const posten = r.groups.reduce((s, g) => s + g.items.length, 0);
            console.error(`[app] Steuerkonto ${r.year} ok: ${r.groups.length} Gruppen, ${posten} Posten`);
        }
    }

    private fillBanner(r: SteuerkontoReport): void {
        const n = r.internalReserve.count;
        if (n > 0) {
            this._reserve_banner.set_title(
                `${n} interne Umbuchung${n === 1 ? '' : 'en'} auf das Steuer-Unterkonto · ${eur(r.internalReserve.out)}`,
            );
            this._reserve_banner.set_revealed(true);
        } else {
            this._reserve_banner.set_revealed(false);
        }
    }

    private fillSummary(r: SteuerkontoReport): void {
        this.summary.clear();
        this._summary_group.set_title(`Steuer-Zahlungen ${r.year}`);
        const gezahlt = r.groups.reduce((s, g) => s + g.gezahlt, 0);
        const erstattet = r.groups.reduce((s, g) => s + g.erstattet, 0);
        const netto = r.groups.reduce((s, g) => s + g.netto, 0);

        const add = (title: string, value: string, accent?: 'success' | 'error', heading?: boolean) => {
            this.summary.add(new Adw.ActionRow({ title })).add_suffix(amountLabel(value, { accent, heading }));
        };
        add('an Finanzamt gezahlt', eur(gezahlt));
        add('erstattet', eur(erstattet));
        add('Netto', eur(netto), netto >= 0 ? 'success' : 'error', true);
    }

    private fillGroups(r: SteuerkontoReport): void {
        this.list.clear();
        if (r.groups.length === 0) {
            this.list.add(new Adw.ActionRow({ title: 'Keine Steuerzahlungen gefunden' }));
            return;
        }
        for (const g of r.groups) {
            const entityLabel = r.entities[g.entity] ?? g.entity;
            const expander = this.list.add(
                new Adw.ExpanderRow({
                    title: markup(g.art),
                    subtitle: markup(
                        `${entityLabel} · ${g.items.length} Buchung${g.items.length === 1 ? '' : 'en'} · ` +
                            `gezahlt ${eur(g.gezahlt)} · erstattet ${eur(g.erstattet)}`,
                    ),
                }),
            );
            expander.add_action(
                amountLabel(eur(g.netto), { accent: g.netto >= 0 ? 'success' : 'error', heading: true }),
            );
            for (const it of g.items) {
                const sub = [deDate(it.bookingDate), it.bezugsjahr ? `Bezug ${it.bezugsjahr}` : null].filter(Boolean);
                const row = new Adw.ActionRow({
                    title: markup(it.counterparty?.trim() || it.purpose?.trim() || g.art),
                    subtitle: markup(sub.join('  ·  ')),
                });
                row.add_suffix(amountLabel(eur(it.amount), { accent: it.amount < 0 ? 'error' : 'success' }));
                expander.add_row(row);
            }
        }
    }
}
