/**
 * The main application window.
 *
 * Layout (native Adwaita, built programmatically — Blueprint can come later):
 *
 *   Adw.NavigationSplitView
 *   ├─ sidebar:  Adw.ToolbarView [ HeaderBar(title + menu) | Entity-Card + Jahr-Segmente | nav rows ]
 *   └─ content:  Adw.ToolbarView [ HeaderBar(view title) | Banner + Stack ]
 *
 * The sidebar mirrors the web review UI's nav (see nav.ts); identity lives IN the sidebar per the
 * v3 design (BhEntitySwitcher card + BhYearSwitcher segments, widgets/), fed from the real backend
 * (see entities.ts). Views come from the registry; unported ids fall back to a placeholder.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';

import { APP_NAME } from './constants.ts';
import { registerAppIcons } from './icons.ts';
import { registerToastOverlay } from './toast.ts';
import { SyncController } from './sync-controller.ts';
import { installShortcuts } from './shortcuts.ts';
import { NAV_ITEMS, isTabHost, visibleNavItems, type NavItem } from './nav.ts';
import { isFirstRun } from '../../core/actions/entities.ts';
import { belegeAusMailAbrufenFuer } from '../../core/actions/mail-eingang.ts';
import { gioMailConnector } from '../../core/clients/imap/index.ts';
import { loadMailEingang, loadManifest } from '../../core/config/index.ts';
import { capabilities } from '../../core/countries/index.ts';
import { loadAppWorkspace, type AppEntity, type AppWorkspace } from './entities.ts';
import { showToast } from './toast.ts';
import { presentRemoveEntity, presentRenameEntity } from './views/entity-dialogs.ts';
import { BhSetupAssistant } from './views/setup-assistant.ts';
import { BhWelcome, type WelcomeChoice } from './views/welcome.ts';
import { isDemoMode } from '../../core/config/demo.ts';
import { loadUserSettings, shouldShowWelcome, updateUserSettings } from '../../core/config/user-settings.ts';
import {
    setupGapFingerprint,
    setupGaps,
    shouldShowSetupBanner,
    type SetupGap,
    type SetupGapEntity,
} from '../../core/actions/setup-gaps.ts';
import { canRestart, restartInMode } from './restart.ts';
import { loadDocuments } from '../../core/presenters/belege.ts';
import { appSession } from './data/session.ts';
import { reloadEst } from './data/settings.ts';
import { VIEW_FACTORIES } from './views/registry.ts';
import { markup } from './views/util.ts';
import { BhEntitySwitcher } from './widgets/entity-switcher.ts';
import { BhYearSwitcher } from './widgets/year-switcher.ts';
import { BhAssistentPanel } from './assistent-panel.ts';

import Template from './window.blp';
import type { PortedView } from './view.ts';
import { _, fmt } from './i18n.ts';

// window.blp names these three as `$BhEntitySwitcher`, `$BhYearSwitcher` and `$BhAssistentPanel`,
// which GtkBuilder resolves by GType at instantiation — so each class has to be REGISTERED before
// the template is built, and importing the module is what registers it.
//
// Without these calls the imports are only ever used as types, and a linter will helpfully suggest
// `import type` — after which the modules are never loaded, no `registerClass` runs, and the window
// dies on an unresolvable class name rather than on anything a reader would connect to the change.
GObject.type_ensure(BhEntitySwitcher.$gtype);
GObject.type_ensure(BhYearSwitcher.$gtype);
GObject.type_ensure(BhAssistentPanel.$gtype);

/** `STEUER_APP_SIZE="1280 1440"` → the window's initial size; the shipped default otherwise. */
function startupSize(): { defaultWidth: number; defaultHeight: number } {
    const raw = process.env.STEUER_APP_SIZE;
    const [w, h] = (raw ?? '').split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { defaultWidth: w, defaultHeight: h };
    }
    if (raw) console.error(`[app] STEUER_APP_SIZE="${raw}" ist keine Größe — erwartet "<Breite> <Höhe>".`);
    return { defaultWidth: 1100, defaultHeight: 760 };
}

export class MainWindow extends Adw.ApplicationWindow {
    static {
        GObject.registerClass(
            {
                GTypeName: 'BhMainWindow',
                Template,
                InternalChildren: [
                    'split_view',
                    'sidebar_page',
                    'sidebar_title',
                    'entity_switcher',
                    'year_switcher',
                    'nav_list',
                    'content_page',
                    'content_title',
                    'assistant_split',
                    'toast_overlay',
                    'sync_button',
                    'assistant_toggle',
                    'assistant_panel',
                    'banner',
                    'setup_bar',
                    'setup_label',
                    'setup_close',
                    'setup_finish',
                    'stack',
                ],
            },
            this,
        );
    }

    private workspace: AppWorkspace | null = null;
    private loadError: string | null = null;
    private currentEntity: AppEntity | null = null;
    private sync: SyncController | null = null;
    private currentYear = 0;

    // Every widget below comes from window.blp — the whole tree is declared there, including both
    // breakpoints (which needed four lines of boxed GObject.Value each in TypeScript) and the
    // Assistent toggle's two-way binding.
    declare private _split_view: Adw.NavigationSplitView;
    declare private _sidebar_page: Adw.NavigationPage;
    declare private _sidebar_title: Adw.WindowTitle;
    declare private _entity_switcher: BhEntitySwitcher;
    declare private _year_switcher: BhYearSwitcher;
    declare private _nav_list: Gtk.ListBox;
    declare private _content_page: Adw.NavigationPage;
    declare private _content_title: Adw.WindowTitle;
    declare private _assistant_split: Adw.OverlaySplitView;
    declare private _toast_overlay: Adw.ToastOverlay;
    declare private _sync_button: Gtk.Button;
    declare private _assistant_toggle: Gtk.ToggleButton;
    declare private _assistant_panel: BhAssistentPanel;
    declare private _banner: Adw.Banner;
    declare private _setup_bar: Gtk.ActionBar;
    declare private _setup_label: Gtk.Label;
    declare private _setup_close: Gtk.Button;
    declare private _setup_finish: Gtk.Button;
    declare private _stack: Gtk.Stack;

    // Ported native views by view id (rebuilt per entity); placeholders aren't tracked here.
    private readonly ported = new Map<string, PortedView>();

    constructor(application: Adw.Application) {
        super({
            application,
            title: APP_NAME,
            // STEUER_APP_SIZE="W H" (dev/testing hook): the window size, applied BEFORE the window
            // maps. Resizing afterwards is not reliable — `set_default_size` on a mapped window is
            // a request the compositor may ignore, and `default-width` then reads back the value
            // that was ASKED FOR while the window renders at its old size. A screenshot rig that
            // trusted that property produced 1100×760 pictures and reported success.
            // width-request / height-request live in window.blp.
            ...startupSize(),
        });
        // Before anything resolves an icon by name: put the shipped icon theme on the search path.
        registerAppIcons(this);
        this.buildUi();
        this.installNavAction();
        this.installSetupAction();
        this.installWorkspaceChangedAction();
        this.installWelcomeActions();
        this.installShortcutActions();
        this.loadData();
        // A new person gets the welcome; it ends in the setup assistant when they choose their own
        // data. Someone who already finished it — or skipped it with a manifest already on disk —
        // still gets the assistant when there is no manifest: the pseudo-entity below fails every
        // save with "Kein Manifest … zum Speichern vorhanden", and its only remedy is a terminal.
        // Someone who put the welcome off gets the setup banner instead of an assistant on every launch.
        if (!isDemoMode() && shouldShowWelcome()) this.presentWelcome();
        else if (isFirstRun() && !loadUserSettings().welcomeDeferred) this.presentSetup();
        // Dev/testing hook: STEUER_APP_SETUP_PAGE also opens the new-entity assistant on a workspace.
        else if (process.env.STEUER_APP_SETUP_PAGE) this.presentSetup();
    }

    /** `win.welcome` (menu) and `win.use-own-data` (demo banner). */
    private installWelcomeActions(): void {
        const welcome = new Gio.SimpleAction({ name: 'welcome' });
        welcome.connect('activate', () => this.presentWelcome());
        this.add_action(welcome);

        const own = new Gio.SimpleAction({ name: 'use-own-data' });
        own.connect('activate', () => this.confirmSwitchMode('own'));
        this.add_action(own);

        const switchMode = new Gio.SimpleAction({ name: 'switch-mode', parameterType: GLib.VariantType.new('s') });
        switchMode.connect('activate', (_action, param) => {
            this.confirmSwitchMode(param?.get_string()[0] === 'demo' ? 'demo' : 'own');
        });
        this.add_action(switchMode);

        // A view changed what the setup banner reads (an account was assigned): re-ask it.
        const setupChanged = new Gio.SimpleAction({ name: 'setup-changed' });
        setupChanged.connect('activate', () => this.refreshSetupBanner());
        this.add_action(setupChanged);

        const assistant = new Gio.SimpleAction({ name: 'assistant-preference' });
        assistant.connect('activate', () => this.applyAssistantPreference());
        this.add_action(assistant);
    }

    private presentWelcome(): void {
        new BhWelcome(
            (choice) => this.onWelcomeFinished(choice),
            () => this.refreshBanner(),
        ).present(this);
    }

    private onWelcomeFinished(choice: WelcomeChoice): void {
        this.applyAssistantPreference();
        const wantsDemo = choice === 'demo';
        // Already in the mode that was picked: nothing to restart. Own data without a manifest
        // goes on to the setup assistant, the one place a configuration is written.
        if (choice !== 'existing' && wantsDemo === isDemoMode()) {
            if (!wantsDemo && isFirstRun()) this.presentSetup();
            return;
        }
        this.restartInto(wantsDemo ? 'demo' : 'own');
    }

    /**
     * Ask before switching between demo and own data. The switch restarts the app — a running
     * process re-pointed at another workspace is how the two would get mixed.
     */
    private confirmSwitchMode(mode: 'demo' | 'own'): void {
        const dialog = new Adw.AlertDialog({
            heading: mode === 'demo' ? _('Switch to the demo?') : _('Switch to your own data?'),
            body:
                mode === 'demo'
                    ? _('The app restarts with fictional sample data. Your own data is not changed.')
                    : _('The app restarts with your own data. The demo data stays separate.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('restart', _('Restart'));
        dialog.set_response_appearance('restart', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('restart');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'restart') this.restartInto(mode);
        });
        dialog.present(this);
    }

    private restartInto(mode: 'demo' | 'own'): void {
        const app = this.get_application();
        if (!app || !canRestart()) {
            showToast(_('Please restart the app yourself to switch.'));
            return;
        }
        restartInMode(app, mode);
    }

    /** `aiAssistant: false` hides the panel toggle; unset keeps the toggle, as before the opt-in existed. */
    private applyAssistantPreference(): void {
        const visible = loadUserSettings().aiAssistant !== false;
        this._assistant_toggle.set_visible(visible);
        if (!visible) this._assistant_split.set_show_sidebar(false);
    }

    /**
     * Registry actions from the entity switcher. Rename and remove act on the CURRENT entity; on
     * success the whole workspace is re-read, because the entity list, the year list and every
     * view's data source change together.
     */
    private onEntityManage(action: 'create' | 'rename' | 'remove', id: string): void {
        if (action === 'create') {
            this.presentSetup();
            return;
        }
        const entity = this.workspace?.entities.find((e) => e.id === id);
        if (!entity) return;
        const done = (message: string, changed: boolean) => {
            showToast(message);
            if (!changed) return;
            this.loadData();
            this.renderNav();
        };
        if (action === 'rename') presentRenameEntity(this, entity, done);
        else presentRemoveEntity(this, entity, done);
    }

    /** `win.setup` — reachable from the menu too, for adding a further entity later. */
    private installSetupAction(): void {
        const action = new Gio.SimpleAction({ name: 'setup' });
        action.connect('activate', () => this.presentSetup());
        this.add_action(action);
    }

    /**
     * `win.workspace-changed` — a view rewrote something the nav is built from (the tax switch, ADR
     * 0001). Unlike loadData() this keeps the active entity, year and view, so the person stays on
     * the page where they flipped the switch. Deferred to idle: renderNav destroys the very view
     * whose handler fired the action.
     */
    private installWorkspaceChangedAction(): void {
        const action = new Gio.SimpleAction({ name: 'workspace-changed' });
        action.connect('activate', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.reloadWorkspaceInPlace();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.add_action(action);
    }

    private reloadWorkspaceInPlace(): void {
        const entityId = this.currentEntity?.id;
        const view = this._stack.get_visible_child_name();
        try {
            this.workspace = loadAppWorkspace();
            this.loadError = null;
        } catch (err) {
            this.loadError = err instanceof Error ? err.message : String(err);
            this.refreshBanner();
            return;
        }
        appSession().invalidate(entityId);
        const entity = this.workspace.entities.find((e) => e.id === entityId);
        if (!entity) {
            this.loadData();
            return;
        }
        this.currentEntity = entity;
        if (!entity.years.includes(this.currentYear)) this.currentYear = entity.defaultYear;
        this.renderEntitySwitcher();
        this.renderYearSwitcher();
        this.renderNav();
        if (view) this.selectNavByView(view);
        this.refreshBanner();
        this.syncAssistantContext();
    }

    /**
     * Show the first-run assistant. On success the whole workspace is re-read and the nav rebuilt,
     * because the entity list, the year list and every view's data source all changed at once.
     */
    private presentSetup(): void {
        const assistant = new BhSetupAssistant(() => {
            this.loadData();
            this.renderNav();
        });
        assistant.present(this);
    }

    /**
     * `win.navigate("<view>")` — lets any nested view jump to a top-level nav entry (e.g. a
     * Steuererklärung step's "Buchungen öffnen" deep-link → the Buchungen view). The action bubbles
     * up the widget tree via Gtk.Widget.activate_action, so views don't need a callback threaded
     * through the tab hubs. No-op when the target view isn't visible for the active entity.
     */
    /**
     * Keyboard access: Ctrl+1…9 for the sidebar, F5, Ctrl+F, Ctrl+, and Ctrl+?.
     *
     * `navigate` goes through `selectNavByView` rather than the stack directly, so the sidebar
     * selection follows the keyboard — a content stack switched behind a sidebar still pointing at
     * the previous row is the kind of split state that makes the next click do the wrong thing.
     */
    private installShortcutActions(): void {
        installShortcuts(this, {
            navigate: (view) => this.selectNavByView(view),
            reloadVisible: () => this.reloadVisibleView(),
            visibleView: () => this._stack.get_visible_child(),
        });
    }

    private installNavAction(): void {
        const navigate = new Gio.SimpleAction({ name: 'navigate', parameterType: GLib.VariantType.new('s') });
        navigate.connect('activate', (_action, param) => {
            const [view, tab] = (param?.get_string()[0] ?? '').split('/');
            if (!view) return;
            this.selectNavByView(view);
            const target = this.ported.get(view);
            if (tab && isTabHost(target)) target.showTab(tab);
        });
        this.add_action(navigate);
    }

    /** Select the sidebar row whose view id matches (fires row-selected → switches + reloads). */
    private selectNavByView(view: string): void {
        for (let row = this._nav_list.get_first_child(); row; row = row.get_next_sibling()) {
            if (row instanceof Gtk.ListBoxRow && row.get_name() === view) {
                this._nav_list.select_row(row);
                return;
            }
        }
        // NOT silent. Returning quietly is what made a mistyped id ('transaktionen' for
        // 'transactions') look like a button that simply did nothing: no error, no console line, no
        // failing test. A miss is either a typo — now a red build, via NavViewId — or a view hidden
        // for this entity, which is a legitimate no-op worth seeing while developing.
        console.error(`[app] win.navigate("${view}") traf keine Nav-Zeile. Bekannt: ${this.navRowNames().join(', ')}`);
    }

    /** The nav ids currently in the sidebar — for the diagnostic above. */
    private navRowNames(): string[] {
        const names: string[] = [];
        for (let row = this._nav_list.get_first_child(); row; row = row.get_next_sibling()) {
            if (row instanceof Gtk.ListBoxRow) names.push(row.get_name() ?? '');
        }
        return names;
    }

    /**
     * Wire the tree that window.blp declares.
     *
     * What is NOT here any more is the point: the split view, both header bars, the primary menu,
     * the identity block, the scroller, both navigation pages, the toast overlay and the assistant
     * split are all declared in the template. So are the two breakpoints — each of which needed a
     * boxed `GObject.Value` here, because `add_setter` takes one and the looser @girs typings
     * happened to accept a raw boolean — and the Assistent toggle's bidirectional binding.
     *
     * The titles stay in TypeScript because they come from {@link APP_NAME}, which is a constant
     * rather than a caption: putting the literal in the template would fork the application name.
     */
    private buildUi(): void {
        this._sidebar_page.set_title(APP_NAME);
        this._content_page.set_title(APP_NAME);
        this._sidebar_title.set_title(APP_NAME);
        this._content_title.set_title(APP_NAME);

        this._nav_list.connect('row-selected', (_list, row) => {
            if (row) this.onNavRowSelected(row);
        });

        this._entity_switcher.onChanged = (id) => this.onEntityChanged(id);
        this._entity_switcher.onManage = (action, id) => this.onEntityManage(action, id);
        this._year_switcher.onChanged = (year) => this.onYearChanged(year);

        // Views and dialogs reach the overlay through this registration rather than through the
        // window, so a toast works from code that never sees the window.
        registerToastOverlay(this._toast_overlay);
        this.connect('close-request', () => {
            this.sync?.dispose();
            return false;
        });
        this.sync = new SyncController(this._sync_button, {
            entity: () => this.currentEntity,
            entityById: (id) => this.workspace?.entities.find((e) => e.id === id) ?? null,
            view: () => this._stack.get_visible_child_name() ?? undefined,
            reloadView: () => this.reloadVisibleView(),
        });

        // The AI panel's own close button hides it; applying an intake proposal invalidates the
        // est snapshot, so the visible view is reloaded.
        this._assistant_panel.onClose = () => this._assistant_split.set_show_sidebar(false);
        this._assistant_panel.onApplied = () => this.refreshEstAfterApply();
        // Dev/testing hook: open the panel on launch (pairs with STEUER_APP_ASSIST_DEMO's seeded chat).
        if (process.env.STEUER_APP_ASSIST_DEMO) this._assistant_split.set_show_sidebar(true);
        this.applyAssistantPreference();
        this._banner.connect('button-clicked', () => this.confirmSwitchMode('own'));
        this._setup_finish.connect('clicked', () => this.finishSetup());
        this._setup_close.connect('clicked', () => this.dismissSetupBanner());
    }

    /** Load entities/years from the backend, populate the switchers, then render the nav. */
    private loadData(): void {
        try {
            this.workspace = loadAppWorkspace();
            this.loadError = null;
        } catch (err) {
            this.loadError = err instanceof Error ? err.message : String(err);
        }

        if (!this.workspace || this.workspace.entities.length === 0) {
            // Keep the app usable even if the store/manifest can't be read.
            this.workspace = {
                entities: [
                    {
                        id: 'default',
                        name: 'Steuererklärung',
                        kind: 'gbr',
                        country: 'DE',
                        taxModule: 'de',
                        capabilities: capabilities({}),
                        hasElster: false,
                        hasEst: false,
                        dmsType: 'builtin',
                        years: [],
                        defaultYear: new Date().getFullYear(),
                        accountKeys: [],
                    },
                ],
                defaultEntity: 'default',
                assistant: true,
            };
        }

        // Default to the manifest's default entity, or the one named by STEUER_APP_ENTITY (dev/testing).
        const wanted = process.env.STEUER_APP_ENTITY;
        this.currentEntity =
            (wanted ? this.workspace.entities.find((e) => e.id === wanted) : undefined) ??
            this.workspace.entities.find((e) => e.id === this.workspace?.defaultEntity) ??
            this.workspace.entities[0];
        // STEUER_APP_YEAR (dev/testing hook) pins the initial year if that year has data for the entity.
        const wantedYear = Number(process.env.STEUER_APP_YEAR);
        this.currentYear =
            Number.isInteger(wantedYear) && this.currentEntity.years.includes(wantedYear)
                ? wantedYear
                : this.currentEntity.defaultYear;
        // Warm the shared EÜR aggregate for the default entity-year in the background, so the first
        // tax-family view the user opens (Steuer · EÜR · Steuererklärung · BWA · Einblicke · Offene
        // Belege) is already loaded instead of blocking on the ~10 s Paperless fetch. Fire-and-forget:
        // loadAggregate caches + dedupes, so the view's own reload reuses this in-flight fetch. Errors
        // are surfaced by the view (which re-runs it), so they're swallowed here.
        this.prefetchAggregate();

        this.renderEntitySwitcher();
        this.renderYearSwitcher();
        this.renderNav();

        this.refreshBanner();
        this.syncAssistantContext();
        this.fetchMailOnStart();
    }

    private mailFetchedOnStart = false;

    /**
     * Idee 15: fetch the mail folders that ask for it, once per app start, in the background. A failure
     * is only the one result line in the settings (the fetch records it); nothing interrupts the person.
     */
    private fetchMailOnStart(): void {
        if (this.mailFetchedOnStart || !this.workspace) return;
        this.mailFetchedOnStart = true;
        const wanted = this.workspace.entities.filter((e) => {
            try {
                return loadMailEingang(e.id)?.onStart === true;
            } catch {
                return false;
            }
        });
        if (wanted.length === 0) return;
        void (async () => {
            for (const e of wanted) {
                try {
                    const r = await belegeAusMailAbrufenFuer(e.id, gioMailConnector);
                    if (r.ok && r.neu > 0) {
                        appSession().invalidate(e.id);
                        showToast(r.zusammenfassung);
                    }
                } catch {
                    /* recorded by the fetch itself */
                }
            }
            this.reloadVisibleView();
        })();
    }

    /**
     * Show the window banner for the highest-priority persistent condition: a data-load error
     * takes precedence; otherwise a "Demodaten" notice for the fictional demo entity; else hidden.
     */
    private refreshBanner(): void {
        this.refreshSetupBanner();
        // On a first run the missing manifest is not an error, it is the state the setup assistant
        // exists for — and it is already on screen saying so. A banner behind it that reads "Kein
        // Manifest gefunden" only tells the user something is broken while they are fixing it.
        if (this.loadError && !isFirstRun()) {
            // Banner title is Pango markup — escape the (raw exception) error text.
            this._banner.set_title(
                markup(fmt(_('Data could not be loaded completely: {error}'), { error: this.loadError })),
            );
            this._banner.set_button_label(null);
            this._banner.set_revealed(true);
            return;
        }
        if (this.currentEntity?.demo) {
            this._banner.set_title(markup(_('Demo data – fictional examples, no real financial data')));
            this._banner.set_button_label(_('Use my own data'));
            this._banner.set_revealed(true);
            return;
        }
        this._banner.set_revealed(false);
    }

    /** The manifest's entities for {@link setupGaps}; `null` when there is no manifest (or it is unreadable). */
    private setupGapEntities(): SetupGapEntity[] | null {
        if (isDemoMode() || isFirstRun()) return isDemoMode() ? [] : null;
        try {
            return loadManifest().entities;
        } catch {
            return null;
        }
    }

    /**
     * The setup banner: someone who put the welcome off and still misses an entity or an account.
     * Independent of the Adw.Banner above — a load error and a missing account can both be true.
     */
    private refreshSetupBanner(): void {
        const gaps = setupGaps(this.setupGapEntities());
        this.setupGapsShown = gaps;
        const show = !isDemoMode() && shouldShowSetupBanner(loadUserSettings(), gaps);
        if (show) {
            const first = gaps[0];
            this._setup_label.set_label(
                first.kind === 'no-entity'
                    ? _('Setup is not finished: no business or private tax return is set up yet.')
                    : fmt(_('Setup is not finished: “{entity}” has no bank account yet.'), {
                          entity: first.entityName,
                      }),
            );
        }
        this._setup_bar.set_revealed(show);
    }

    private setupGapsShown: SetupGap[] = [];

    /** „Finish setup": the assistant for a missing entity, the accounts view for a missing account. */
    private finishSetup(): void {
        const first = this.setupGapsShown[0];
        if (!first || first.kind === 'no-entity') {
            this.presentSetup();
            return;
        }
        if (this.currentEntity?.id !== first.entityId) this.onEntityChanged(first.entityId);
        this.selectNavByView('konten');
    }

    /** Close: remember today's gaps, so only a new one brings the banner back. */
    private dismissSetupBanner(): void {
        const fingerprint = setupGapFingerprint(this.setupGapsShown);
        updateUserSettings((s) => {
            s.setupBannerDismissed = fingerprint;
        });
        this._setup_bar.set_revealed(false);
    }

    /** Fill the sidebar entity card from the workspace and show the active entity. */
    private renderEntitySwitcher(): void {
        if (!this.workspace || !this.currentEntity) return;
        this._entity_switcher.setEntities(
            this.workspace.entities.map((e) => ({
                id: e.id,
                name: e.name,
                sub: e.kind === 'privat' ? _('Private') : _('Business'),
            })),
            this.currentEntity.id,
        );
    }

    /** Fill the sidebar year segments (≤4 years) / dropdown from the active entity. */
    private renderYearSwitcher(): void {
        if (!this.currentEntity) return;
        const years = this.currentEntity.years.length ? this.currentEntity.years : [this.currentEntity.defaultYear];
        this._year_switcher.setYears(years, this.currentYear);
    }

    /** Rebuild the sidebar rows + the content stack for the active entity's visible views. */
    private renderNav(): void {
        if (!this.workspace || !this.currentEntity) return;
        this.clearChildren(this._nav_list);
        this.clearChildren(this._stack);
        this.ported.clear();

        const items = visibleNavItems({
            kind: this.currentEntity.kind,
            hasElster: this.currentEntity.hasElster,
            hasEst: this.currentEntity.hasEst,
            assistant: this.workspace.assistant,
        });

        for (const item of items) {
            this._nav_list.append(this.buildNavRow(item));
            const factory = VIEW_FACTORIES[item.view];
            if (factory) {
                const view = factory();
                this.ported.set(item.view, view);
                this._stack.add_titled(view, item.view, item.label);
            } else {
                this._stack.add_titled(this.buildPlaceholder(item), item.view, item.label);
            }
        }

        // Open the first view, or the one named by STEUER_APP_VIEW (dev/testing hook) if visible.
        const wanted = process.env.STEUER_APP_VIEW;
        const index = wanted ? items.findIndex((i) => i.view === wanted) : -1;
        const row = this._nav_list.get_row_at_index(index >= 0 ? index : 0);
        if (row) this._nav_list.select_row(row); // fires row-selected → sets the active view
    }

    /** One sidebar row: icon + title + subtitle, carrying its view id as the widget name. */
    private buildNavRow(item: NavItem): Adw.ActionRow {
        // ActionRow titles/subtitles are Pango markup, so escape the German "&" in labels.
        const row = new Adw.ActionRow({ title: markup(item.label), subtitle: markup(item.sub) });
        row.add_prefix(new Gtk.Image({ iconName: item.icon }));
        row.set_name(item.view);
        return row;
    }

    /** Placeholder body for a not-yet-ported view (Adwaita status page). */
    private buildPlaceholder(item: NavItem): Gtk.Widget {
        // StatusPage title/description are Pango markup too — escape before interpolating.
        return new Adw.StatusPage({
            iconName: item.icon,
            title: markup(item.label),
            description: markup(
                fmt(
                    _(
                        '“{view}” — this view is being ported to native Adwaita widgets step by step. ' +
                            'It is already available in the web interface (steuer web).',
                    ),
                    { view: item.sub },
                ),
            ),
        });
    }

    private onNavRowSelected(row: Gtk.ListBoxRow): void {
        const view = row.get_name();
        if (!view) return;
        this._stack.set_visible_child_name(view);
        const item = NAV_ITEMS.find((i) => i.view === view);
        this._content_title.set_title(item?.label ?? APP_NAME);
        this._content_title.set_subtitle(item?.sub ?? '');
        this._assistant_panel.setViewContext(item?.label ?? '', item?.sub ?? '');
        if (this._split_view.get_collapsed()) this._split_view.set_show_content(true);
        this.reloadVisibleView();
    }

    /** Reload the visible ported view for the active entity/year (no-op for placeholder views). */
    private reloadVisibleView(): void {
        if (!this.currentEntity) return;
        const view = this._stack.get_visible_child_name();
        if (view) this.ported.get(view)?.reload(this.currentEntity, this.currentYear);
    }

    /** Point the AI panel at the active entity-year (resets its conversation on entity/year change). */
    private syncAssistantContext(): void {
        if (this.currentEntity) this._assistant_panel.setContext(this.currentEntity, this.currentYear);
    }

    /**
     * After the assistant applies an intake proposal (approve-to-apply), the entity's `est` snapshot is
     * stale. Re-read it FRESH from the manifest and reload the visible view so the ESt views reflect the
     * change immediately (the presenters read `entity.est` directly), plus drop the EÜR aggregate cache.
     */
    private refreshEstAfterApply(): void {
        if (!this.currentEntity) return;
        const fresh = reloadEst(this.currentEntity);
        if (fresh) this.currentEntity.est = fresh;
        appSession().invalidate(this.currentEntity.id);
        this.reloadVisibleView();
    }

    /** Warm the shared EÜR aggregate + DMS docs for the active entity-year in the background (best-effort). */
    private prefetchAggregate(): void {
        if (!this.currentEntity) return;
        // Only a business entity (ELSTER config) has an EÜR aggregate to warm. A `privat` entity has
        // none — prefetching it would kick off a pointless Paperless fetch that can stall the GTK loop.
        if (!this.currentEntity.elster) return;
        void appSession()
            .aggregate(this.currentEntity, this.currentYear)
            .catch(() => {});
        // The DMS docs feed the enriched Buchungen (receipts) + Offene Belege; warm them too so
        // Buchungen opens without a fresh Paperless fetch (shares documents.ts's cache).
        void loadDocuments(appSession(), this.currentEntity, this.currentYear).catch(() => {});
    }

    private onEntityChanged(id: string): void {
        if (!this.workspace) return;
        const entity = this.workspace.entities.find((e) => e.id === id);
        if (!entity) return;
        this.currentEntity = entity;
        this.sync?.refresh();
        this.currentYear = entity.defaultYear;
        this.renderEntitySwitcher();
        this.renderYearSwitcher();
        this.renderNav();
        this.refreshBanner();
        this.syncAssistantContext();
    }

    private onYearChanged(year: number): void {
        if (!this.currentEntity) return;
        this.currentYear = year;
        this.reloadVisibleView();
        this.syncAssistantContext();
    }

    /** Remove every child of a container (ListBox/Stack) — GTK has no single "clear" for these. */
    private clearChildren(container: Gtk.Widget): void {
        let child = container.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            if (container instanceof Gtk.ListBox) container.remove(child);
            else if (container instanceof Gtk.Stack) container.remove(child);
            child = next;
        }
    }
}
