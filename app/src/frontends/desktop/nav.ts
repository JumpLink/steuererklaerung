import GLib from '@girs/glib-2.0';
import type Gtk from '@girs/gtk-4.0';

/**
 * Sidebar navigation model for the native app.
 *
 * The same v2 information architecture as the web review UI
 * (src/frontends/web/client/components/bh-app.ts → NAV_ITEMS): 9 top-level entries, where Steuer,
 * Auswertungen and Beleg-Eingang are tab hubs (see tab-hub.ts) that consolidate the former
 * standalone views. Native GTK uses the full system Adwaita symbolic icon set (the web fell back to
 * emoji). All icon names below are standard system Adwaita symbolics.
 */

/**
 * Every navigable view id.
 *
 * A union, not `string`, because navigation happens through `win.navigate("<id>")` — a STRING
 * carried in a GVariant, which no compiler was checking. `beleg-eingang-view.ts` activated
 * `transaktionen` while the id is `transactions`; `selectNavByView` found nothing, returned
 * silently, and the prominent "Buchungen öffnen" button at the end of the Beleg-Eingang flow did
 * nothing at all — no error, no console line, no failing test.
 *
 * With the union, a typo is a red build. {@link navigateTo} is the only way to fire the action.
 */
export type NavViewId =
    | 'home'
    | 'review'
    | 'transactions'
    | 'rechnungen'
    | 'zeiten'
    | 'kontakte'
    | 'auswertungen'
    | 'fristen'
    | 'steuer'
    | 'projekte'
    | 'konten'
    | 'settings';

export interface NavItem {
    /** Stable view id — matches the web view ids and the content stack child names. */
    view: NavViewId;
    /** Symbolic icon name from the system Adwaita theme. */
    icon: string;
    /** Sidebar row title. */
    label: string;
    /** Sidebar row subtitle. */
    sub: string;
}

export const NAV_ITEMS: NavItem[] = [
    { view: 'home', icon: 'go-home-symbolic', label: 'Übersicht', sub: 'KPIs & Trends' },
    { view: 'review', icon: 'mail-inbox-symbolic', label: 'Beleg-Eingang', sub: 'Belege prüfen & zuordnen' },
    { view: 'transactions', icon: 'view-list-symbolic', label: 'Buchungen', sub: 'alle Konten' },
    { view: 'rechnungen', icon: 'document-send-symbolic', label: 'Rechnungen', sub: 'offene Posten & Status' },
    { view: 'zeiten', icon: 'alarm-symbolic', label: 'Zeiten', sub: 'Timer & offene Stunden' },
    { view: 'kontakte', icon: 'system-users-symbolic', label: 'Kontakte', sub: 'Kunden & Lieferanten' },
    { view: 'auswertungen', icon: 'view-grid-symbolic', label: 'Auswertungen', sub: 'BWA · Einblicke' },
    // NOT business-only and NOT entity-scoped: this is the one "damit ich das nicht vergesse"
    // screen, and a Frist you cannot see because a different entity is selected is exactly the
    // Frist you miss. A privat entity has ESt deadlines and open items just the same.
    { view: 'fristen', icon: 'alarm-symbolic', label: 'Fristen', sub: 'Termine · Zahlungen · offene Posten' },
    {
        view: 'steuer',
        icon: 'accessories-calculator-symbolic',
        label: 'Steuer',
        sub: 'Erklärung · EÜR · USt-VA · Konto',
    },
    // After Steuer, not next to Kontakte where it belongs by content: the first nine entries carry
    // Ctrl+1…9 (shortcuts.ts), and a seat in the middle would silently move Auswertungen, Fristen and
    // Steuer to other numbers under people's fingers.
    { view: 'projekte', icon: 'folder-symbolic', label: 'Projekte', sub: 'Kunde · Kosten · Ergebnis' },
    { view: 'konten', icon: 'network-transmit-receive-symbolic', label: 'Konten', sub: 'Anbindungen & Import' },
    {
        view: 'settings',
        icon: 'preferences-system-symbolic',
        label: 'Einstellungen',
        sub: 'Assistent · Anbindungen · Stammdaten',
    },
];

/** Business-only views hidden for `privat` entities (mirrors the web's visibleViews filter). */
const BUSINESS_ONLY = new Set(['review', 'rechnungen', 'kontakte', 'projekte', 'auswertungen']);

/**
 * Filter the nav items for a given entity, mirroring the web's `visibleViews()`:
 * - the Steuer hub needs a loaded ELSTER config;
 * - `privat` entities hide the business-only reports.
 * (The `assistant` flag is accepted for call-site compatibility; the Assistent moved to a panel.)
 */
export function visibleNavItems(opts: {
    kind: string;
    hasElster: boolean;
    hasEst?: boolean;
    assistant: boolean;
}): NavItem[] {
    return NAV_ITEMS.filter((item) => {
        if (item.view === 'steuer' && !opts.hasElster && !opts.hasEst) return false; // ELSTER (business) or ESt (privat)
        if (opts.kind === 'privat' && BUSINESS_ONLY.has(item.view)) return false;
        return true;
    });
}

/**
 * Jump to a top-level view from anywhere in the widget tree.
 *
 * The one way to fire `win.navigate`, so the id is type-checked at every call site. The action
 * bubbles up via `Gtk.Widget.activate_action`, so a nested view needs no callback threaded through
 * the tab hubs. `tab` picks a tab of a hub view (e.g. „Zu prüfen" in Buchungen).
 */
export function navigateTo(widget: Gtk.Widget, view: NavViewId, tab?: string): void {
    widget.activate_action('win.navigate', GLib.Variant.new_string(tab ? `${view}/${tab}` : view));
}

/** A view that hosts tabs and can be asked to show one (the tab hubs). */
export interface TabHost {
    showTab(id: string): void;
}

/** Whether a view offers {@link TabHost}. */
export function isTabHost(widget: unknown): widget is TabHost {
    return typeof (widget as TabHost | null)?.showTab === 'function';
}
