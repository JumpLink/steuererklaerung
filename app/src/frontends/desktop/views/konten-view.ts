/**
 * <BhKontenView> — the Konten view.
 *
 * "Aktive Verbindungen": every connected account across all entities (Qonto · FinTS · CAMT file ·
 * PayPal) rendered as a v2 design card — a coloured initials tile + name + entity/ref sub + a
 * live/Datei badge + last-sync caption + the Saldo, with a per-card Synchronisieren (live only) and
 * a destructive Trennen. The list is pure store (see presenters/konten.ts); sync + disconnect delegate
 * to the same core actions the web uses. Below it the ERiC/ELSTER system-library card (unchanged).
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import Pango from '@girs/pango-1.0';

import Template from './konten-view.blp';
import {
    type AccountSyncReport,
    type ConnectionInfo,
    type RemoveMode,
    accountSyncScope,
    loadConnections,
} from '../../../core/presenters/konten.ts';
import { removeConnection } from '../../../core/actions/accounts.ts';
import { checkApiConnections } from '../../../core/actions/check-apis.ts';
import { syncTransactions } from '../../../core/actions/transactions.ts';
import { appSession } from '../data/session.ts';
import { clearYearCache } from '../data/assistent.ts';
import { errorDialog } from './dialogs.ts';
import { BhAddAccountDialog } from './konto-hinzufuegen-dialog.ts';
import {
    clearElsterPin,
    keyringAvailable,
    loadEricStatus,
    loadKeystorePath,
    loadSubmitter,
    lookupElsterPin,
    saveEricHome,
    saveKeystore,
    saveSubmitter,
    storeElsterPin,
    type EricStatusView,
} from '../data/eric.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { applyScrollHook, GroupRows, LoadToken, amountLabel, loadIntoStack, markup } from './util.ts';
import { showToast } from '../toast.ts';

const SOURCE_LABEL: Record<string, string> = {
    qonto: 'Qonto',
    fints: 'FinTS',
    camt: 'CAMT-Datei',
    paypal: 'PayPal',
};

export class BhKontenView extends Adw.Bin {
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _connections_box: Gtk.Box;
    declare private _eric_group: Adw.PreferencesGroup;
    declare private _eric_banner: Adw.Banner;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhKontenView',
                Template,
                InternalChildren: ['scroller', 'stack', 'error_page', 'connections_box', 'eric_group', 'eric_banner'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly eric: GroupRows;
    /** The active entity — the ERiC card persists `eric_home` to its ELSTER config. */
    private entity: AppEntity | null = null;
    /** True while programmatically filling the ERiC entry row — suppresses its apply-driven save. */
    private ericFilling = false;
    /** True while programmatically filling the certificate-path row — suppresses its apply-driven save. */
    private certFilling = false;
    private submitterFilling = false;

    constructor() {
        super();
        this.eric = new GroupRows(this._eric_group);
    }

    // The account list is global (every entity); the entity is used only by the ERiC card below.
    reload(entity: AppEntity, _year: number): void {
        this.entity = entity;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Konten konnten nicht geladen werden',
            load: () => loadConnections(),
            fill: (accounts) => this.fill(accounts),
        });
    }

    private fill(accounts: ConnectionInfo[]): void {
        this.fillConnections(accounts);
        this.refreshEricStatus(); // independent async probe — must not block the account list
        if (process.env.STEUER_APP_DEBUG) console.error(`[app] Konten ok: ${accounts.length} Konten`);
    }

    // ── Systembibliotheken (ELSTER/ERiC) — status + path import ───────────────────────────────────

    /**
     * Re-probe ERiC for the active entity and rebuild the card. Runs independently of the account
     * load (the version read touches the native binding, which may be slower than the fs probe). Any
     * failure surfaces in the banner; it never crashes the view.
     */
    private refreshEricStatus(): void {
        this._eric_group.set_description(
            'Wird für die Prüfung und die spätere Übermittlung an ELSTER benötigt. ERiC ist selbst zu ' +
                'installieren (ELSTER-Entwicklerbereich) und nicht Teil der App. Leer = ERIC_HOME / Standardpfad.',
        );
        loadEricStatus(this.entity)
            .then((status) => {
                this._eric_banner.set_revealed(false);
                this.fillEric(status);
            })
            .catch((err: unknown) => this.ericBanner(`ERiC-Status nicht verfügbar: ${msg(err)}`));
    }

    private fillEric(status: EricStatusView): void {
        this.eric.clear();

        // Status row: version + resolved path when available; else a clear "nicht gefunden" + why.
        const statusRow = new Adw.ActionRow({ title: 'ERiC (ELSTER Rich Client)' });
        if (status.available) {
            statusRow.set_subtitle(markup(`Version ${status.version ?? 'unbekannt'} · ${status.ericHome}`));
            statusRow.add_suffix(ericPill(true, 'verfügbar'));
        } else {
            const detail = status.error
                ? `Bibliothek nicht ladbar: ${status.error}`
                : `nicht gefunden — erwartet unter ${status.libPath}` +
                  (status.missing.length ? ` · fehlend: ${status.missing.join(', ')}` : '') +
                  ` · ${status.pluginCount} Plugin(s)`;
            statusRow.set_subtitle(markup(detail));
            statusRow.add_suffix(ericPill(false, status.error ? 'Fehler' : 'nicht gefunden'));
        }
        this.eric.add(statusRow);

        // Editable ERIC_HOME path (persisted per active entity's ELSTER config).
        const entry = new Adw.EntryRow({ title: 'ERiC-Pfad (ERIC_HOME)' });
        entry.set_show_apply_button(true);
        this.ericFilling = true;
        entry.set_text(status.configuredHome ?? '');
        this.ericFilling = false;
        entry.connect('apply', () => {
            if (!this.ericFilling) this.applyEricPath(entry.get_text() ?? '');
        });
        // A folder picker, as the certificate row has had all along. Typing an absolute path from
        // memory is the kind of task that produces a typo and then a "nicht gefunden" nobody can
        // explain — and this row is the one place where the whole ELSTER chain is unblocked.
        const pick = new Gtk.Button({
            iconName: 'folder-open-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltipText: 'ERiC-Verzeichnis wählen (enthält lib/libericapi.so)',
        });
        pick.connect('clicked', () => {
            const chooser = new Gtk.FileDialog({ title: 'ERiC-Verzeichnis wählen' });
            chooser.select_folder(this.get_root() as Gtk.Window | null, null, (_s, res) => {
                try {
                    const dir = chooser.select_folder_finish(res);
                    const path = dir?.get_path();
                    if (!path) return;
                    this.ericFilling = true;
                    entry.set_text(path);
                    this.ericFilling = false;
                    this.applyEricPath(path); // set_text does not fire 'apply' — persist explicitly
                } catch {
                    // Cancelled. Nothing to report: the user closed a chooser they opened.
                }
            });
        });
        entry.add_suffix(pick);
        this.eric.add(entry);

        // Only when it is missing: where to get it, and why it is not simply included. Without this
        // the card states a fact ("nicht gefunden") and leaves the user to guess that ERiC is a
        // separate download at all — the licence forbids shipping it, which is not something anyone
        // could infer from an empty path field.
        if (!status.available) {
            const help = new Adw.ActionRow({
                title: 'ERiC selbst herunterladen',
                subtitle: markup(
                    'Die Lizenz verbietet die Weitergabe, deshalb liegt ERiC nicht bei. Nach dem Entpacken ' +
                        'hier den Ordner wählen, der lib/libericapi.so enthält. Ohne ERiC funktioniert alles ' +
                        'außer dem direkten Absenden — XML erzeugen und in Mein ELSTER hochladen geht.',
                ),
            });
            help.set_subtitle_lines(0);
            const open = new Gtk.LinkButton({
                uri: 'https://www.elster.de/elsterweb/entwickler/infoseite/eric',
                label: 'elster.de öffnen',
                valign: Gtk.Align.CENTER,
            });
            help.add_suffix(open);
            this.eric.add(help);
        }

        applyScrollHook(this._scroller);

        // ELSTER certificate (.pfx/.p12) — the "Zertifikatsdatei" used for the live submission. The path
        // is NOT secret and is persisted per active entity's ELSTER config (mirrors the ERIC_HOME row).
        const cert = new Adw.EntryRow({ title: 'ELSTER-Zertifikat (.pfx)' });
        cert.set_show_apply_button(true);
        const browse = new Gtk.Button({
            iconName: 'document-open-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltipText: 'Zertifikatsdatei wählen',
        });
        browse.connect('clicked', () => {
            const chooser = new Gtk.FileDialog({ title: 'ELSTER-Zertifikat wählen' });
            chooser.open(this.get_root() as Gtk.Window | null, null, (_s, res) => {
                try {
                    const file = chooser.open_finish(res);
                    const path = file?.get_path();
                    if (path) {
                        this.certFilling = true;
                        cert.set_text(path);
                        this.certFilling = false;
                        this.applyCertPath(path); // set_text doesn't fire 'apply' — persist explicitly
                    }
                } catch {
                    /* user cancelled the file chooser */
                }
            });
        });
        cert.add_suffix(browse);
        this.certFilling = true;
        cert.set_text(loadKeystorePath(this.entity) ?? '');
        this.certFilling = false;
        cert.connect('apply', () => {
            if (!this.certFilling) this.applyCertPath(cert.get_text() ?? '');
        });
        this.eric.add(cert);

        // ELSTER submitter identity — the 5-digit Hersteller-ID (requested free in the elster.de
        // developer area) + DatenLieferant. Required to TRANSMIT (even test cases); without it the
        // server rejects the send. NOT secret; persisted per entity's ELSTER config.
        const submitter = loadSubmitter(this.entity);
        const hersteller = new Adw.EntryRow({ title: 'ELSTER Hersteller-ID (elster.de)' });
        hersteller.set_show_apply_button(true);
        this.submitterFilling = true;
        hersteller.set_text(submitter.herstellerId ?? '');
        this.submitterFilling = false;
        hersteller.connect('apply', () => {
            if (!this.submitterFilling)
                this.applySubmitter({ herstellerId: hersteller.get_text() ?? '' }, 'Hersteller-ID');
        });
        this.eric.add(hersteller);

        const lieferant = new Adw.EntryRow({ title: 'DatenLieferant (Name)' });
        lieferant.set_show_apply_button(true);
        this.submitterFilling = true;
        lieferant.set_text(submitter.datenlieferant ?? '');
        this.submitterFilling = false;
        lieferant.connect('apply', () => {
            if (!this.submitterFilling)
                this.applySubmitter({ datenlieferant: lieferant.get_text() ?? '' }, 'DatenLieferant');
        });
        this.eric.add(lieferant);

        // Certificate PIN — kept only in the OS keyring (never in config). Gated on keyring availability.
        this.eric.add(this.buildPinRow());

        // Re-run the status check (e.g. after installing ERiC without changing the path).
        const check = new Adw.ButtonRow({ title: 'Prüfen' });
        check.connect('activated', () => this.refreshEricStatus());
        this.eric.add(check);
    }

    /** Persist the entered certificate path for the active entity, then toast (errors → banner). */
    private applyCertPath(path: string): void {
        try {
            saveKeystore(this.entity, path);
        } catch (err) {
            this.ericBanner(`Zertifikat-Pfad konnte nicht gespeichert werden: ${msg(err)}`);
            return;
        }
        showToast(path.trim() ? 'Zertifikat-Pfad gespeichert' : 'Zertifikat-Pfad entfernt');
    }

    /** Persist one submitter-identity field (Hersteller-ID / DatenLieferant) for the active entity. */
    private applySubmitter(ids: { herstellerId?: string; datenlieferant?: string }, label: string): void {
        try {
            saveSubmitter(this.entity, ids);
        } catch (err) {
            this.ericBanner(`${label} konnte nicht gespeichert werden: ${msg(err)}`);
            return;
        }
        showToast(`${label} gespeichert`);
    }

    /**
     * The certificate-PIN row: read-first honest state (hinterlegt / keine PIN) with Hinterlegen/Ändern
     * + Entfernen actions. When no keyring is reachable it degrades to a hint (the PIN is then prompted
     * at send time). The PIN itself is never displayed — only whether one is stored.
     */
    private buildPinRow(): Adw.ActionRow {
        if (!keyringAvailable()) {
            const row = new Adw.ActionRow({
                title: 'Zertifikat-PIN',
                subtitle: 'Schlüsselbund nicht verfügbar — die PIN wird beim Senden abgefragt.',
                cssClasses: ['dim-label'],
            });
            row.add_prefix(
                new Gtk.Image({
                    iconName: 'dialog-information-symbolic',
                    cssClasses: ['dim-label'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            return row;
        }

        const entityId = this.entity?.id;
        const stored = entityId ? lookupElsterPin(entityId) != null : false;
        const row = new Adw.ActionRow({
            title: 'Zertifikat-PIN',
            subtitle: stored ? 'im Schlüsselbund hinterlegt' : 'keine PIN hinterlegt',
        });
        row.add_prefix(
            new Gtk.Image({
                iconName: stored ? 'emblem-ok-symbolic' : 'dialog-password-symbolic',
                cssClasses: [stored ? 'success' : 'dim-label'],
                valign: Gtk.Align.CENTER,
            }),
        );
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER });
        const set = new Gtk.Button({
            label: stored ? 'Ändern' : 'Hinterlegen',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: !!entityId,
        });
        set.connect('clicked', () => void this.onSetPin());
        box.append(set);
        const clear = new Gtk.Button({
            label: 'Entfernen',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: stored,
        });
        clear.connect('clicked', () => this.onClearPin());
        box.append(clear);
        row.add_suffix(box);
        return row;
    }

    /** Prompt for a PIN and store it (encrypted) in the keyring for the active entity, then refresh. */
    private async onSetPin(): Promise<void> {
        const entityId = this.entity?.id;
        if (!entityId) return;
        const pin = await promptPin(this);
        if (!pin) return; // cancelled / empty
        if (storeElsterPin(entityId, pin)) showToast('Zertifikat-PIN im Schlüsselbund hinterlegt');
        else this.ericBanner('Zertifikat-PIN konnte nicht gespeichert werden.');
        this.refreshEricStatus();
    }

    /** Remove the stored PIN for the active entity from the keyring, then refresh. */
    private onClearPin(): void {
        const entityId = this.entity?.id;
        if (!entityId) return;
        clearElsterPin(entityId);
        showToast('Zertifikat-PIN entfernt');
        this.refreshEricStatus();
    }

    /** Persist the entered ERiC path for the active entity, then re-probe + toast (errors → banner). */
    private applyEricPath(path: string): void {
        try {
            saveEricHome(this.entity, path);
        } catch (err) {
            this.ericBanner(`ERiC-Pfad konnte nicht gespeichert werden: ${msg(err)}`);
            return;
        }
        showToast('ERiC-Pfad gespeichert');
        this.refreshEricStatus();
    }

    private ericBanner(message: string): void {
        this._eric_banner.set_title(markup(message)); // Banner title is Pango markup — escape it
        this._eric_banner.set_revealed(true);
    }

    // ── Aktive Verbindungen — the connection card grid ────────────────────────────────────────────

    /** Rebuild the "Aktive Verbindungen" section (heading + card grid) from the current store. */
    private fillConnections(accounts: ConnectionInfo[]): void {
        clearBox(this._connections_box);

        const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        head.append(new Gtk.Label({ label: 'Aktive Verbindungen', xalign: 0, hexpand: true, cssClasses: ['title-4'] }));
        const live = accounts.filter((a) => a.live).length;
        head.append(
            new Gtk.Label({
                label: `${accounts.length} Konten · ${live} live`,
                cssClasses: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            }),
        );
        // "Are the back-ends reachable?" — the question a user asks after typing a URL and seeing
        // nothing appear. The probe existed only as a CLI command that printed to the console.
        const probe = new Gtk.Button({
            iconName: 'network-transmit-receive-symbolic',
            tooltipText: 'Anbindungen prüfen',
            valign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
        });
        probe.connect('clicked', () => void this.onCheckConnections(probe));
        head.append(probe);

        // The way IN. Without it the view could sync and disconnect what was already there and
        // nothing else — connecting a bank meant editing .env, importing meant a CLI command.
        const add = new Gtk.Button({ label: 'Konto hinzufügen', valign: Gtk.Align.CENTER });
        add.add_css_class('suggested-action');
        add.add_css_class('pill');
        add.connect('clicked', () => this.presentAddAccount());
        head.append(add);
        this._connections_box.append(head);

        if (accounts.length === 0) {
            // An empty state that only describes the emptiness leaves the user where they were.
            // This one carries the action, since it is the very first thing a fresh install shows.
            const empty = new Adw.StatusPage({
                iconName: 'network-server-symbolic',
                title: 'Noch keine Konten',
                description: markup(
                    'Importiere einen Kontoauszug (CAMT, PayPal) oder verbinde Qonto bzw. deine Bank ' +
                        'über FinTS — danach rechnet die App aus deinen Buchungen.',
                ),
            });
            const start = new Gtk.Button({ label: 'Konto hinzufügen', halign: Gtk.Align.CENTER });
            start.add_css_class('suggested-action');
            start.add_css_class('pill');
            start.connect('clicked', () => this.presentAddAccount());
            empty.set_child(start);
            this._connections_box.append(empty);
        } else {
            const grid = new Gtk.FlowBox({
                selectionMode: Gtk.SelectionMode.NONE,
                homogeneous: true,
                minChildrenPerLine: 1,
                maxChildrenPerLine: 3,
                columnSpacing: 12,
                rowSpacing: 12,
                activateOnSingleClick: false,
            });
            for (const a of accounts) grid.append(this.connectionCard(a));
            this._connections_box.append(grid);
        }
        this.applyAddAccountHook();

        // TODO: Verfügbare Anbindungen catalog (deferred) — the provider catalog (FinTS/GoCardless/
        // Stripe/CSV/ELSTER/E-Mail) with connect-credential flows goes here (separate batch).
    }

    /** Re-read the store and refill just the cards (no stack reset, no ERiC re-probe). Post-write refresh. */
    private reloadConnections(): void {
        try {
            this.fillConnections(loadConnections());
        } catch (err) {
            showToast(`Konten konnten nicht neu geladen werden: ${msg(err)}`);
        }
    }

    /** One connection as a v2 design `.card`: avatar + name/sub + badge · sync-caption + Saldo · actions. */
    private connectionCard(a: ConnectionInfo): Gtk.Widget {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            marginTop: 14,
            marginBottom: 14,
            marginStart: 16,
            marginEnd: 16,
        });

        // Header: coloured initials tile · name + entity/ref sub · live/Datei badge.
        const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
        const label = SOURCE_LABEL[a.source] ?? a.source;
        header.append(new Adw.Avatar({ size: 40, text: label, showInitials: true, valign: Gtk.Align.START }));
        const titleBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
        titleBox.append(
            new Gtk.Label({ label, xalign: 0, cssClasses: ['heading'], ellipsize: Pango.EllipsizeMode.END }),
        );
        const sub = [a.entityName, a.ref].filter(Boolean).join(' · ');
        if (sub)
            titleBox.append(
                new Gtk.Label({
                    label: sub,
                    xalign: 0,
                    cssClasses: ['dim-label', 'caption'],
                    ellipsize: Pango.EllipsizeMode.END,
                }),
            );
        header.append(titleBox);
        header.append(
            new Gtk.Label({
                label: a.live ? 'live' : 'Datei',
                cssClasses: ['caption', 'heading', a.live ? 'success' : 'dim-label'],
                valign: Gtk.Align.START,
            }),
        );
        content.append(header);

        // Meta: last-sync caption (live) or the imported date range (file) · Saldo.
        const range = a.firstDate && a.lastDate ? `${deDate(a.firstDate)} – ${deDate(a.lastDate)}` : null;
        const metaText = a.live
            ? `Synchronisiert ${syncedLabel(a.lastSyncedAt)}`
            : range
              ? `Importiert ${range}`
              : `${a.count} Buchungen`;
        const meta = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        meta.append(
            new Gtk.Label({
                label: metaText,
                xalign: 0,
                hexpand: true,
                cssClasses: ['dim-label', 'caption'],
                ellipsize: Pango.EllipsizeMode.END,
            }),
        );
        meta.append(amountLabel(eur(a.net), { heading: true }));
        content.append(meta);

        // Actions: Synchronisieren (live only) + destructive Trennen (trash).
        const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        if (a.live) {
            const sync = new Gtk.Button({ label: 'Synchronisieren', hexpand: true, valign: Gtk.Align.CENTER });
            sync.connect('clicked', () => void this.onSync(a, sync));
            actions.append(sync);
        } else {
            // File source: no live sync — keep the trash right-aligned with a spacer.
            actions.append(new Gtk.Label({ hexpand: true }));
        }
        const trash = new Gtk.Button({
            iconName: 'user-trash-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltipText: 'Verbindung trennen',
        });
        trash.connect('clicked', () => void this.onDisconnect(a));
        actions.append(trash);
        content.append(actions);

        const card = new Gtk.Box({ cssClasses: ['card'] });
        card.append(content);
        return card;
    }

    /**
     * `STEUER_APP_ADD_ACCOUNT=choose|file|qonto|fints|assign` (dev/testing hook): open the dialog on that
     * page. Unlike a popover, an Adw.Dialog renders INSIDE the window and therefore shows up in the
     * devtools capture — so these pages can actually be looked at rather than assumed.
     */
    private applyAddAccountHook(): void {
        const page = process.env.STEUER_APP_ADD_ACCOUNT;
        if (!page) return;
        const dialog = new BhAddAccountDialog(() => {});
        dialog.openPage(page);
        dialog.present(this);
    }

    /**
     * Probe every back-end and show the result per service.
     *
     * A dialog, not a toast: the answer is a LIST, and the interesting case is one red line among
     * four green ones — a message that disappears after four seconds cannot carry that, and the
     * user came here precisely because something is not working.
     */
    private async onCheckConnections(btn: Gtk.Button): Promise<void> {
        btn.set_sensitive(false);
        try {
            const report = await checkApiConnections();
            const lines = report.services
                .map((s) => `${s.ok ? '✓' : '✗'}  ${s.name}${s.message ? ` — ${s.message}` : ''}`)
                .join('\n');
            const dialog = new Adw.AlertDialog({
                heading: report.ok ? 'Alle Anbindungen erreichbar' : 'Nicht alle Anbindungen erreichbar',
                body: markup(lines),
            });
            dialog.add_response('close', 'Schließen');
            dialog.present(this);
        } catch (err) {
            showToast(`Prüfung fehlgeschlagen: ${msg(err)}`);
        } finally {
            btn.set_sensitive(true);
        }
    }

    /** Open the three-ways-in dialog; on success reload so the new account shows up. */
    private presentAddAccount(): void {
        const dialog = new BhAddAccountDialog((message, changed) => {
            showToast(message);
            if (!changed) return;
            // A new account changes what every tax figure is computed from, so the shared
            // aggregate has to go — not just this view's list.
            appSession().invalidate();
            clearYearCache();
            this.reloadConnections();
        });
        dialog.present(this);
    }

    /** Sync one live connection: disable + relabel the button, toast the result, then refill. */
    private async onSync(a: ConnectionInfo, btn: Gtk.Button): Promise<void> {
        btn.set_sensitive(false);
        btn.set_label('Synchronisiere …');
        try {
            const { reports } = await syncTransactions({ account: accountSyncScope(a) });
            appSession().invalidate(); // new transactions → the tax/EÜR aggregate + assistant caches are stale
            clearYearCache();
            showToast(syncSummary(a, reports), 5);
            this.reloadConnections(); // rebuilds the cards (fresh, enabled button) → no manual restore
        } catch (err) {
            btn.set_sensitive(true);
            btn.set_label('Synchronisieren');
            showToast(`Sync fehlgeschlagen: ${msg(err)}`, 5);
        }
    }

    /** Confirm (adaptive to live vs file), disconnect via the core action, toast + refill. */
    private async onDisconnect(a: ConnectionInfo): Promise<void> {
        const mode = await this.askDisconnect(a);
        if (!mode) return;
        try {
            const { transactions } = await removeConnection(a.accountKey, mode);
            if (mode === 'delete-all') {
                appSession().invalidate();
                clearYearCache();
            }
            showToast(
                mode === 'delete-all'
                    ? `Getrennt · ${transactions} Buchungen gelöscht`
                    : 'Sync gestoppt — Daten behalten',
            );
            this.reloadConnections();
        } catch (err) {
            await errorDialog(this, 'Trennen fehlgeschlagen', msg(err));
        }
    }

    /**
     * Confirmation for Trennen. `removeConnection` has two modes, so this is a small choice dialog
     * (not the binary confirmDialog): a live account can "Nur Sync stoppen" (keep the imported data)
     * or "Alles löschen"; a file account only offers the destructive delete. Resolves the chosen
     * {@link RemoveMode}, or null on cancel.
     */
    private askDisconnect(a: ConnectionInfo): Promise<RemoveMode | null> {
        return new Promise((resolve) => {
            const dlg = new Adw.AlertDialog({
                heading: 'Verbindung trennen',
                body: `${SOURCE_LABEL[a.source] ?? a.source} · ${a.ref} — ${a.count} Buchungen. Was soll passieren?`,
            });
            dlg.add_response('cancel', 'Abbrechen');
            if (a.live) dlg.add_response('stop-sync', 'Nur Sync stoppen');
            dlg.add_response('delete-all', 'Alles löschen');
            dlg.set_response_appearance('delete-all', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.set_close_response('cancel');
            dlg.set_default_response('cancel');
            dlg.choose(this, null, (_s, res) => {
                const r = dlg.choose_finish(res);
                resolve(r === 'cancel' ? null : (r as RemoveMode));
            });
        });
    }
}

/** Remove every child of a plain Gtk.Box (PreferencesGroup has GroupRows; a Box needs this). */
function clearBox(box: Gtk.Box): void {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

/** Relative "vor …" label for the last sync (design: "vor 12 Minuten"); "noch nie" when never synced. */
function syncedLabel(iso?: string): string {
    if (!iso) return 'noch nie';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return deDate(iso);
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return 'gerade eben';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `vor ${mins} Minute${mins === 1 ? '' : 'n'}`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `vor ${hours} Stunde${hours === 1 ? '' : 'n'}`;
    const days = Math.round(hours / 24);
    if (days <= 7) return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
    return `am ${deDate(iso)}`;
}

/** One-line toast summary of a per-account sync (reports are already scoped to the synced account). */
function syncSummary(a: ConnectionInfo, reports: AccountSyncReport[]): string {
    const label = SOURCE_LABEL[a.source] ?? a.source;
    if (reports.length === 0) return `${label}: nichts zu synchronisieren`;
    const failed = reports.filter((r) => r.error);
    if (failed.length) return `${label}: Fehler — ${failed.map((r) => r.error).join(' · ')}`;
    const added = reports.reduce((n, r) => n + r.added, 0);
    const updated = reports.reduce((n, r) => n + r.updated, 0);
    return `${label}: +${added} neu · ${updated} aktualisiert`;
}

/** A small status pill (icon + accented caption) for the ERiC availability row. */
function ericPill(ok: boolean, label: string): Gtk.Box {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER });
    box.append(
        new Gtk.Image({
            iconName: ok ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            cssClasses: [ok ? 'success' : 'error'],
        }),
    );
    box.append(new Gtk.Label({ label, cssClasses: ['caption', 'heading', ok ? 'success' : 'error'] }));
    return box;
}

/**
 * Small modal to capture the certificate PIN for keyring storage. Resolves with the entered PIN when
 * the user confirms (non-empty), or null on cancel. The PIN is never echoed back to config — the caller
 * hands it straight to {@link storeElsterPin} (the OS keyring).
 */
function promptPin(parent: Gtk.Widget): Promise<string | null> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({
            heading: 'Zertifikat-PIN hinterlegen',
            body: 'Die PIN wird verschlüsselt im GNOME-Schlüsselbund gespeichert — nie im Klartext in der Konfiguration.',
        });
        const group = new Adw.PreferencesGroup();
        const pinRow = new Adw.PasswordEntryRow({ title: 'Zertifikat-PIN' });
        group.add(pinRow);
        dlg.set_extra_child(group);

        dlg.add_response('cancel', 'Abbrechen');
        dlg.add_response('save', 'Speichern');
        dlg.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dlg.set_close_response('cancel');
        dlg.set_default_response('save');
        dlg.choose(parent, null, (_s, res) => {
            const response = dlg.choose_finish(res);
            const pin = pinRow.get_text() ?? '';
            resolve(response === 'save' && pin ? pin : null);
        });
    });
}

function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
