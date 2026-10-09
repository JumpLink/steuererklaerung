/**
 * First-run setup — the path from "installed" to "usable", without a terminal.
 *
 * Launched from the application menu with no configuration, the app used to invent a pseudo-entity
 * called "Steuererklärung" (`window.ts` → `loadData`) and show every view against it. Nothing about
 * that entity exists in a manifest, so every single save failed: the Einstellungen banner said
 * "Kein Manifest … zum Speichern vorhanden", and the only real instruction — run `steuer config
 * migrate` — was a command in a terminal the user was specifically avoiding.
 *
 * This is the replacement. Four pages, and only the first two ask for anything:
 *
 *   1. Willkommen — what happens next, and WHERE the files will land. A stranger installing a tax
 *      application deserves to be told where their tax data is going before it goes there.
 *   2. Entität — display name, kind, and the Steuernummer, which is optional here so nobody is
 *      blocked by a document they have to go and find. There is deliberately no separate Finanzamt
 *      field: the schema has none, and the office is already encoded in the Steuernummer's leading
 *      digits — inventing a field for it would be a second truth about the same fact.
 *   3. Belege — built-in DMS or Paperless. The default answers itself; Paperless takes a URL and a
 *      token, and skipping it is a valid answer.
 *   4. Fertig — a summary, then one button that actually writes.
 *
 * Nothing is written before the last page. A cancelled assistant leaves the disk exactly as it was,
 * which matters because half a configuration is worse than none: the app would then find a manifest,
 * stop offering setup, and leave the user inside a broken installation.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { getStoreDir } from '@steuererklaerung/store';
import { addEntity, initWorkspace, isFirstRun } from '../../../core/actions/entities.ts';
import {
    ensureElsterSection,
    getManifestPath,
    slugFromName,
    saveElsterTaxNumber,
    saveEntityDms,
} from '../../../core/config/index.ts';
import { markup } from './util.ts';

/** What the assistant collected. Everything optional except name and kind. */
interface SetupInput {
    name: string;
    kind: 'einzelunternehmen' | 'gbr' | 'privat';
    id: string;
    taxNumber: string;
    dms: 'builtin' | 'paperless';
    paperlessUrl: string;
    paperlessToken: string;
}

const KINDS: Array<{ id: SetupInput['kind']; label: string; hint: string }> = [
    { id: 'einzelunternehmen', label: 'Einzelunternehmen', hint: 'Gewerbe oder Freiberuf auf eigenen Namen' },
    { id: 'gbr', label: 'Personengesellschaft (GbR)', hint: 'Mehrere Gesellschafter, gesonderte Feststellung' },
    { id: 'privat', label: 'Privat (nur Einkommensteuer)', hint: 'Kein Betrieb — Lohn, Werbungskosten, § 35a' },
];

export class BhSetupAssistant extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhSetupAssistant' }, this);
    }

    private readonly nav = new Adw.NavigationView();
    private readonly input: SetupInput = {
        name: '',
        kind: 'einzelunternehmen',
        id: '',
        taxNumber: '',
        dms: 'builtin',
        paperlessUrl: '',
        paperlessToken: '',
    };
    /** Set once setup succeeded, so the caller knows whether to reload rather than guessing. */
    private completed = false;
    private readonly onDone: () => void;

    constructor(onDone: () => void) {
        super();
        this.onDone = onDone;
        this.set_title('Einrichtung');
        this.set_content_width(560);
        this.set_content_height(620);
        this.set_child(this.nav);
        this.nav.push(this.pageWelcome());
        this.applyStartPageHook();
    }

    /**
     * `STEUER_APP_SETUP_PAGE=entity|dms|finish` opens the assistant on that page.
     *
     * Same shape as the other STEUER_APP_* hooks, and it exists for the same reason: a page that
     * cannot be screenshotted is a page nobody looks at. Without it only the welcome screen is
     * reachable without a human clicking through, so a blank label or a broken layout on page three
     * would ship unseen. Fills the fields it skipped past with placeholders, since the later pages
     * assume the earlier ones ran.
     */
    private applyStartPageHook(): void {
        const page = globalThis.process?.env?.STEUER_APP_SETUP_PAGE;
        if (!page) return;
        if (!this.input.name) {
            this.input.name = 'Muster GbR';
            this.input.id = slugFromName(this.input.name);
            this.input.taxNumber = '12/345/67890';
        }
        if (page === 'entity') this.nav.push(this.pageEntity());
        else if (page === 'dms') this.nav.push(this.pageDms());
        else if (page === 'finish') this.nav.push(this.pageFinish());
    }

    /** True when the assistant actually wrote a configuration. */
    get didComplete(): boolean {
        return this.completed;
    }

    // ── Page shell ────────────────────────────────────────────────────────────────────────────

    private page(
        tag: string,
        title: string,
        body: Gtk.Widget,
        primary: { label: string; run: () => void },
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

    // ── 1 · Willkommen ────────────────────────────────────────────────────────────────────────

    private pageWelcome(): Adw.NavigationPage {
        const box = this.column();

        const status = new Adw.StatusPage({
            iconName: 'accessories-calculator-symbolic',
            title: 'Willkommen',
            description: markup(
                'Diese App rechnet Einnahmenüberschussrechnung, Umsatzsteuer und Einkommensteuer aus ' +
                    'deinen Bankbuchungen und Belegen. Für den Anfang reicht ein Name.',
            ),
        });
        box.append(status);

        // Say where the data goes BEFORE it goes there. A tax application that quietly picks a
        // directory is a tax application whose files the user cannot find later.
        //
        // The ACTUAL destination, not the XDG default: with STEUER_WORKSPACE or
        // TRANSACTIONS_DATA_DIR set, or a manifest already in the working directory, the write goes
        // somewhere else entirely — and a promise about the wrong path is worse than no promise.
        const where = new Adw.PreferencesGroup({ title: 'Wo die Daten liegen werden' });
        where.add(this.readOnlyRow('Konfiguration', getManifestPath()));
        where.add(this.readOnlyRow('Buchungen und Belege', getStoreDir()));
        box.append(where);

        return this.page('welcome', 'Willkommen', box, {
            label: 'Los geht’s',
            run: () => this.nav.push(this.pageEntity()),
        });
    }

    // ── 2 · Entität ───────────────────────────────────────────────────────────────────────────

    private pageEntity(): Adw.NavigationPage {
        const box = this.column();

        const group = new Adw.PreferencesGroup({
            title: 'Wen veranlagen wir?',
            description: 'Name und Art lassen sich später jederzeit ändern.',
        });

        const name = new Adw.EntryRow({ title: 'Name' });
        name.set_text(this.input.name);
        group.add(name);

        const kind = new Adw.ComboRow({
            title: 'Art',
            model: Gtk.StringList.new(KINDS.map((k) => k.label)),
        });
        kind.set_selected(KINDS.findIndex((k) => k.id === this.input.kind));
        kind.set_subtitle(KINDS[kind.get_selected()]?.hint ?? '');
        kind.connect('notify::selected', () => {
            const chosen = KINDS[kind.get_selected()];
            if (chosen) {
                this.input.kind = chosen.id;
                kind.set_subtitle(chosen.hint);
            }
        });
        group.add(kind);
        box.append(group);

        const tax = new Adw.PreferencesGroup({
            title: 'Steuerliche Angaben',
            description:
                'Optional — du kannst sie später in den Einstellungen nachtragen. Das Finanzamt ' +
                'steckt bereits in den ersten Stellen der Steuernummer und wird nicht getrennt erfasst.',
        });
        const steuernummer = new Adw.EntryRow({ title: 'Steuernummer' });
        steuernummer.set_text(this.input.taxNumber);
        tax.add(steuernummer);
        box.append(tax);

        const error = new Adw.Banner({ revealed: false });
        box.append(error);

        return this.page('entity', 'Entität', box, {
            label: 'Weiter',
            run: () => {
                this.input.name = (name.get_text() ?? '').trim();
                this.input.taxNumber = (steuernummer.get_text() ?? '').trim();
                if (!this.input.name) {
                    error.set_title(markup('Bitte einen Namen eingeben.'));
                    error.set_revealed(true);
                    return;
                }
                this.input.id = slugFromName(this.input.name);
                error.set_revealed(false);
                this.nav.push(this.pageDms());
            },
        });
    }

    // ── 3 · Belege ────────────────────────────────────────────────────────────────────────────

    private pageDms(): Adw.NavigationPage {
        const box = this.column();

        const group = new Adw.PreferencesGroup({
            title: 'Woher kommen die Belege?',
            description:
                'Das eingebaute Dokumentenmanagement braucht nichts weiter. Paperless-ngx nutzt du, ' +
                'wenn du deine Belege dort schon verwaltest.',
        });

        const choice = new Adw.ComboRow({
            title: 'Belegquelle',
            model: Gtk.StringList.new(['Eingebautes Dokumentenmanagement', 'Paperless-ngx']),
        });
        choice.set_selected(this.input.dms === 'paperless' ? 1 : 0);
        group.add(choice);
        box.append(group);

        const paperless = new Adw.PreferencesGroup({
            title: 'Paperless-ngx',
            description: 'URL und API-Token. Der Token landet in der Konfigurationsdatei, die nur du lesen kannst.',
        });
        const url = new Adw.EntryRow({ title: 'URL' });
        url.set_text(this.input.paperlessUrl);
        paperless.add(url);
        const token = new Adw.PasswordEntryRow({ title: 'API-Token' });
        token.set_text(this.input.paperlessToken);
        paperless.add(token);
        paperless.set_visible(choice.get_selected() === 1);
        choice.connect('notify::selected', () => paperless.set_visible(choice.get_selected() === 1));
        box.append(paperless);

        return this.page('dms', 'Belege', box, {
            label: 'Weiter',
            run: () => {
                this.input.dms = choice.get_selected() === 1 ? 'paperless' : 'builtin';
                this.input.paperlessUrl = (url.get_text() ?? '').trim();
                this.input.paperlessToken = (token.get_text() ?? '').trim();
                this.nav.push(this.pageFinish());
            },
        });
    }

    // ── 4 · Fertig ────────────────────────────────────────────────────────────────────────────

    private pageFinish(): Adw.NavigationPage {
        const box = this.column();
        const summary = new Adw.PreferencesGroup({ title: 'Zusammenfassung' });
        summary.add(this.readOnlyRow('Name', this.input.name));
        summary.add(this.readOnlyRow('Art', KINDS.find((k) => k.id === this.input.kind)?.label ?? this.input.kind));
        summary.add(this.readOnlyRow('Kurzname', this.input.id));
        if (this.input.taxNumber) summary.add(this.readOnlyRow('Steuernummer', this.input.taxNumber));
        summary.add(this.readOnlyRow('Belege', this.input.dms === 'paperless' ? 'Paperless-ngx' : 'Eingebautes DMS'));
        summary.add(this.readOnlyRow('Konfiguration', getManifestPath()));
        box.append(summary);

        const error = new Adw.Banner({ revealed: false });
        box.append(error);

        return this.page('finish', 'Fertig', box, {
            label: 'Einrichtung abschließen',
            run: () => {
                try {
                    this.write();
                    this.completed = true;
                    this.close();
                    this.onDone();
                } catch (err) {
                    // Everything up to the failure is already on disk, but the app is still usable
                    // and the Einstellungen can finish the job — so report and stay open rather
                    // than closing on a half-written state the user cannot see.
                    error.set_title(
                        markup(`Einrichtung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`),
                    );
                    error.set_revealed(true);
                }
            },
        });
    }

    // ── The one write ─────────────────────────────────────────────────────────────────────────

    /**
     * Create the configuration. Manifest first — everything else needs the entity to exist.
     *
     * `isFirstRun()` is re-checked here, not just at launch: the assistant may have been open while
     * a CLI or the MCP server created a manifest, and `initManifest` would then refuse. Adding to
     * the existing registry is the right answer in that case, not an error.
     */
    private write(): void {
        const entity = { id: this.input.id, name: this.input.name, kind: this.input.kind };
        if (isFirstRun()) initWorkspace(entity);
        else addEntity(entity);

        if (this.input.kind !== 'privat') {
            // A business entity needs somewhere to put its tax fields; the section does not exist
            // after initManifest, and every ELSTER writer requires it.
            ensureElsterSection(this.input.id);
            if (this.input.taxNumber) saveElsterTaxNumber(this.input.id, this.input.taxNumber);
        }

        saveEntityDms(this.input.id, {
            type: this.input.dms,
            paperlessUrl: this.input.paperlessUrl || undefined,
            paperlessToken: this.input.paperlessToken || undefined,
        });
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

    /** A value the user should see but not edit here (a path, a summary line). */
    private readOnlyRow(title: string, value: string): Adw.ActionRow {
        // Both halves are Pango markup — a Windows-style path or an `&` in a firm name would
        // otherwise render the row blank with no error anywhere.
        const row = new Adw.ActionRow({ title: markup(title), subtitle: markup(value) });
        row.add_css_class('property');
        return row;
    }
}
