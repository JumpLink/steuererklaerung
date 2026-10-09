// <bh-app> — review-UI shell: Adwaita header bar + responsive sidebar nav
// (adw-overlay-split-view: docked on desktop, overlay on mobile) + content host.
// On phones a bottom nav (adw-view-switcher-bar over a data-only adw-view-stack)
// mirrors the 5 primary destinations — Sidebar → Drawer → Bottom-Bar, matching the
// native app's adaptive chrome.
// Holds the global state (active entity, view, year, theme) and mounts the active view.
// Multi-entity: the header has a firm switcher; the sidebar shows the active firm's
// identity; the Steuer nav appears only for entities with an ELSTER config.

import type { Adw, Gtk } from '@gjsify/adwaita-web';
import { api, type EntityMeta } from '../lib/api.ts';
import { esc } from '../lib/format.ts';
import { printReport } from '../lib/report.ts';
import { q } from '../lib/dom.ts';

type View =
    | 'home'
    | 'review'
    | 'auswertungen'
    | 'assistent'
    | 'transactions'
    | 'dokumente'
    | 'belege'
    | 'rechnungen'
    | 'kontakte'
    | 'steuer'
    | 'steuererklaerung'
    | 'ustva'
    | 'fristen'
    | 'steuerkonto'
    | 'konten'
    | 'settings';

const VIEW_TAG: Record<View, string> = {
    home: 'bh-home-view',
    review: 'bh-review-hub',
    auswertungen: 'bh-auswertungen-view',
    assistent: 'bh-assistent-view',
    transactions: 'bh-transactions-view',
    dokumente: 'bh-documents-view',
    belege: 'bh-belege-view',
    rechnungen: 'bh-rechnungen-view',
    kontakte: 'bh-kontakte-view',
    steuer: 'bh-steuer-hub',
    steuererklaerung: 'bh-steuererklaerung-view',
    ustva: 'bh-ustva-view',
    fristen: 'bh-fristen-view',
    steuerkonto: 'bh-steuerkonto-view',
    konten: 'bh-konten-view',
    settings: 'bh-settings-view',
};

/** One sidebar entry. The emoji `ico` is rendered inline in the item title (the
 * shipped symbolic-icon set is too sparse for a clean per-view mapping — revisit
 * with `icon-name`s once more land). Items are filtered per entity in visibleViews(). */
interface NavItem {
    view: View;
    ico: string;
    label: string;
    sub: string;
}

// v2 information architecture: 9 top-level entries. The Steuer/Beleg-Eingang entries are tab hubs
// (bh-*-hub) that consolidate the former standalone views; Auswertungen is one stacked screen (BWA +
// Einblicke); the Assistent moved to a header toggle/panel and Fristen folded into the Übersicht
// "Als Nächstes" list.
const NAV_ITEMS: NavItem[] = [
    { view: 'home', ico: '⌂', label: 'Übersicht', sub: 'KPIs & Trends' },
    { view: 'review', ico: '📥', label: 'Beleg-Eingang', sub: 'Belege prüfen & zuordnen' },
    { view: 'transactions', ico: '≣', label: 'Buchungen', sub: 'alle Konten' },
    { view: 'rechnungen', ico: '🧾', label: 'Rechnungen', sub: 'offene Posten & Status' },
    { view: 'kontakte', ico: '👥', label: 'Kontakte', sub: 'Kunden & Lieferanten' },
    { view: 'auswertungen', ico: '▦', label: 'Auswertungen', sub: 'BWA · Einblicke' },
    { view: 'steuer', ico: '§', label: 'Steuer', sub: 'Erklärung · EÜR · USt-VA · Konto' },
    { view: 'konten', ico: '⚯', label: 'Konten', sub: 'Anbindungen & Import' },
    { view: 'settings', ico: '⚙', label: 'Einstellungen', sub: 'Assistent & MCP' },
];

const MOBILE = '(max-width: 820px)';

/** The compact bottom-nav destinations (phones): a 5-entry subset of NAV_ITEMS. The hamburger
 * drawer still reaches the full set. Filtered through visibleViews() so the same per-entity
 * gating applies (privat hides Belege; Steuer needs ELSTER/ESt). */
const BOTTOM_NAV_VIEWS: View[] = ['home', 'review', 'transactions', 'steuer', 'konten'];
/** Shorter labels for the tight bottom bar where the sidebar label ("Beleg-Eingang") is too long. */
const BOTTOM_NAV_LABEL: Partial<Record<View, string>> = { review: 'Belege' };

/** Entity kind → German label for the sidebar identity block. */
const KIND_LABEL: Record<string, string> = {
    gbr: 'GbR',
    einzelunternehmen: 'Einzelunternehmen',
    privat: 'Privat',
};

export class BhApp extends HTMLElement {
    private view: View = 'home';
    private entities: EntityMeta[] = [];
    private entityId = '';
    private year = 2025;
    // Deep-link year (?year=), honoured once on the first entity render then dropped so a later
    // entity switch doesn't clobber a year the user has since picked (that choice lives in localStorage).
    private pendingUrlYear: number | null = Number(new URL(location.href).searchParams.get('year')) || null;
    private assistant = true;
    private mq = window.matchMedia(MOBILE);

    connectedCallback() {
        this.render();
        this.applyResponsive();
        this.mq.addEventListener('change', () => this.applyResponsive());
        // The settings view toggles the assistant at runtime → re-evaluate its nav item.
        document.addEventListener('bh-settings-saved', () => void this.refreshAssistantNav());
        // Cross-view deep-links from a child view (e.g. a Steuererklärung step's "öffnen" button).
        this.addEventListener('bh-navigate', (e) => this.navigateTo((e as CustomEvent<{ view: string }>).detail.view));
        // loadMeta() populates the entity + year selectors, then mounts.
        void this.loadMeta();
    }

    private get osv(): Adw.OverlaySplitView {
        return this.querySelector('adw-overlay-split-view') as unknown as Adw.OverlaySplitView;
    }

    private get activeEntity(): EntityMeta | undefined {
        return this.entities.find((e) => e.id === this.entityId);
    }

    private get entityDrop(): Gtk.DropDown | null {
        return q<Gtk.DropDown>(this, '[data-act="entity"]');
    }

    private get yearDrop(): Gtk.DropDown | null {
        return q<Gtk.DropDown>(this, '[data-act="year"]');
    }

    private render() {
        this.innerHTML = `
      <adw-header-bar>
        <button slot="start" class="adw-button flat bh-icon" data-act="menu" aria-label="Menü">☰</button>
        <adw-window-title slot="center" data-el="viewtitle" title="Übersicht"></adw-window-title>
        <div slot="end" class="bh-toolbar">
          <gtk-drop-down class="bh-entity-select" data-act="entity" aria-label="Firma"></gtk-drop-down>
          <gtk-drop-down class="bh-year-select" data-act="year" aria-label="Jahr"></gtk-drop-down>
          <button class="adw-button suggested-action" data-act="pdf" title="PDF-Bericht zum Weitergeben">PDF</button>
          <gtk-menu-button data-act="appmenu" icon-name="open-menu" menu-title="Menü"></gtk-menu-button>
        </div>
      </adw-header-bar>
      <adw-banner data-el="demo-banner" title="Demodaten – fiktive Beispieldaten, keine echten Finanzdaten"></adw-banner>
      <adw-about-dialog data-el="about" application-name="Steuererklärung" developer-name="JumpLink"
        website="https://github.com/JumpLink" copyright="© 2026 Pascal Garber"
        comments="Steuererklärung im Selbstservice: Qonto · Paperless-ngx · ELSTER. Diese Oberfläche zeigt die Ergebnisse von CLI &amp; MCP schreibgeschützt an."></adw-about-dialog>
      <adw-overlay-split-view sidebar-position="start" min-sidebar-width="220"
        max-sidebar-width="280" sidebar-width-fraction="0.2" show-sidebar>
        <nav slot="sidebar" class="bh-nav">
          <div class="bh-entity-id">
            <div class="bh-entity-name" data-el="entity-name">—</div>
            <div class="bh-entity-kind" data-el="entity-kind"></div>
          </div>
          <div data-el="sidebar-host"></div>
        </nav>
        <main slot="content" class="bh-content"></main>
      </adw-overlay-split-view>
      <div class="bh-bottomnav" data-el="bottomnav-host"></div>
    `;

        // gtk-drop-down emits `change` (user-initiated only, since @gjsify/adwaita-web 0.16.4) with
        // { index, value, label }. Programmatic `.selectedValue`/`.model` sets stay silent, so we
        // don't need to guard them — a value set no longer masquerades as a user action.
        this.entityDrop?.addEventListener('change', (e) => {
            this.entityId = (e as CustomEvent<{ value: string }>).detail.value;
            localStorage.setItem('bh-entity', this.entityId);
            this.applyEntity();
            this.mountView();
        });
        this.yearDrop?.addEventListener('change', (e) => {
            this.year = Number((e as CustomEvent<{ value: string }>).detail.value);
            localStorage.setItem('bh-year', String(this.year));
            this.mountView();
        });

        // Overflow app menu (gtk-menu-button) — secondary actions moved out of the toolbar.
        const menu = q<Gtk.MenuButton>(this, '[data-act="appmenu"]');
        menu?.addEventListener('menu-item-activated', (e) => {
            switch ((e as CustomEvent<{ id: string }>).detail.id) {
                case 'theme':
                    this.toggleTheme();
                    break;
                case 'about':
                    this.showAbout();
                    break;
            }
        });
        this.updateAppMenu();

        this.querySelector('[data-act="menu"]')?.addEventListener('click', () => this.osv?.toggleSidebar());
        this.querySelector('[data-act="pdf"]')?.addEventListener('click', (e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            void printReport(this.entityId, this.year).finally(() => {
                btn.disabled = false;
            });
        });

        this.renderSidebar();
        this.renderBottomNav();
    }

    /** Nav entries visible for the active entity + assistant setting. */
    private visibleViews(): NavItem[] {
        const e = this.activeEntity;
        const privat = e?.kind === 'privat';
        // Belege/Rechnungen/Kontakte/BWA/Einblicke are business reports — hidden for "privat".
        const businessOnly: View[] = ['review', 'rechnungen', 'kontakte', 'auswertungen'];
        return NAV_ITEMS.filter((it) => {
            if (it.view === 'assistent') return this.assistant;
            if (it.view === 'steuer') return !!e?.hasElster || !!e?.hasEst; // ELSTER (business) or ESt (privat)
            if (privat && businessOnly.includes(it.view)) return false;
            return true;
        });
    }

    /** (Re)build the adw-sidebar from the visible views. Called whenever the visible
     * set changes (entity switch, assistant toggle) since the element consumes its
     * items at connect time. Keeps the active view selected; falls back if it vanished. */
    private renderSidebar() {
        const host = this.querySelector('[data-el="sidebar-host"]');
        if (!host) return;
        const items = this.visibleViews();
        if (!items.some((i) => i.view === this.view)) this.view = 'transactions';
        const idx = Math.max(
            0,
            items.findIndex((i) => i.view === this.view),
        );
        host.innerHTML = `
      <adw-sidebar selected="${idx}">
        <adw-sidebar-section>
          ${items
              .map(
                  (i) =>
                      `<adw-sidebar-item title="${i.ico}  ${esc(i.label)}" subtitle="${esc(i.sub)}"></adw-sidebar-item>`,
              )
              .join('')}
        </adw-sidebar-section>
      </adw-sidebar>`;
        host.querySelector('adw-sidebar')?.addEventListener('activated', (e) => {
            const item = items[(e as CustomEvent<{ index: number }>).detail.index];
            if (!item) return;
            this.view = item.view;
            this.mountView();
            if (this.mq.matches) this.osv?.hideSidebar();
        });
    }

    /** (Re)build the phone bottom nav: a data-only <adw-view-stack> whose pages mirror the visible
     * BOTTOM_NAV_VIEWS, driven by an <adw-view-switcher-bar>. Rebuilt on the same triggers as the
     * sidebar (initial render, entity switch) since the stack consumes its pages at connect time.
     * Label-only — the shipped symbolic-icon set is too sparse for an honest per-view mapping (same
     * reason the sidebar uses emoji), and the bar hides an empty icon, so it renders plain labels. */
    private renderBottomNav() {
        const host = this.querySelector('[data-el="bottomnav-host"]');
        if (!host) return;
        const visible = new Set(this.visibleViews().map((v) => v.view));
        const pages = BOTTOM_NAV_VIEWS.filter((v) => visible.has(v))
            .map((v) => {
                const label = BOTTOM_NAV_LABEL[v] ?? NAV_ITEMS.find((n) => n.view === v)?.label ?? v;
                return `<adw-view-stack-page name="${v}" title="${esc(label)}"></adw-view-stack-page>`;
            })
            .join('');
        // The stack is display:none (data model only); the bar reads its pages + drives its selection.
        host.innerHTML = `
      <adw-view-stack class="bh-bottom-stack" id="bh-bottom-stack">${pages}</adw-view-stack>
      <adw-view-switcher-bar class="bh-bottom-bar" stack="bh-bottom-stack" revealed></adw-view-switcher-bar>`;
        // Tapping a bar button flips the bound stack's visible page → mirror that into a real view
        // navigation. navigateTo() no-ops when the view is already active, so the syncBottomNav()
        // that mountView() runs afterwards never loops back through here.
        host.querySelector('adw-view-stack')?.addEventListener('notify::visible-child', (e) => {
            this.navigateTo((e as CustomEvent<{ name: string }>).detail.name);
        });
        this.syncBottomNav();
    }

    /** Reflect the active view into the bottom bar's highlight. A drawer-only view (Rechnungen,
     * Kontakte, …) isn't a bottom destination, so the bar keeps its last highlight — matching the
     * native Adw.ViewSwitcherBar, which always tracks one page of its bound stack. */
    private syncBottomNav() {
        const stack = this.querySelector('.bh-bottom-stack') as Adw.ViewStack | null;
        if (stack?.pages.some((p) => p.name === this.view)) stack.visibleChildName = this.view;
    }

    /**
     * Switch to another top-level view programmatically (a `bh-navigate` deep-link from a child
     * view). Ignores views that aren't available for the active entity so a stale link can't strand
     * the user on an empty screen.
     */
    private navigateTo(view: string) {
        if (!(view in VIEW_TAG)) return;
        if (view === this.view) return;
        if (!this.visibleViews().some((v) => v.view === view)) return;
        this.view = view as View;
        this.renderSidebar(); // reflect the new active entry in the sidebar selection
        this.mountView();
        if (this.mq.matches) this.osv?.hideSidebar();
    }

    /** Reflect the active entity into the year options, the nav, and the identity block. */
    private applyEntity() {
        const e = this.activeEntity;
        if (!e) return;

        // Persistent "Demodaten" banner for the fictional demo workspace.
        this.querySelector('[data-el="demo-banner"]')?.toggleAttribute('revealed', !!e.demo);

        const nameEl = this.querySelector('[data-el="entity-name"]');
        const kindEl = this.querySelector('[data-el="entity-kind"]');
        if (nameEl) nameEl.textContent = e.name;
        if (kindEl) {
            const konten = `${e.accountCount} ${e.accountCount === 1 ? 'Konto' : 'Konten'}`;
            kindEl.textContent = `${KIND_LABEL[e.kind] ?? e.kind} · ${konten}`;
        }

        // Year precedence: ?year= deep-link (share/bookmark a specific year, also used for
        // screenshots) → stored preference → the entity's default year. The deep-link value is
        // consumed once (below) so switching entity later doesn't override a year the user picked.
        const years = e.years.length ? e.years : [e.defaultYear];
        const urlYear = this.pendingUrlYear;
        this.pendingUrlYear = null;
        const saved = Number(localStorage.getItem('bh-year'));
        this.year = urlYear && years.includes(urlYear) ? urlYear : years.includes(saved) ? saved : e.defaultYear;
        const yearDrop = this.yearDrop;
        if (yearDrop) {
            yearDrop.model = years.map((y) => ({ value: String(y), label: String(y) }));
            yearDrop.selectedValue = String(this.year);
        }

        // Rebuild the sidebar for this entity's available views (Steuer needs ELSTER;
        // Belege/Rechnungen/Kontakte/BWA/Einblicke are hidden for "privat"). renderSidebar
        // resets the active view to Transaktionen if the current one isn't available here.
        this.renderSidebar();
        this.renderBottomNav();
    }

    private mountView() {
        const host = this.querySelector('.bh-content');
        if (!host) return;
        this.updateHeaderTitle();
        host.innerHTML = '';
        const el = document.createElement(VIEW_TAG[this.view]);
        el.setAttribute('entity', this.entityId);
        el.setAttribute('year', String(this.year));
        // The Steuer hub renders different tabs for a privat (ESt) vs. business entity.
        el.setAttribute('kind', this.activeEntity?.kind ?? '');
        host.appendChild(el);
        if (location.hash.slice(1) !== this.view) history.replaceState(null, '', `#${this.view}`);
        this.syncBottomNav();
    }

    /** Reflect the active view into the header-bar title/subtitle (v2: a
     * view-aware WindowTitle instead of a static app name). Reuses the nav
     * item's label + sub as the single source of truth. */
    private updateHeaderTitle() {
        const item = NAV_ITEMS.find((i) => i.view === this.view);
        const wt = this.querySelector('[data-el="viewtitle"]');
        if (!wt || !item) return;
        wt.setAttribute('title', item.label);
        wt.setAttribute('subtitle', item.sub);
    }

    private applyResponsive() {
        const osv = this.osv;
        if (!osv) return;
        if (this.mq.matches) {
            osv.setAttribute('collapsed', '');
            osv.removeAttribute('show-sidebar');
        } else {
            osv.removeAttribute('collapsed');
            osv.setAttribute('show-sidebar', '');
        }
    }

    private toggleTheme() {
        const root = document.documentElement;
        const dark = root.classList.toggle('theme-dark');
        root.classList.toggle('theme-light', !dark);
        localStorage.setItem('bh-theme', dark ? 'dark' : 'light');
    }

    /** (Re)seed the overflow menu items. */
    private updateAppMenu() {
        const menu = q<Gtk.MenuButton>(this, '[data-act="appmenu"]');
        if (!menu) return;
        menu.menuModel = [
            { id: 'theme', label: 'Thema wechseln' },
            { id: 'about', label: 'Über Steuererklärung' },
        ];
    }

    /**
     * Present the "Über" dialog with the active entity as its version line.
     *
     * This was a hand-built <adw-dialog> with its own heading, muted paragraphs and
     * layout, because <adw-about-dialog> rendered nothing before @gjsify/adwaita-web
     * 0.34.0 — its sheet measured 360x0. It works now, so the copy is gone and the
     * heading, icon, scrolling and Credits/Legal pages come from the toolkit.
     */
    private showAbout() {
        const dlg = q<Adw.AboutDialog>(this, '[data-el="about"]');
        if (!dlg) return;
        const e = this.activeEntity;
        dlg.version = e ? `${e.name} · ${KIND_LABEL[e.kind] ?? e.kind}${e.demo ? ' · Demodaten' : ''}` : '';
        dlg.present();
    }

    private async loadMeta() {
        try {
            const meta = await api.meta();
            this.entities = meta.entities;

            // Entity precedence: ?entity= deep-link → stored preference → default.
            const urlEntity = new URL(location.href).searchParams.get('entity') ?? '';
            const savedEntity = localStorage.getItem('bh-entity') ?? '';
            this.entityId = meta.entities.some((e) => e.id === urlEntity)
                ? urlEntity
                : meta.entities.some((e) => e.id === savedEntity)
                  ? savedEntity
                  : meta.defaultEntity;

            const entityDrop = this.entityDrop;
            if (entityDrop) {
                // {value,label}: the label is rendered as text by the widget, so names like
                // an entity name like "Meier & Schulz" is safe without manual escaping.
                entityDrop.model = meta.entities.map((e) => ({ value: e.id, label: e.name }));
                entityDrop.selectedValue = this.entityId;
                // A lone entity (no manifest) needs no switcher.
                entityDrop.style.display = meta.entities.length > 1 ? '' : 'none';
            }
            this.assistant = meta.assistant;
            this.applyEntity();
        } catch (err) {
            console.error('meta', err);
        }
        // Deep-link support: honor an initial #view (e.g. #steuer) once entities are loaded, so the
        // ELSTER-gated hub isn't filtered out (as it would be during the first pre-load render).
        const hash = location.hash.slice(1);
        if (hash && hash in VIEW_TAG && this.visibleViews().some((v) => v.view === hash)) {
            this.view = hash as View;
            this.renderSidebar();
        }
        // Mount only after the entity + year are resolved.
        this.mountView();
    }

    /** Set the assistant availability and rebuild the nav (drops the Assistent entry when off). */
    private setAssistantNav(enabled: boolean) {
        this.assistant = enabled;
        this.renderSidebar();
    }

    /** Re-read the assistant setting after a settings save (without remounting the view). */
    private async refreshAssistantNav() {
        try {
            const meta = await api.meta();
            this.setAssistantNav(meta.assistant);
        } catch {
            /* ignore */
        }
    }
}

// Restore theme before first paint. A `?theme=dark|light` query param overrides the stored
// preference (deep-link a theme; also used for screenshots).
const themeParam = new URL(location.href).searchParams.get('theme');
const savedTheme = themeParam ?? localStorage.getItem('bh-theme');
if (savedTheme === 'dark') {
    document.documentElement.classList.add('theme-dark');
    document.documentElement.classList.remove('theme-light');
} else if (savedTheme === 'light') {
    document.documentElement.classList.add('theme-light');
    document.documentElement.classList.remove('theme-dark');
}

customElements.define('bh-app', BhApp);

declare global {
    interface HTMLElementTagNameMap {
        'bh-app': BhApp;
    }
}
