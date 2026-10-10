/**
 * The welcome — what a new person sees before the app asks them for anything.
 *
 * It explains, it does not configure. Five short pages, every one of them skippable:
 *
 *   1. What this is — local data, every connection optional.
 *   2. What it is not — no tax advice; check before you send.
 *   3. Demo or own data — plus a way out for someone who already HAS a `steuererklaerung.json`
 *      and only needs to know where to put it.
 *   4. Optional connections (own data only) — what exists, and that it waits in the Settings.
 *   5. The AI assistant — an explicit yes or no, with what that means for the data.
 *
 * The welcome never writes the manifest. "Own data" ends by handing over to the existing setup
 * assistant ({@link BhSetupAssistant}), which is the one place a configuration is created; a second
 * writer here would be a second truth about how an entity is born. What the welcome DOES write is
 * the per-user settings file: the choices when the person finishes, and that they put it off when
 * they press „Later". A put-off welcome does not come back on launch — the setup banner names what
 * is still missing instead, and the menu reopens the welcome at any time.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { isDemoMode } from '../../../core/config/demo.ts';
import { getManifestPath } from '../../../core/config/index.ts';
import { loadUserSettings, updateUserSettings } from '../../../core/config/user-settings.ts';
import { defaultManifestPath } from '../../../core/paths.ts';
import { _, fmt } from '../i18n.ts';
import { markup } from './util.ts';

/** What the person chose, handed to the window, which owns restarts and the setup assistant. */
export type WelcomeChoice = 'demo' | 'own' | 'existing';

export class BhWelcome extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhWelcome' }, this);
    }

    private readonly nav = new Adw.NavigationView();
    private choice: WelcomeChoice = 'own';
    private ai: boolean;
    private readonly onFinish: (choice: WelcomeChoice) => void;
    private readonly onLater?: () => void;

    constructor(onFinish: (choice: WelcomeChoice) => void, onLater?: () => void) {
        super();
        this.onFinish = onFinish;
        this.onLater = onLater;
        // Opt-in: an answer given before counts, otherwise the switch starts off.
        this.ai = loadUserSettings().aiAssistant ?? false;
        this.set_title(_('Welcome'));
        this.set_content_width(560);
        this.set_content_height(620);
        this.set_child(this.nav);
        this.nav.push(this.pageIntro());
        this.applyStartPageHook();
    }

    /** `STEUER_APP_WELCOME_PAGE=notice|data|connections|ai` — the screenshot hook, as in the setup assistant. */
    private applyStartPageHook(): void {
        const page = globalThis.process?.env?.STEUER_APP_WELCOME_PAGE;
        if (page === 'notice') this.nav.push(this.pageNotice());
        else if (page === 'data') this.nav.push(this.pageData());
        else if (page === 'connections') this.nav.push(this.pageConnections());
        else if (page === 'ai') this.nav.push(this.pageAi());
    }

    // ── Page shell ────────────────────────────────────────────────────────────────────────────

    private page(
        tag: string,
        title: string,
        body: Gtk.Widget,
        primary?: { label: string; run: () => void },
    ): Adw.NavigationPage {
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());

        const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
        scroller.set_child(body);
        toolbar.set_content(scroller);

        const bottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
            spacing: 8,
            marginTop: 10,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        // „Later" on every page: no choice is saved, only that the welcome was put off.
        const later = new Gtk.Button({ label: _('Later') });
        later.add_css_class('pill');
        later.connect('clicked', () => this.later());
        bottom.append(later);
        if (primary) {
            const button = new Gtk.Button({ label: primary.label });
            button.add_css_class('suggested-action');
            button.add_css_class('pill');
            button.connect('clicked', primary.run);
            bottom.append(button);
        }
        toolbar.add_bottom_bar(bottom);

        const page = new Adw.NavigationPage({ title, child: toolbar });
        page.set_tag(tag);
        return page;
    }

    // ── 1 · What this is ──────────────────────────────────────────────────────────────────────

    private pageIntro(): Adw.NavigationPage {
        const box = this.column();
        box.append(
            new Adw.StatusPage({
                iconName: 'accessories-calculator-symbolic',
                title: _('Welcome to Steuererklärung'),
                description: markup(
                    _(
                        'Prepare your profit-and-loss statement, VAT and income tax from your bank ' +
                            'transactions and receipts.',
                    ),
                ),
            }),
        );
        const facts = new Adw.PreferencesGroup();
        facts.add(
            this.infoRow(
                'drive-harddisk-symbolic',
                _('Your data stays on this computer'),
                _('Configuration, transactions and receipts are ordinary files in your home folder.'),
            ),
        );
        facts.add(
            this.infoRow(
                'network-transmit-receive-symbolic',
                _('Connections are optional'),
                _('Qonto, Paperless-ngx, online banking, AI and ELSTER validation only when you set them up.'),
            ),
        );
        box.append(facts);
        return this.page('intro', _('Welcome'), box, {
            label: _('Next'),
            run: () => this.nav.push(this.pageNotice()),
        });
    }

    // ── 2 · What it is not ────────────────────────────────────────────────────────────────────

    private pageNotice(): Adw.NavigationPage {
        const box = this.column();
        box.append(
            new Adw.StatusPage({
                iconName: 'dialog-information-symbolic',
                title: _('No tax advice'),
                description: markup(
                    _(
                        'The app helps you prepare. It does not replace a tax adviser, and its figures ' +
                            'are estimates until ELSTER has validated them. Check every return before you send it.',
                    ),
                ),
            }),
        );
        return this.page('notice', _('Please note'), box, {
            label: _('Understood'),
            run: () => this.nav.push(this.pageData()),
        });
    }

    // ── 3 · Demo or own data ──────────────────────────────────────────────────────────────────

    private pageData(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: _('How do you want to start?'),
            description: _('Demo and own data are kept strictly apart. You can switch later in the Settings.'),
        });
        group.add(
            this.choiceRow(
                'applications-games-symbolic',
                _('Try the demo'),
                _('A fictional business with sample transactions — nothing of yours is touched.'),
                () => {
                    this.choice = 'demo';
                    this.nav.push(this.pageAi());
                },
            ),
        );
        group.add(
            this.choiceRow(
                'avatar-default-symbolic',
                _('Use my own data'),
                _('Set up your business or private tax return in a few steps.'),
                () => {
                    this.choice = 'own';
                    this.nav.push(this.pageConnections());
                },
            ),
        );
        group.add(
            this.choiceRow(
                'document-open-symbolic',
                _('I already have a steuererklaerung.json'),
                _('Show where the app looks for it.'),
                () => this.nav.push(this.pageExisting()),
            ),
        );
        box.append(group);
        return this.page('data', _('Your data'), box);
    }

    /** Where an existing configuration belongs — the one path the app reads in own-data mode. */
    private pageExisting(): Adw.NavigationPage {
        const box = this.column();
        // In demo mode getManifestPath() names the demo workspace, which is not where a person's
        // own file goes.
        const path = isDemoMode() ? defaultManifestPath() : getManifestPath();
        const group = new Adw.PreferencesGroup({
            title: _('Existing configuration'),
            description: _(
                'Copy your steuererklaerung.json (or the older buchhaltung.json) to this place, then ' +
                    'restart the app. Your transactions and receipts stay where the file says they are.',
            ),
        });
        const row = new Adw.ActionRow({ title: _('Expected location'), subtitle: markup(path) });
        row.add_css_class('property');
        const open = new Gtk.Button({
            iconName: 'folder-open-symbolic',
            tooltipText: _('Open folder'),
            valign: Gtk.Align.CENTER,
        });
        open.add_css_class('flat');
        open.connect('clicked', () => this.openFolder(dirname(path)));
        row.add_suffix(open);
        group.add(row);
        box.append(group);
        return this.page('existing', _('Existing configuration'), box, {
            label: _('Restart now'),
            run: () => {
                this.choice = 'existing';
                this.finish();
            },
        });
    }

    // ── 4 · Optional connections ──────────────────────────────────────────────────────────────

    private pageConnections(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: _('Optional connections'),
            description: _('None of them is needed to start. Set them up later in the Settings, whenever you like.'),
        });
        group.add(this.infoRow('network-workgroup-symbolic', 'Qonto', _('Fetch business account transactions')));
        group.add(
            this.infoRow('folder-documents-symbolic', 'Paperless-ngx', _('Use receipts from your document archive')),
        );
        group.add(this.infoRow('network-server-symbolic', 'FinTS', _('Online banking with German banks')));
        group.add(this.infoRow('starred-symbolic', _('AI assistant'), _('Answers questions and proposes bookings')));
        group.add(this.infoRow('emblem-ok-symbolic', 'ERiC', _('Validate returns with the official ELSTER library')));
        box.append(group);
        return this.page('connections', _('Connections'), box, {
            label: _('Next'),
            run: () => this.nav.push(this.pageAi()),
        });
    }

    // ── 5 · AI ────────────────────────────────────────────────────────────────────────────────

    private pageAi(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: _('AI assistant'),
            description: _(
                'When you use the assistant, your question and the data it needs to answer go to the ' +
                    'AI provider you configure. Nothing is sent unless you ask. Without it, every ' +
                    'feature of the app still works.',
            ),
        });
        const toggle = new Adw.SwitchRow({ title: _('Built-in AI assistant'), active: this.ai });
        toggle.connect('notify::active', () => {
            this.ai = toggle.get_active();
        });
        group.add(toggle);
        box.append(group);
        return this.page('ai', _('AI assistant'), box, {
            label: this.choice === 'demo' ? _('Start the demo') : _('Set up my data'),
            run: () => this.finish(),
        });
    }

    // ── Finishing ─────────────────────────────────────────────────────────────────────────────

    private finish(): void {
        updateUserSettings((settings) => {
            settings.welcomeCompleted = true;
            if (this.choice !== 'existing') settings.aiAssistant = this.ai;
        });
        this.close();
        this.onFinish(this.choice);
    }

    private later(): void {
        if (!loadUserSettings().welcomeCompleted) {
            updateUserSettings((settings) => {
                settings.welcomeDeferred = true;
            });
        }
        this.close();
        this.onLater?.();
    }

    private openFolder(dir: string): void {
        try {
            // The XDG config folder does not exist on a fresh system; an empty one is harmless and
            // gives the file manager something to show.
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const root = this.get_root();
            new Gtk.FileLauncher({ file: Gio.File.new_for_path(dir) }).launch(
                root instanceof Gtk.Window ? root : null,
                null,
                () => {},
            );
        } catch (err) {
            console.error(`[welcome] ${fmt(_('Could not open {dir}'), { dir })}: ${String(err)}`);
        }
    }

    // ── Small helpers ─────────────────────────────────────────────────────────────────────────

    private column(): Gtk.Box {
        return new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 16,
            marginEnd: 16,
        });
    }

    private infoRow(icon: string, title: string, subtitle: string): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: markup(title), subtitle: markup(subtitle) });
        row.add_prefix(new Gtk.Image({ iconName: icon }));
        return row;
    }

    private choiceRow(icon: string, title: string, subtitle: string, run: () => void): Adw.ActionRow {
        const row = this.infoRow(icon, title, subtitle);
        row.set_activatable(true);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
        row.connect('activated', run);
        return row;
    }
}
