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

import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
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
import { pinNaturalWidth } from '../widgets/responsive.ts';
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
    declare private _switcher: Adw.InlineViewSwitcher;
    /** Re-pin the switcher to its natural width — the tab list is per entity, so it changes. */
    private repinSwitcher?: () => void;
    private readonly views = new Map<string, PortedView>();
    private readonly pages = new Map<string, Adw.ViewStackPage>();
    private readonly businessOnlyIds = new Set<string>();
    private readonly estOnlyIds = new Set<string>();
    private entity?: AppEntity;
    private year = 0;
    /** Tabs already loaded for the current entity/year — avoids re-fetching on every tab switch. */
    private readonly loaded = new Set<string>();

    static {
        GObject.registerClass({ GTypeName: 'BhTabHub', Template, InternalChildren: ['stack', 'switcher'] }, this);
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
        this._stack.connect('notify::visible-child-name', () => {
            this.reloadActive();
            this.revealActiveTab();
        });
        this.repinSwitcher = pinNaturalWidth(this._switcher);
        this._switcher.connect('map', () => this.revealActiveTab());
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
            this.repinSwitcher?.(); // fewer tabs → a narrower switcher, so the old pin is too wide
            this.revealActiveTab();
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

    /**
     * Scroll the tab row so the active tab is on screen.
     *
     * Only matters on a narrow window, where the switcher is wider than the viewport. Tapping a tab
     * scrolls it in by itself (the viewport follows the focus), but a tab selected from code —
     * `showTab()`, the STEUER_APP_TAB hook, or the fallback when the active tab is hidden for a
     * `privat` entity — takes no focus, and the user then saw a tab row scrolled somewhere else.
     *
     * Reaching into the switcher for the n-th toggle is deliberate: the tab's own x position is the
     * only honest answer, and the lookup degrades to "do nothing" if Adwaita ever restructures it.
     */
    private revealActiveTab(): void {
        // On idle, because a tab can be selected before the switcher has been allocated — at that
        // point every toggle still sits at x=0 and the scroll would be a no-op.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.scrollToActiveTab();
            return GLib.SOURCE_REMOVE;
        });
    }

    private scrollToActiveTab(): void {
        const scroller = this._switcher.get_parent()?.get_parent();
        if (!(scroller instanceof Gtk.ScrolledWindow)) return;
        const active = this._stack.get_visible_child_name();
        if (active == null) return;
        const index = [...this.pages].filter(([, p]) => p.visible).findIndex(([id]) => id === active);
        if (index < 0) return;

        // The switcher's box interleaves a Gtk.Separator between the toggles, so the n-th CHILD is
        // not the n-th tab — counting children scrolled to a 1 px separator and looked like a
        // no-op. Collect the toggles themselves instead.
        const toggles: Gtk.Widget[] = [];
        for (let c = this._switcher.get_first_child()?.get_first_child(); c; c = c.get_next_sibling()) {
            if (c instanceof Gtk.ToggleButton) toggles.push(c);
        }
        const [ok, rect] = toggles[index]?.compute_bounds(this._switcher) ?? [false, null];
        if (!ok || !rect) return;

        const adj = scroller.get_hadjustment();
        // Include the margin on the outer tabs, so the first/last one is not flush against the edge.
        const left = Math.max(0, rect.get_x() - 3);
        const right = Math.min(adj.get_upper(), rect.get_x() + rect.get_width() + 3);
        if (left < adj.get_value()) adj.set_value(left);
        else if (right > adj.get_value() + adj.get_page_size()) adj.set_value(right - adj.get_page_size());
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
        { id: 'buchungen', title: _('All'), make: () => new BhTransactionsView() },
        { id: 'zu-pruefen', title: _('To review'), make: () => new BhZuPruefenView(), businessOnly: true },
        { id: 'laufende-kosten', title: _('Recurring costs'), make: () => new BhLaufendeKostenView() },
    ]);

export const makeRechnungenHub = (): BhTabHub =>
    new BhTabHub().configure([
        { id: 'rechnungen', title: _('Invoices'), make: () => new BhRechnungenView() },
        { id: 'forderungen', title: _('Outstanding invoices'), make: () => new BhForderungenView() },
    ]);
