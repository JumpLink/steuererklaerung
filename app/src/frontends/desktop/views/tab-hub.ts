/**
 * Native tab hubs — the GTK counterpart of the web bh-tab-hub. Each hub consolidates several existing
 * views under one nav entry (the v2 IA: 15 → 9) using an Adw.ViewStack + Adw.ViewSwitcher. Pure
 * composition: the sub-views are the same PortedView instances, lazily reloaded when their tab
 * becomes visible (and on entity/year change).
 *
 * ONE registered GObject class configured per instance (`new BhTabHub().configure([...])`) — GJS
 * cannot registerClass a subclass whose parent isn't itself a registered GObject, so we avoid an
 * abstract base and hand the tab list in instead.
 */

import GObject from '@girs/gobject-2.0';
import Adw from '@girs/adw-1';

import type { PortedView } from '../view.ts';
import type { AppEntity } from '../entities.ts';
import { BhSteuererklaerungView } from './steuererklaerung-view.ts';
import { BhSteuerAssistentView } from './steuer-assistent-view.ts';
import { BhSteuerView } from './steuer-view.ts';
import { BhAnlagenView } from './anlagen-view.ts';
import { BhUstvaView } from './ustva-view.ts';
import { BhSteuerkontoView } from './steuerkonto-view.ts';
import { BhBelegEingangView } from './beleg-eingang-view.ts';
import { BhOffeneBelegeView } from './offene-belege-view.ts';
import { BhDokumenteView } from './dokumente-view.ts';
import { BhTransactionsView } from './transactions-view.ts';
import { BhZuPruefenView } from './zu-pruefen-view.ts';
import { BhLaufendeKostenView } from './laufende-kosten-view.ts';
import { BhRechnungenView } from './rechnungen-view.ts';
import { BhForderungenView } from './forderungen-view.ts';
import { isSearchable } from '../shortcuts.ts';
import { _ } from '../i18n.ts';

import Template from './tab-hub.blp';

interface HubTab {
    id: string;
    title: string;
    make: () => PortedView;
    /** Hidden for a `privat` entity (business-only report — e.g. EÜR/USt-VA/Steuerkonto). */
    businessOnly?: boolean;
    /** Hidden unless the entity has a private-ESt config (e.g. the Einkommensteuer-Assistent). */
    estOnly?: boolean;
}

export class BhTabHub extends Adw.Bin {
    declare private _stack: Adw.ViewStack;
    private readonly views = new Map<string, PortedView>();
    private readonly pages = new Map<string, Adw.ViewStackPage>();
    private readonly businessOnlyIds = new Set<string>();
    private readonly estOnlyIds = new Set<string>();
    private entity?: AppEntity;
    private year = 0;
    /** Tabs already loaded for the current entity/year — avoids re-fetching on every tab switch. */
    private readonly loaded = new Set<string>();

    static {
        GObject.registerClass({ GTypeName: 'BhTabHub', Template, InternalChildren: ['stack'] }, this);
    }

    /** Add the tabs. Returns `this` so the registry can `new BhTabHub().configure([...])`. */
    configure(tabs: HubTab[]): this {
        for (const t of tabs) {
            const view = t.make();
            this.views.set(t.id, view);
            this.pages.set(t.id, this._stack.add_titled(view, t.id, t.title));
            if (t.businessOnly) this.businessOnlyIds.add(t.id);
            if (t.estOnly) this.estOnlyIds.add(t.id);
        }
        this._stack.connect('notify::visible-child-name', () => this.reloadActive());
        // Dev/testing hook: land on a specific sub-tab (mirrors STEUER_APP_VIEW for the nav), e.g.
        // STEUER_APP_TAB=euer to open the EÜR tab of the Steuer hub.
        const wantedTab = process.env.STEUER_APP_TAB;
        if (wantedTab && this.pages.has(wantedTab)) this._stack.set_visible_child_name(wantedTab);
        return this;
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        this.loaded.clear(); // entity/year changed → every tab is stale
        // Per-entity tab visibility: a `privat` entity has no business reports (hide EÜR/USt-VA/
        // Steuerkonto); a business entity has no private-ESt (hide the Einkommensteuer-Assistent).
        if (this.businessOnlyIds.size > 0 || this.estOnlyIds.size > 0) {
            const privat = entity.kind === 'privat';
            const hidden = new Set<string>();
            if (privat) for (const id of this.businessOnlyIds) hidden.add(id);
            if (!entity.hasEst) for (const id of this.estOnlyIds) hidden.add(id);
            for (const [id, page] of this.pages) page.visible = !hidden.has(id);
            const active = this._stack.get_visible_child_name();
            if (active != null && hidden.has(active)) {
                const firstVisible = [...this.views.keys()].find((id) => !hidden.has(id));
                if (firstVisible) this._stack.set_visible_child_name(firstVisible);
            }
        }
        this.reloadActive();
    }

    /** Show one tab by id (`win.navigate("view/tab")`); unknown or hidden ids are ignored. */
    showTab(id: string): void {
        if (this.pages.get(id)?.visible) this._stack.set_visible_child_name(id);
    }

    /** Ctrl+F reaches the search box of the visible tab, when it has one. */
    focusSearch(): void {
        const id = this._stack.get_visible_child_name();
        const view = id ? this.views.get(id) : undefined;
        if (isSearchable(view)) view.focusSearch();
    }

    private reloadActive(): void {
        if (!this.entity) return;
        const id = this._stack.get_visible_child_name();
        if (!id || this.loaded.has(id)) return;
        this.views.get(id)?.reload(this.entity, this.year);
        this.loaded.add(id);
    }
}

export const makeSteuerHub = (): BhTabHub =>
    new BhTabHub().configure([
        { id: 'erklaerung', title: _('Tax return'), make: () => new BhSteuererklaerungView() },
        { id: 'assistent', title: _('Assistant'), make: () => new BhSteuerAssistentView(), estOnly: true },
        { id: 'euer', title: 'EÜR', make: () => new BhSteuerView(), businessOnly: true },
        { id: 'anlagen', title: _('Annexes'), make: () => new BhAnlagenView(), businessOnly: true },
        { id: 'ustva', title: 'USt-VA', make: () => new BhUstvaView(), businessOnly: true },
        { id: 'steuerkonto', title: _('Tax account'), make: () => new BhSteuerkontoView(), businessOnly: true },
    ]);

export const makeReviewHub = (): BhTabHub =>
    new BhTabHub().configure([
        { id: 'eingang', title: _('Inbox'), make: () => new BhBelegEingangView() },
        { id: 'offen', title: _('Open receipts'), make: () => new BhOffeneBelegeView() },
        { id: 'alle', title: _('All receipts'), make: () => new BhDokumenteView() },
    ]);

export const makeBuchungenHub = (): BhTabHub =>
    new BhTabHub().configure([
        { id: 'buchungen', title: 'Alle', make: () => new BhTransactionsView() },
        { id: 'zu-pruefen', title: 'Zu prüfen', make: () => new BhZuPruefenView(), businessOnly: true },
        { id: 'laufende-kosten', title: 'Laufende Kosten', make: () => new BhLaufendeKostenView() },
    ]);

export const makeRechnungenHub = (): BhTabHub =>
    new BhTabHub().configure([
        { id: 'rechnungen', title: 'Rechnungen', make: () => new BhRechnungenView() },
        { id: 'forderungen', title: 'Offene Forderungen', make: () => new BhForderungenView() },
    ]);
