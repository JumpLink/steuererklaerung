/**
 * Getting bank transactions into the app — the three ways in, from the GUI.
 *
 * The native app could sync and disconnect an account that was already there, and nothing else.
 * Connecting Qonto or a FinTS bank meant writing `.env` by hand; importing a CAMT or PayPal export
 * meant a CLI command. The web UI has had all three since `web/account-routes.ts` — the actions
 * exist, they simply had no native surface.
 *
 * That gap is the whole "ohne KI bedienbar" question in miniature: without a way to get data IN, a
 * tax application is a viewer for data somebody else put there.
 *
 * Source first, then the source's form, then WHICH entity the account belongs to. Nothing is written
 * before that last confirm — picking a file or typing credentials only fills the form — so backing
 * out at any page leaves `.env`, the store and the manifest as they were. An account that lands in
 * the store but in no entity is invisible to every tax figure, which is why the assignment is part
 * of adding it rather than a chore for later.
 *
 * All three write through the shared core actions (`connectQonto`, `connectFints`, `runImport`,
 * `assignAccount`), so an account added here is byte-for-byte the same as one added from the web UI
 * or the CLI.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import { pickFile } from '@gjsify/adwaita-app';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import Template from './konto-hinzufuegen-dialog.blp';
import PageTemplate from './konto-hinzufuegen-page.blp';

import {
    connectFints,
    connectionAccountPattern,
    connectQonto,
    detectFormat,
    type ImportFormat,
    importedAccountKeys,
    runImport,
} from '../../../core/actions/accounts.ts';
import { accountOwner } from '../../../core/actions/entity-setup.ts';
import { assertAccountsMovable, assignAccount } from '../../../core/actions/entities.ts';
import { loadManifest, type Manifest } from '../../../core/config/index.ts';
import { _, fmt } from '../i18n.ts';
import { navigateTo } from '../nav.ts';
import { markup } from './util.ts';

/** Report the outcome; the caller toasts it and refreshes the account list. */
export type AddAccountResult = (message: string, changed: boolean) => void;

/** The importable file formats, with the labels a user recognises them by. */
function formats(): Array<{ id: ImportFormat; label: string; hint: string }> {
    return [
        { id: 'camt', label: 'CAMT.052/053 (XML)', hint: _('The standard statement of almost every bank') },
        {
            id: 'paypal',
            label: _('PayPal activity report (CSV)'),
            hint: _('Enrichment only — not in the profit statement'),
        },
        { id: 'qonto-xls', label: _('Qonto export (XLS)'), hint: _('Enriches existing transactions') },
        { id: 'amazon', label: _('Amazon orders (CSV)'), hint: _('Enriches existing transactions') },
    ];
}

/** Formats that only annotate rows already in the store: no new account, nothing to assign. */
const ENRICH_ONLY: ReadonlySet<ImportFormat> = new Set(['qonto-xls', 'amazon']);

/** What the last page commits: the write itself, and the key pattern when it is known beforehand. */
interface PendingAccount {
    /** Shown on the assignment page, e.g. "Qonto (all accounts of the connection)". */
    label: string;
    /** Known before the write (a live connection); a file import learns its keys from the import. */
    pattern?: string;
    /** Perform the write. Returns the toast message and the account keys to assign. */
    commit: () => Promise<{ message: string; keys: string[] }>;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One page of the dialog's NavigationView: scrolling body plus an optional primary-action bar. */
class BhAddAccountPage extends Adw.NavigationPage {
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _bottom_bar: Gtk.Box;
    declare private _primary_button: Gtk.Button;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhAddAccountPage',
                Template: PageTemplate,
                InternalChildren: ['scroller', 'bottom_bar', 'primary_button'],
            },
            this,
        );
    }

    constructor(title: string, body: Gtk.Widget, primary?: { label: string; run: () => void }) {
        super();
        this.set_title(title);
        this._scroller.set_child(body);
        if (primary) {
            this._primary_button.set_label(primary.label);
            this._primary_button.connect('clicked', primary.run);
            this._bottom_bar.set_visible(true);
        }
    }
}

export class BhAddAccountDialog extends Adw.Dialog {
    declare private _nav: Adw.NavigationView;

    static {
        GObject.registerClass({ GTypeName: 'BhAddAccountDialog', Template, InternalChildren: ['nav'] }, this);
    }

    private get nav(): Adw.NavigationView {
        return this._nav;
    }

    private readonly done: AddAccountResult;
    /** Read once, never written by the dialog itself; null without a workspace (nothing to assign to). */
    private readonly manifest: Manifest | null;

    constructor(done: AddAccountResult) {
        super();
        this.done = done;
        let manifest: Manifest | null = null;
        try {
            manifest = loadManifest();
        } catch {
            // No workspace yet — the account still lands in the store, it just cannot be routed.
        }
        this.manifest = manifest;
        this.nav.push(this.pageChoose());
    }

    /**
     * Jump straight to one page — the dev hook behind `STEUER_APP_ADD_ACCOUNT`. A page nobody can
     * screenshot is a page nobody checks, and these are forms where a blank label or a broken layout
     * would ship unseen. `assign` shows the last page for a placeholder FinTS connection.
     */
    openPage(page: string): void {
        if (page === 'file') this.nav.push(this.pageFile());
        else if (page === 'qonto') this.nav.push(this.pageQonto());
        else if (page === 'fints') this.nav.push(this.pageFints());
        else if (page === 'assign') {
            this.nav.push(
                this.pageAssign({
                    label: 'FinTS · Musterbank',
                    pattern: connectionAccountPattern('fints', 'Musterbank'),
                    commit: () => Promise.reject(new Error(_('Preview only — nothing was saved.'))),
                }),
            );
        }
    }

    // ── Shell ─────────────────────────────────────────────────────────────────────────────────

    private page(title: string, body: Gtk.Widget, primary?: { label: string; run: () => void }): Adw.NavigationPage {
        return new BhAddAccountPage(title, body, primary);
    }

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

    private navRow(title: string, subtitle: string, icon: string, go: () => void): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: markup(title), subtitle: markup(subtitle) });
        row.add_prefix(new Gtk.Image({ iconName: icon }));
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
        row.set_activatable(true);
        row.connect('activated', go);
        return row;
    }

    private caption(text: string): Gtk.Label {
        return new Gtk.Label({ label: text, wrap: true, xalign: 0, cssClasses: ['dim-label', 'caption'] });
    }

    /** A row that closes the dialog and opens Settings — for what is configured there, not here. */
    private settingsRow(subtitle: string): Adw.ActionRow {
        return this.navRow(_('Settings'), subtitle, 'preferences-system-symbolic', () => {
            navigateTo(this, 'settings');
            this.close();
        });
    }

    private fail(banner: Adw.Banner, text: string): void {
        banner.set_title(markup(text));
        banner.set_revealed(true);
    }

    /** Finish: report and close. Failures keep the dialog open so the input can be corrected. */
    private finish(message: string): void {
        this.done(message, true);
        this.close();
    }

    // ── 1 · Which way in ──────────────────────────────────────────────────────────────────────

    private pageChoose(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: _('Where do the transactions come from?'),
            description: _(
                'A file is enough to start — the statement your bank offers for download in online ' +
                    'banking. A live connection fetches new transactions by itself later.',
            ),
        });
        group.add(
            this.navRow(
                _('Import a file (CAMT or CSV)'),
                _('A statement export from your online banking — no login needed'),
                'document-open-symbolic',
                () => this.nav.push(this.pageFile()),
            ),
        );
        group.add(
            this.navRow(
                _('Connect Qonto'),
                _('Fetches transactions through the Qonto API — needs login and secret key'),
                'network-server-symbolic',
                () => this.nav.push(this.pageQonto()),
            ),
        );
        group.add(
            this.navRow(
                _('Bank via FinTS/HBCI'),
                _('Almost every German bank — needs your bank’s access details and PIN'),
                'network-wired-symbolic',
                () => this.nav.push(this.pageFints()),
            ),
        );
        box.append(group);
        box.append(this.caption(_('Nothing is saved until you confirm on the last page.')));
        return this.page(_('Add account'), box);
    }

    // ── 2a · File import ──────────────────────────────────────────────────────────────────────

    private pageFile(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });
        const choices = formats();
        let chosenPath = '';

        const group = new Adw.PreferencesGroup({
            title: _('Import a file'),
            description: _('The format is detected from the file name; for CSV it can be set here.'),
        });

        const file = new Adw.ActionRow({ title: _('File'), subtitle: markup(_('None chosen yet')) });
        const pick = new Gtk.Button({ label: _('Choose file …'), valign: Gtk.Align.CENTER });
        pick.connect('clicked', () => {
            void this.chooseFile().then((path) => {
                if (!path) return;
                chosenPath = path;
                file.set_subtitle(markup(basename(path)));
                banner.set_revealed(false);
            });
        });
        file.add_suffix(pick);
        group.add(file);

        const format = new Adw.ComboRow({
            title: _('Format'),
            model: Gtk.StringList.new([_('Detect automatically'), ...choices.map((f) => f.label)]),
        });
        const describe = () => {
            const i = format.get_selected();
            format.set_subtitle(i === 0 ? _('From the file extension') : (choices[i - 1]?.hint ?? ''));
        };
        describe();
        format.connect('notify::selected', describe);
        group.add(format);

        const full = new Adw.SwitchRow({
            title: _('Import everything'),
            subtitle: _(
                'By default only transactions older than the existing ones are taken — that avoids ' +
                    'duplicates where the files overlap.',
            ),
        });
        group.add(full);
        box.append(group);
        box.append(banner);
        box.append(
            this.caption(
                _('A wrong import can be undone: every import is kept as a batch and can be taken back as a whole.'),
            ),
        );

        return this.page(_('File'), box, {
            label: _('Next'),
            run: () => {
                if (!chosenPath) return this.fail(banner, _('Please choose a file first.'));
                const filename = basename(chosenPath);
                const chosen = format.get_selected();
                const resolved = (chosen > 0 ? choices[chosen - 1]?.id : undefined) ?? detectFormat(filename);
                if (!resolved) {
                    // A .csv is genuinely ambiguous (PayPal or Amazon), so say which choice is missing
                    // rather than guessing and importing the wrong shape.
                    return this.fail(
                        banner,
                        fmt(_('Cannot tell the format of “{file}” — please choose one above.'), { file: filename }),
                    );
                }
                const pending = this.fileImport(chosenPath, resolved, full.get_active());
                // An enrich-only file adds no account, so there is nothing to assign: import right here.
                if (ENRICH_ONLY.has(resolved) || !this.manifest) {
                    void pending.commit().then(
                        (r) => this.finish(r.message),
                        (err) => this.fail(banner, fmt(_('Import failed: {error}'), { error: msg(err) })),
                    );
                    return;
                }
                this.nav.push(this.pageAssign(pending));
            },
        });
    }

    private chooseFile(): Promise<string | null> {
        // pickFile wants the toplevel WINDOW; an Adw.Dialog is not one, and passing `this` only
        // fails at type-check — at runtime it would present a file chooser with no parent.
        const root = this.get_root() as Gtk.Window | null;
        if (!root) return Promise.resolve(null);
        return pickFile(root, {
            title: _('Choose a statement or export'),
            filters: [
                { name: _('All supported'), patterns: ['*.xml', '*.csv', '*.xls', '*.xlsx'] },
                { name: 'CAMT (*.xml)', patterns: ['*.xml'] },
                { name: 'CSV (*.csv)', patterns: ['*.csv'] },
                { name: _('Qonto export (*.xls, *.xlsx)'), patterns: ['*.xls', '*.xlsx'] },
            ],
        });
    }

    /** The import as a pending write: the file is read and handed to the shared action on commit. */
    private fileImport(path: string, format: ImportFormat, full: boolean): PendingAccount {
        const filename = basename(path);
        return {
            label: filename,
            commit: async () => {
                const result = await runImport(format, filename, readFileSync(path), { full });
                const added = (result.reports ?? []).reduce((n, r) => n + (r.added ?? 0), 0);
                const message = result.reports
                    ? fmt(_('{file}: {count} new transactions imported.'), { file: filename, count: added })
                    : fmt(_('{file}: {count} transactions enriched.'), {
                          file: filename,
                          count: result.enrich?.updated ?? 0,
                      });
                return { message, keys: importedAccountKeys(result) };
            },
        };
    }

    // ── 2b · Qonto ────────────────────────────────────────────────────────────────────────────

    private pageQonto(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });

        const group = new Adw.PreferencesGroup({
            title: _('Connect Qonto'),
            description: _('Login and secret key are in your Qonto account under Settings → API.'),
        });
        const login = new Adw.EntryRow({ title: _('Login') });
        group.add(login);
        const secret = new Adw.PasswordEntryRow({ title: _('Secret key') });
        group.add(secret);
        const env = new Adw.ComboRow({
            title: _('Environment'),
            model: Gtk.StringList.new([_('Production'), 'Staging']),
        });
        group.add(env);
        box.append(group);
        box.append(banner);
        box.append(
            this.caption(_('The credentials are stored in the local .env file — they never leave this computer.')),
        );

        const more = new Adw.PreferencesGroup();
        more.add(this.settingsRow(_('How often transactions and invoices are fetched')));
        box.append(more);

        return this.page('Qonto', box, {
            label: _('Next'),
            run: () => {
                const l = (login.get_text() ?? '').trim();
                const s = (secret.get_text() ?? '').trim();
                if (!l || !s) return this.fail(banner, _('Login and secret key are required.'));
                const staging = env.get_selected() === 1;
                this.nav.push(
                    this.pageAssign({
                        label: _('Qonto (every account of the connection)'),
                        pattern: connectionAccountPattern('qonto'),
                        commit: () => {
                            const { env: chosen } = connectQonto({
                                login: l,
                                secretKey: s,
                                env: staging ? 'staging' : 'production',
                            });
                            const message = fmt(_('Qonto connected ({env}). Sync now to fetch transactions.'), {
                                env: chosen,
                            });
                            return Promise.resolve({ message, keys: [connectionAccountPattern('qonto')] });
                        },
                    }),
                );
            },
        });
    }

    // ── 2c · FinTS ────────────────────────────────────────────────────────────────────────────

    private pageFints(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });

        const group = new Adw.PreferencesGroup({
            title: _('Bank via FinTS/HBCI'),
            description: _(
                'Your bank provides the bank code and FinTS URL; the product ID is the registration ' +
                    'number issued for the access.',
            ),
        });
        const fields = {
            name: new Adw.EntryRow({ title: _('Name (your choice)') }),
            url: new Adw.EntryRow({ title: _('FinTS URL') }),
            blz: new Adw.EntryRow({ title: _('Bank code (BLZ)') }),
            user_id: new Adw.EntryRow({ title: _('User ID') }),
            product_id: new Adw.EntryRow({ title: _('Product ID') }),
            pin: new Adw.PasswordEntryRow({ title: 'PIN' }),
        };
        for (const row of Object.values(fields)) group.add(row);
        box.append(group);
        box.append(banner);
        box.append(this.caption(_('The PIN is stored in the local .env file — it never leaves this computer.')));

        const more = new Adw.PreferencesGroup();
        more.add(this.settingsRow(_('Automatic sync and the connection test')));
        box.append(more);

        return this.page('FinTS', box, {
            label: _('Next'),
            run: () => {
                const values = {
                    name: (fields.name.get_text() ?? '').trim(),
                    url: (fields.url.get_text() ?? '').trim(),
                    blz: (fields.blz.get_text() ?? '').trim(),
                    user_id: (fields.user_id.get_text() ?? '').trim(),
                    product_id: (fields.product_id.get_text() ?? '').trim(),
                    pin: (fields.pin.get_text() ?? '').trim(),
                };
                // Name the empty fields. "All fields are required" over six inputs makes the user
                // re-check every one of them.
                const missing = (Object.keys(values) as Array<keyof typeof values>)
                    .filter((k) => !values[k])
                    .map((k) => fields[k].get_title());
                if (missing.length > 0) {
                    return this.fail(banner, fmt(_('Still empty: {fields}'), { fields: missing.join(', ') }));
                }
                const pattern = connectionAccountPattern('fints', values.name);
                this.nav.push(
                    this.pageAssign({
                        label: `FinTS · ${values.name}`,
                        pattern,
                        commit: () => {
                            connectFints(values);
                            const message = fmt(_('Bank “{name}” connected. Sync now to fetch transactions.'), {
                                name: values.name,
                            });
                            return Promise.resolve({ message, keys: [pattern] });
                        },
                    }),
                );
            },
        });
    }

    // ── 3 · Which entity ──────────────────────────────────────────────────────────────────────

    private pageAssign(pending: PendingAccount): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });
        const entities = this.manifest?.entities ?? [];

        const group = new Adw.PreferencesGroup({
            title: _('Which entity does the account belong to?'),
            description: _('Its transactions count for this entity’s returns. You can move it later.'),
        });
        group.add(
            new Adw.ActionRow({ title: _('Account'), subtitle: markup(pending.label), cssClasses: ['property'] }),
        );
        const entity = new Adw.ComboRow({
            title: _('Entity'),
            model: Gtk.StringList.new([_('Later'), ...entities.map((e) => e.name)]),
        });
        const owner = pending.pattern ? accountOwner(this.manifest, pending.pattern) : undefined;
        const preselect = owner ? entities.findIndex((e) => e.id === owner.id) : 0;
        entity.set_selected(entities.length === 0 ? 0 : preselect + 1);
        if (owner) entity.set_subtitle(markup(fmt(_('Currently: {entity}'), { entity: owner.name })));
        group.add(entity);
        box.append(group);
        box.append(banner);
        box.append(this.caption(_('With “Later” the account is added but counts for no entity until you assign it.')));

        return this.page(_('Entity'), box, {
            label: _('Add account'),
            run: () => {
                const target = entities[entity.get_selected() - 1];
                if (target && pending.pattern) {
                    // Refuse BEFORE the write: a connection saved to .env but rejected by the GoBD
                    // lock would be half an account.
                    try {
                        assertAccountsMovable([pending.pattern], target.id, this.manifest as Manifest);
                    } catch (err) {
                        return this.fail(banner, msg(err));
                    }
                }
                void pending.commit().then(
                    ({ message, keys }) => this.finish(target ? this.assign(message, keys, target.id) : message),
                    (err) => this.fail(banner, fmt(_('Adding failed: {error}'), { error: msg(err) })),
                );
            },
        });
    }

    /** Route `keys` to the entity; the write already happened, so a failure here only adds a note. */
    private assign(message: string, keys: string[], entityId: string): string {
        try {
            const shared = new Set<string>();
            for (const key of keys) for (const e of assignAccount(key, entityId).sharedWith) shared.add(e.name);
            if (shared.size === 0) return message;
            return `${message} ${fmt(_('It also still counts for {entities} through a pattern.'), {
                entities: [...shared].join(', '),
            })}`;
        } catch (err) {
            return `${message} ${fmt(_('Not assigned: {error}'), { error: msg(err) })}`;
        }
    }
}
