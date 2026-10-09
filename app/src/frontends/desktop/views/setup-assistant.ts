/**
 * Setup — the path from "installed" to "usable", and later from "one entity" to "two", without a
 * terminal.
 *
 * Launched from the application menu with no configuration, the app used to invent a pseudo-entity
 * called "Steuererklärung" (`window.ts` → `loadData`) and show every view against it. Nothing about
 * that entity exists in a manifest, so every single save failed: the Einstellungen banner said
 * "Kein Manifest … zum Speichern vorhanden", and the only real instruction — run `steuer config
 * migrate` — was a command in a terminal the user was specifically avoiding.
 *
 * The assistant has two modes over the same pages; which pages a mode shows is decided by
 * `entitySetupPages` in `core/actions/entity-setup.ts`, where it is tested without a display.
 *
 *   FIRST RUN — Willkommen (what happens next, and WHERE the files will land: a stranger installing a
 *   tax application deserves to be told where their tax data is going before it goes there) →
 *   Entität (name, kind, optional Steuernummer) → Belege → Fertig.
 *
 *   NEW ENTITY — the workspace exists, so where the files land is already known and saying it again
 *   is noise. It starts at the choice between private and business and then asks only what fits:
 *   Kleinunternehmer, USt-VA-Zeitraum and Steuernummer for a business; Steuernummer and
 *   Zusammenveranlagung for a household. Then the bank accounts, then Belege — preselected with the
 *   Paperless instance the other entities already use.
 *
 * There is deliberately no separate Finanzamt field: the schema has none, and the office is already
 * encoded in the Steuernummer's leading digits — a field for it would be a second truth.
 *
 * Every question can be answered with "Later", which writes nothing for it. Nothing at all is written
 * before the last page: a cancelled assistant leaves the disk exactly as it was, which matters
 * because half a configuration is worse than none — the app would then find a manifest, stop
 * offering setup, and leave the user inside a broken installation.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { getStoreDir } from '@steuererklaerung/store';
import {
    accountOwner,
    applyEntitySetup,
    type EntitySetupDraft,
    type EntitySetupKind,
    type EntitySetupMode,
    type EntitySetupPage,
    newEntitySetupDraft,
    nextEntitySetupPage,
} from '../../../core/actions/entity-setup.ts';
import { isFirstRun } from '../../../core/actions/entities.ts';
import { transactionsSummary } from '../../../core/actions/transactions.ts';
import { getManifestPath, loadManifest, type Manifest } from '../../../core/config/index.ts';
import { _, fmt } from '../i18n.ts';
import { markup } from './util.ts';

interface KindChoice {
    id: EntitySetupKind;
    label: string;
    hint: string;
}

function kinds(): KindChoice[] {
    return [
        { id: 'privat', label: _('Private'), hint: _('No business: wages, work expenses, household services') },
        {
            id: 'einzelunternehmen',
            label: _('Sole proprietorship'),
            hint: _('Trade or freelance work in your own name'),
        },
        { id: 'gbr', label: _('Partnership (GbR)'), hint: _('Several partners, separate assessment') },
    ];
}

/** Combo choices whose first entry is "Later" — `undefined` in the draft. */
function laterCombo<T>(title: string, choices: Array<[T, string]>, current: T | undefined): Adw.ComboRow {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new([_('Later'), ...choices.map(([, label]) => label)]),
    });
    const i = choices.findIndex(([v]) => v === current);
    row.set_selected(i < 0 ? 0 : i + 1);
    return row;
}

function laterValue<T>(row: Adw.ComboRow, choices: Array<[T, string]>): T | undefined {
    const i = row.get_selected();
    return i === 0 ? undefined : choices[i - 1]?.[0];
}

export class BhSetupAssistant extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhSetupAssistant' }, this);
    }

    private readonly nav = new Adw.NavigationView();
    private readonly mode: EntitySetupMode;
    /** The workspace as it was when the assistant opened — read-only; null on the first run. */
    private readonly manifest: Manifest | null;
    private readonly draft: EntitySetupDraft;
    /** Set once setup succeeded, so the caller knows whether to reload rather than guessing. */
    private completed = false;
    private readonly onDone: () => void;

    constructor(onDone: () => void) {
        super();
        this.onDone = onDone;
        this.mode = isFirstRun() ? 'first-run' : 'new-entity';
        this.manifest = this.mode === 'new-entity' ? loadManifest() : null;
        this.draft = newEntitySetupDraft(this.manifest, this.mode === 'new-entity' ? 'privat' : 'einzelunternehmen');
        this.set_title(this.mode === 'first-run' ? _('Setup') : _('New entity'));
        this.set_content_width(560);
        this.set_content_height(620);
        this.set_child(this.nav);
        const hookPage = this.fillHookPlaceholders();
        this.nav.push(this.build(this.mode === 'first-run' ? 'welcome' : 'kind'));
        if (hookPage && hookPage !== 'welcome' && hookPage !== 'kind') this.nav.push(this.build(hookPage));
    }

    /**
     * `STEUER_APP_SETUP_PAGE=<page>` opens the assistant on that page (`entity|dms|finish` on a first
     * run, `kind|business|private|accounts|dms|finish` for a new entity).
     *
     * Same shape as the other STEUER_APP_* hooks, and it exists for the same reason: a page that
     * cannot be screenshotted is a page nobody looks at. Fills the fields it skipped past with
     * placeholders, since the later pages assume the earlier ones ran.
     */
    private fillHookPlaceholders(): EntitySetupPage | undefined {
        const page = globalThis.process?.env?.STEUER_APP_SETUP_PAGE as EntitySetupPage | undefined;
        if (!page) return undefined;
        if (page === 'business') this.draft.kind = 'gbr';
        if (!this.draft.name) {
            this.draft.name = this.draft.kind === 'gbr' ? 'Muster & Partner GbR' : 'Erika Muster';
            this.draft.taxNumber = '11/222/33333';
        }
        return page;
    }

    /** True when the assistant actually wrote a configuration. */
    get didComplete(): boolean {
        return this.completed;
    }

    private build(page: EntitySetupPage): Adw.NavigationPage {
        switch (page) {
            case 'welcome':
                return this.pageWelcome();
            case 'entity':
                return this.pageEntity();
            case 'kind':
                return this.pageKind();
            case 'business':
                return this.pageBusiness();
            case 'private':
                return this.pagePrivate();
            case 'accounts':
                return this.pageAccounts();
            case 'dms':
                return this.pageDms();
            case 'finish':
                return this.pageFinish();
        }
    }

    /** Push the page that follows `current` for this mode and the kind chosen so far. */
    private advance(current: EntitySetupPage): void {
        const next = nextEntitySetupPage(this.mode, this.draft.kind, current);
        if (next) this.nav.push(this.build(next));
    }

    // ── Page shell ────────────────────────────────────────────────────────────────────────────

    /**
     * One page. `later` adds a second button that skips the page's questions — the run continues
     * and nothing is written for them.
     */
    private page(
        tag: string,
        title: string,
        body: Gtk.Widget,
        primary: { label: string; run: () => void },
        later?: () => void,
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
        if (later) {
            const skip = new Gtk.Button({ label: _('Later') });
            skip.add_css_class('pill');
            skip.connect('clicked', later);
            bottom.append(skip);
        }
        const button = new Gtk.Button({ label: primary.label });
        button.add_css_class('suggested-action');
        button.add_css_class('pill');
        button.connect('clicked', primary.run);
        bottom.append(button);
        toolbar.add_bottom_bar(bottom);

        const page = new Adw.NavigationPage({ title, child: toolbar });
        page.set_tag(tag);
        return page;
    }

    // ── First run · Willkommen ────────────────────────────────────────────────────────────────

    private pageWelcome(): Adw.NavigationPage {
        const box = this.column();

        const status = new Adw.StatusPage({
            iconName: 'accessories-calculator-symbolic',
            title: _('Welcome'),
            description: markup(
                _(
                    'This app works out the profit statement, VAT and income tax from your bank ' +
                        'transactions and receipts. A name is all it takes to start.',
                ),
            ),
        });
        box.append(status);

        // Say where the data goes BEFORE it goes there. The ACTUAL destination, not the XDG default:
        // with STEUER_WORKSPACE or TRANSACTIONS_DATA_DIR set, or a manifest already in the working
        // directory, the write goes somewhere else entirely — and a promise about the wrong path is
        // worse than no promise.
        const where = new Adw.PreferencesGroup({ title: _('Where your data will be stored') });
        where.add(this.readOnlyRow(_('Configuration'), getManifestPath()));
        where.add(this.readOnlyRow(_('Transactions and receipts'), getStoreDir()));
        box.append(where);

        return this.page('welcome', _('Welcome'), box, {
            label: _('Let’s go'),
            run: () => this.advance('welcome'),
        });
    }

    // ── First run · Entität ───────────────────────────────────────────────────────────────────

    private pageEntity(): Adw.NavigationPage {
        const box = this.column();

        const group = new Adw.PreferencesGroup({
            title: _('Who are we filing for?'),
            description: _('Name and kind can be changed at any time.'),
        });

        const name = new Adw.EntryRow({ title: _('Name') });
        name.set_text(this.draft.name);
        group.add(name);

        const choices = kinds();
        const kind = new Adw.ComboRow({ title: _('Kind'), model: Gtk.StringList.new(choices.map((k) => k.label)) });
        kind.set_selected(
            Math.max(
                0,
                choices.findIndex((k) => k.id === this.draft.kind),
            ),
        );
        kind.set_subtitle(choices[kind.get_selected()]?.hint ?? '');
        kind.connect('notify::selected', () => {
            const chosen = choices[kind.get_selected()];
            if (chosen) {
                this.draft.kind = chosen.id;
                kind.set_subtitle(chosen.hint);
            }
        });
        group.add(kind);
        box.append(group);

        const tax = new Adw.PreferencesGroup({
            title: _('Tax details'),
            description: _(
                'Optional — you can add them later in the settings. The tax office is already part of ' +
                    'the tax number and is not asked for separately.',
            ),
        });
        const steuernummer = new Adw.EntryRow({ title: _('Tax number') });
        steuernummer.set_text(this.draft.taxNumber);
        tax.add(steuernummer);
        box.append(tax);

        const error = new Adw.Banner({ revealed: false });
        box.append(error);

        return this.page('entity', _('Entity'), box, {
            label: _('Next'),
            run: () => {
                this.draft.taxNumber = (steuernummer.get_text() ?? '').trim();
                if (this.takeName(name, error)) this.advance('entity');
            },
        });
    }

    // ── New entity · Art ──────────────────────────────────────────────────────────────────────

    private pageKind(): Adw.NavigationPage {
        const box = this.column();

        const group = new Adw.PreferencesGroup({
            title: _('Private or business?'),
            description: _('This decides which questions follow. Everything can be changed later.'),
        });
        let first: Gtk.CheckButton | null = null;
        for (const k of kinds()) {
            const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER });
            if (first) check.set_group(first);
            else first = check;
            check.set_active(k.id === this.draft.kind);
            check.connect('toggled', () => {
                if (check.get_active()) this.draft.kind = k.id;
            });
            const row = new Adw.ActionRow({
                title: markup(k.label),
                subtitle: markup(k.hint),
                activatableWidget: check,
            });
            row.add_prefix(check);
            group.add(row);
        }
        box.append(group);

        const named = new Adw.PreferencesGroup();
        const name = new Adw.EntryRow({ title: _('Name') });
        name.set_text(this.draft.name);
        named.add(name);
        box.append(named);

        const error = new Adw.Banner({ revealed: false });
        box.append(error);

        return this.page('kind', _('Kind'), box, {
            label: _('Next'),
            run: () => {
                if (this.takeName(name, error)) this.advance('kind');
            },
        });
    }

    // ── New entity · Betrieb ──────────────────────────────────────────────────────────────────

    private pageBusiness(): Adw.NavigationPage {
        const box = this.column();

        const ust = new Adw.PreferencesGroup({
            title: _('VAT'),
            description: _('If you are not sure yet, choose “Later” — nothing is assumed for it.'),
        });
        const kleinChoices: Array<[boolean, string]> = [
            [false, _('No, I charge VAT')],
            [true, _('Yes, small business (§ 19 UStG)')],
        ];
        const klein = laterCombo(_('Small business'), kleinChoices, this.draft.kleinunternehmer);
        ust.add(klein);
        const cadenceChoices: Array<['month' | 'quarter', string]> = [
            ['month', _('Monthly')],
            ['quarter', _('Quarterly')],
        ];
        const cadence = laterCombo(_('VAT return period'), cadenceChoices, this.draft.ustCadence);
        cadence.set_subtitle(_('Annual-only filers keep “Later”.'));
        ust.add(cadence);
        box.append(ust);

        const steuernummer = this.taxNumberGroup(box);

        return this.page(
            'business',
            _('Business'),
            box,
            {
                label: _('Next'),
                run: () => {
                    this.draft.kleinunternehmer = laterValue(klein, kleinChoices);
                    this.draft.ustCadence = laterValue(cadence, cadenceChoices);
                    this.draft.taxNumber = (steuernummer.get_text() ?? '').trim();
                    this.advance('business');
                },
            },
            () => {
                this.draft.kleinunternehmer = undefined;
                this.draft.ustCadence = undefined;
                this.draft.taxNumber = '';
                this.advance('business');
            },
        );
    }

    // ── New entity · Privat ───────────────────────────────────────────────────────────────────

    private pagePrivate(): Adw.NavigationPage {
        const box = this.column();

        const est = new Adw.PreferencesGroup({
            title: _('Income tax'),
            description: _('Joint assessment is for married couples and civil partners filing together.'),
        });
        const veranlagungChoices: Array<['einzel' | 'splitting', string]> = [
            ['einzel', _('Individual assessment')],
            ['splitting', _('Joint assessment (splitting)')],
        ];
        const veranlagung = laterCombo(_('Assessment'), veranlagungChoices, this.draft.veranlagung);
        est.add(veranlagung);
        box.append(est);

        const steuernummer = this.taxNumberGroup(box);

        return this.page(
            'private',
            _('Private'),
            box,
            {
                label: _('Next'),
                run: () => {
                    this.draft.veranlagung = laterValue(veranlagung, veranlagungChoices);
                    this.draft.taxNumber = (steuernummer.get_text() ?? '').trim();
                    this.advance('private');
                },
            },
            () => {
                this.draft.veranlagung = undefined;
                this.draft.taxNumber = '';
                this.advance('private');
            },
        );
    }

    // ── New entity · Bankkonten ───────────────────────────────────────────────────────────────

    private pageAccounts(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: _('Which bank accounts belong to it?'),
            description: _(
                'A ticked account moves to the new entity. New accounts are added under Accounts → ' +
                    'Connections & import.',
            ),
        });

        const checks: Array<{ key: string; check: Gtk.CheckButton }> = [];
        for (const key of this.storeAccountKeys()) {
            const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: this.draft.accounts.includes(key) });
            const owner = accountOwner(this.manifest, key);
            const row = new Adw.ActionRow({
                title: markup(key),
                subtitle: markup(owner ? fmt(_('Currently: {entity}'), { entity: owner.name }) : _('Not assigned')),
                activatableWidget: check,
            });
            row.add_prefix(check);
            group.add(row);
            checks.push({ key, check });
        }
        if (checks.length === 0) {
            group.add(this.readOnlyRow(_('No bank accounts yet'), _('Add one under Accounts once the entity exists.')));
        }
        box.append(group);

        return this.page(
            'accounts',
            _('Bank accounts'),
            box,
            {
                label: _('Next'),
                run: () => {
                    this.draft.accounts = checks.filter((c) => c.check.get_active()).map((c) => c.key);
                    this.advance('accounts');
                },
            },
            () => {
                this.draft.accounts = [];
                this.advance('accounts');
            },
        );
    }

    // ── Belege ────────────────────────────────────────────────────────────────────────────────

    private pageDms(): Adw.NavigationPage {
        const box = this.column();
        const shared = this.draft.dmsFrom !== undefined;

        const group = new Adw.PreferencesGroup({
            title: _('Where do the receipts come from?'),
            description: shared
                ? _('Same as your other entities. You can still choose differently.')
                : _(
                      'The built-in document management needs nothing else. Use Paperless-ngx if you ' +
                          'already keep your receipts there.',
                  ),
        });

        const choice = new Adw.ComboRow({
            title: _('Receipt source'),
            model: Gtk.StringList.new([_('Built-in document management'), 'Paperless-ngx']),
        });
        choice.set_selected(this.draft.dms === 'paperless' ? 1 : 0);
        group.add(choice);
        box.append(group);

        const paperless = new Adw.PreferencesGroup({
            title: 'Paperless-ngx',
            description: shared
                ? _('Leave the token empty to use the one your other entities use.')
                : _('URL and API token. The token is stored in the configuration file only you can read.'),
        });
        const url = new Adw.EntryRow({ title: _('URL') });
        url.set_text(this.draft.paperlessUrl);
        paperless.add(url);
        const token = new Adw.PasswordEntryRow({ title: _('API token') });
        token.set_text(this.draft.paperlessToken);
        paperless.add(token);
        paperless.set_visible(choice.get_selected() === 1);
        choice.connect('notify::selected', () => paperless.set_visible(choice.get_selected() === 1));
        box.append(paperless);

        const take = () => {
            this.draft.dms = choice.get_selected() === 1 ? 'paperless' : 'builtin';
            this.draft.paperlessUrl = (url.get_text() ?? '').trim();
            this.draft.paperlessToken = (token.get_text() ?? '').trim();
            this.advance('dms');
        };
        // "Later" keeps the default: built-in, or the shared Paperless instance.
        return this.page('dms', _('Receipts'), box, { label: _('Next'), run: take }, () => this.advance('dms'));
    }

    // ── Fertig ────────────────────────────────────────────────────────────────────────────────

    private pageFinish(): Adw.NavigationPage {
        const box = this.column();
        const d = this.draft;
        const later = _('Later');
        const summary = new Adw.PreferencesGroup({ title: _('Summary') });
        summary.add(this.readOnlyRow(_('Name'), d.name));
        summary.add(this.readOnlyRow(_('Kind'), kinds().find((k) => k.id === d.kind)?.label ?? d.kind));
        summary.add(this.readOnlyRow(_('Tax number'), d.taxNumber || later));
        if (this.mode === 'new-entity' && d.kind !== 'privat') {
            const klein = d.kleinunternehmer === undefined ? later : d.kleinunternehmer ? _('Yes') : _('No');
            summary.add(this.readOnlyRow(_('Small business'), klein));
            const cadence =
                d.ustCadence === 'month' ? _('Monthly') : d.ustCadence === 'quarter' ? _('Quarterly') : later;
            summary.add(this.readOnlyRow(_('VAT return period'), cadence));
        }
        if (this.mode === 'new-entity' && d.kind === 'privat') {
            const v =
                d.veranlagung === 'splitting'
                    ? _('Joint assessment (splitting)')
                    : d.veranlagung === 'einzel'
                      ? _('Individual assessment')
                      : later;
            summary.add(this.readOnlyRow(_('Assessment'), v));
        }
        if (this.mode === 'new-entity') {
            summary.add(this.readOnlyRow(_('Bank accounts'), d.accounts.length ? d.accounts.join(', ') : later));
        }
        summary.add(
            this.readOnlyRow(
                _('Receipts'),
                d.dms === 'paperless' ? 'Paperless-ngx' : _('Built-in document management'),
            ),
        );
        if (this.mode === 'first-run') summary.add(this.readOnlyRow(_('Configuration'), getManifestPath()));
        box.append(summary);

        const error = new Adw.Banner({ revealed: false });
        box.append(error);

        return this.page('finish', _('Done'), box, {
            label: this.mode === 'first-run' ? _('Finish setup') : _('Add entity'),
            run: () => {
                try {
                    applyEntitySetup(this.draft);
                    this.completed = true;
                    this.close();
                    this.onDone();
                } catch (err) {
                    // One validated write: on failure nothing is on disk, so stay open and say why.
                    error.set_title(
                        markup(
                            fmt(_('Setup failed: {error}'), {
                                error: err instanceof Error ? err.message : String(err),
                            }),
                        ),
                    );
                    error.set_revealed(true);
                }
            },
        });
    }

    // ── Small helpers ─────────────────────────────────────────────────────────────────────────

    /** Read the required name; show `error` and return false when it is empty. */
    private takeName(entry: Adw.EntryRow, error: Adw.Banner): boolean {
        this.draft.name = (entry.get_text() ?? '').trim();
        if (!this.draft.name) {
            error.set_title(markup(_('Please enter a name.')));
            error.set_revealed(true);
            return false;
        }
        error.set_revealed(false);
        return true;
    }

    private taxNumberGroup(box: Gtk.Box): Adw.EntryRow {
        const tax = new Adw.PreferencesGroup({
            title: _('Tax number'),
            description: _('Optional. The tax office is already part of the tax number.'),
        });
        const row = new Adw.EntryRow({ title: _('Tax number') });
        row.set_text(this.draft.taxNumber);
        tax.add(row);
        box.append(tax);
        return row;
    }

    /** Every account the store knows. Empty — not an error — when there is no store yet. */
    private storeAccountKeys(): string[] {
        try {
            return transactionsSummary().accounts.map((a) => a.accountKey);
        } catch {
            return [];
        }
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

    /** A value the user should see but not edit here (a path, a summary line). */
    private readOnlyRow(title: string, value: string): Adw.ActionRow {
        // Both halves are Pango markup — a Windows-style path or an `&` in a firm name would
        // otherwise render the row blank with no error anywhere.
        const row = new Adw.ActionRow({ title: markup(title), subtitle: markup(value) });
        row.add_css_class('property');
        return row;
    }
}
