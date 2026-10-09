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
 * All three write through the shared core actions (`connectQonto`, `connectFints`, `runImport`), so
 * an account added here is byte-for-byte the same as one added from the web UI or the CLI.
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
    connectQonto,
    detectFormat,
    type ImportFormat,
    runImport,
} from '../../../core/actions/accounts.ts';
import { markup } from './util.ts';

/** Report the outcome; the caller toasts it and refreshes the account list. */
export type AddAccountResult = (message: string, changed: boolean) => void;

/** The importable file formats, with the labels a user recognises them by. */
const FORMATS: Array<{ id: ImportFormat; label: string; hint: string }> = [
    { id: 'camt', label: 'CAMT.052/053 (XML)', hint: 'Der Standard-Kontoauszug fast jeder Bank' },
    { id: 'paypal', label: 'PayPal-Aktivitätsbericht (CSV)', hint: 'Nur zur Anreicherung — nicht in der EÜR' },
    { id: 'qonto-xls', label: 'Qonto-Export (XLS)', hint: 'Reichert vorhandene Buchungen an' },
    { id: 'amazon', label: 'Amazon-Bestellungen (CSV)', hint: 'Reichert vorhandene Buchungen an' },
];

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

    constructor(done: AddAccountResult) {
        super();
        this.done = done;
        this.nav.push(this.pageChoose());
    }

    /**
     * Jump straight to one page — the dev hook behind `STEUER_APP_ADD_ACCOUNT`. A page nobody can
     * screenshot is a page nobody checks, and three of these four are forms where a blank label or
     * a broken layout would ship unseen.
     */
    openPage(page: string): void {
        if (page === 'file') this.nav.push(this.pageFile());
        else if (page === 'qonto') this.nav.push(this.pageQonto());
        else if (page === 'fints') this.nav.push(this.pageFints());
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

    /** Finish: report and close. Failures keep the dialog open so the input can be corrected. */
    private finish(message: string): void {
        this.done(message, true);
        this.close();
    }

    // ── 1 · Which way in ──────────────────────────────────────────────────────────────────────

    private pageChoose(): Adw.NavigationPage {
        const box = this.column();
        const group = new Adw.PreferencesGroup({
            title: 'Woher kommen die Buchungen?',
            description:
                'Eine Datei reicht für den Anfang — der Kontoauszug, den deine Bank im Online-Banking ' +
                'zum Download anbietet. Eine laufende Verbindung holt sie später von selbst.',
        });
        group.add(
            this.navRow('Datei importieren', 'CAMT, PayPal, Qonto-Export oder Amazon', 'document-open-symbolic', () =>
                this.nav.push(this.pageFile()),
            ),
        );
        group.add(
            this.navRow('Qonto verbinden', 'Login und Secret Key aus dem Qonto-Konto', 'network-server-symbolic', () =>
                this.nav.push(this.pageQonto()),
            ),
        );
        group.add(
            this.navRow(
                'Bank über FinTS/HBCI',
                'Fast jede deutsche Bank; PIN bleibt lokal',
                'network-wired-symbolic',
                () => this.nav.push(this.pageFints()),
            ),
        );
        box.append(group);
        return this.page('Konto hinzufügen', box);
    }

    // ── 2a · File import ──────────────────────────────────────────────────────────────────────

    private pageFile(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });

        const group = new Adw.PreferencesGroup({
            title: 'Datei importieren',
            description: 'Format wird am Dateinamen erkannt; bei CSV lässt es sich hier festlegen.',
        });

        const format = new Adw.ComboRow({
            title: 'Format',
            model: Gtk.StringList.new(['Automatisch erkennen', ...FORMATS.map((f) => f.label)]),
        });
        const describe = () => {
            const i = format.get_selected();
            format.set_subtitle(i === 0 ? 'Aus der Dateiendung' : (FORMATS[i - 1]?.hint ?? ''));
        };
        describe();
        format.connect('notify::selected', describe);
        group.add(format);

        const full = new Adw.SwitchRow({
            title: 'Alles importieren',
            subtitle:
                'Standard ist, nur Buchungen zu übernehmen, die älter sind als die vorhandenen — das ' +
                'vermeidet Dubletten im Überlappungsbereich.',
        });
        group.add(full);
        box.append(group);
        box.append(banner);

        const hint = new Gtk.Label({
            label:
                'Ein Fehlimport lässt sich rückgängig machen: jeder Import wird als Stapel geführt ' +
                'und kann als Ganzes zurückgenommen werden.',
            wrap: true,
            xalign: 0,
            cssClasses: ['dim-label', 'caption'],
        });
        box.append(hint);

        return this.page('Datei', box, {
            label: 'Datei wählen …',
            run: () => {
                const chosen = format.get_selected();
                const forced = chosen > 0 ? FORMATS[chosen - 1]?.id : undefined;
                void this.runFileImport(forced, full.get_active(), banner);
            },
        });
    }

    /** Pick a file, resolve the format, hand the bytes to the shared import action. */
    private async runFileImport(forced: ImportFormat | undefined, full: boolean, banner: Adw.Banner): Promise<void> {
        // pickFile wants the toplevel WINDOW; an Adw.Dialog is not one, and passing `this` only
        // fails at type-check — at runtime it would present a file chooser with no parent.
        const root = this.get_root() as Gtk.Window | null;
        if (!root) return;
        const path = await pickFile(root, {
            title: 'Kontoauszug oder Export wählen',
            filters: [
                { name: 'Alle unterstützten', patterns: ['*.xml', '*.csv', '*.xls', '*.xlsx'] },
                { name: 'CAMT (*.xml)', patterns: ['*.xml'] },
                { name: 'CSV (*.csv)', patterns: ['*.csv'] },
                { name: 'Qonto-Export (*.xls, *.xlsx)', patterns: ['*.xls', '*.xlsx'] },
            ],
        });
        if (!path) return; // cancelled

        const filename = basename(path);
        const format = forced ?? detectFormat(filename);
        if (!format) {
            // A .csv is genuinely ambiguous (PayPal or Amazon), so say which choice is missing
            // rather than guessing and importing the wrong shape.
            banner.set_title(markup(`Format von „${filename}" nicht erkennbar — bitte oben eins auswählen.`));
            banner.set_revealed(true);
            return;
        }

        try {
            const bytes = readFileSync(path);
            const result = await runImport(format, filename, bytes, { full });
            const added = (result.reports ?? []).reduce((n, r) => n + (r.added ?? 0), 0);
            const enriched = result.enrich?.updated ?? 0;
            this.finish(
                result.reports
                    ? `${filename}: ${added} neue Buchungen importiert.`
                    : `${filename}: ${enriched} Buchungen angereichert.`,
            );
        } catch (err) {
            banner.set_title(markup(`Import fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`));
            banner.set_revealed(true);
        }
    }

    // ── 2b · Qonto ────────────────────────────────────────────────────────────────────────────

    private pageQonto(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });

        const group = new Adw.PreferencesGroup({
            title: 'Qonto verbinden',
            description: 'Login und Secret Key stehen im Qonto-Konto unter Einstellungen → API.',
        });
        const login = new Adw.EntryRow({ title: 'Login' });
        group.add(login);
        const secret = new Adw.PasswordEntryRow({ title: 'Secret Key' });
        group.add(secret);
        const env = new Adw.ComboRow({ title: 'Umgebung', model: Gtk.StringList.new(['Produktiv', 'Staging']) });
        group.add(env);
        box.append(group);
        box.append(banner);

        box.append(
            new Gtk.Label({
                label: 'Die Zugangsdaten landen in der lokalen .env-Datei — sie verlassen diesen Rechner nicht.',
                wrap: true,
                xalign: 0,
                cssClasses: ['dim-label', 'caption'],
            }),
        );

        return this.page('Qonto', box, {
            label: 'Verbinden',
            run: () => {
                const l = (login.get_text() ?? '').trim();
                const s = (secret.get_text() ?? '').trim();
                if (!l || !s) {
                    banner.set_title(markup('Login und Secret Key sind erforderlich.'));
                    banner.set_revealed(true);
                    return;
                }
                try {
                    const { env: chosen } = connectQonto({
                        login: l,
                        secretKey: s,
                        env: env.get_selected() === 1 ? 'staging' : 'production',
                    });
                    this.finish(`Qonto verbunden (${chosen}). Jetzt synchronisieren, um Buchungen zu holen.`);
                } catch (err) {
                    banner.set_title(
                        markup(`Verbinden fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`),
                    );
                    banner.set_revealed(true);
                }
            },
        });
    }

    // ── 2c · FinTS ────────────────────────────────────────────────────────────────────────────

    private pageFints(): Adw.NavigationPage {
        const box = this.column();
        const banner = new Adw.Banner({ revealed: false });

        const group = new Adw.PreferencesGroup({
            title: 'Bank über FinTS/HBCI',
            description:
                'BLZ und FinTS-URL nennt deine Bank; die Produkt-ID ist die Registrierungsnummer, die ' +
                'sie für den Zugriff vergibt.',
        });
        const name = new Adw.EntryRow({ title: 'Name (frei wählbar)' });
        group.add(name);
        const url = new Adw.EntryRow({ title: 'FinTS-URL' });
        group.add(url);
        const blz = new Adw.EntryRow({ title: 'BLZ' });
        group.add(blz);
        const user = new Adw.EntryRow({ title: 'Benutzerkennung' });
        group.add(user);
        const product = new Adw.EntryRow({ title: 'Produkt-ID' });
        group.add(product);
        const pin = new Adw.PasswordEntryRow({ title: 'PIN' });
        group.add(pin);
        box.append(group);
        box.append(banner);

        box.append(
            new Gtk.Label({
                label: 'Die PIN landet in der lokalen .env-Datei — sie verlässt diesen Rechner nicht.',
                wrap: true,
                xalign: 0,
                cssClasses: ['dim-label', 'caption'],
            }),
        );

        return this.page('FinTS', box, {
            label: 'Verbinden',
            run: () => {
                const values = {
                    name: (name.get_text() ?? '').trim(),
                    url: (url.get_text() ?? '').trim(),
                    blz: (blz.get_text() ?? '').trim(),
                    user_id: (user.get_text() ?? '').trim(),
                    product_id: (product.get_text() ?? '').trim(),
                    pin: (pin.get_text() ?? '').trim(),
                };
                const missing = Object.entries(values)
                    .filter(([, v]) => !v)
                    .map(([k]) => k);
                if (missing.length > 0) {
                    // Name the empty fields. "Alle Felder sind erforderlich" over six inputs makes
                    // the user re-check every one of them.
                    banner.set_title(markup(`Noch leer: ${missing.join(', ')}`));
                    banner.set_revealed(true);
                    return;
                }
                try {
                    connectFints(values);
                    this.finish(`Bank „${values.name}" verbunden. Jetzt synchronisieren, um Buchungen zu holen.`);
                } catch (err) {
                    banner.set_title(
                        markup(`Verbinden fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`),
                    );
                    banner.set_revealed(true);
                }
            },
        });
    }
}
