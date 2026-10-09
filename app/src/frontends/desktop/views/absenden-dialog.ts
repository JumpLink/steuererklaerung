/**
 * Dialogs for the Absenden (ELSTER submission) surface of the Steuererklärung view.
 *
 *   - {@link promptTestSend} — keystore path + PIN for a TEST transmission (Testmerker, discarded at
 *     the clearing house).
 *   - {@link promptLiveSend} — the same credentials for a LIVE (verbindlich) transmission, behind a
 *     stronger irreversibility warning + a final read of the headline figure.
 *   - {@link promptRelease} — a small confirm dialog with an optional note EntryRow for the sign-off.
 *
 * All are promise-based (like views/dialogs.ts) so the section can `await` them. The two credential
 * dialogs send NOTHING themselves: they resolve with the entered credentials ONLY on the explicit send
 * click (both fields filled), else null. The PIN is returned for a single caller-owned send and is
 * persisted (to the OS keyring) only by the caller, only on `savePin`, only after a successful send.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

/** The ELSTER keystore credentials for one transmission (test or live). */
export interface SendCredentials {
    /** Absolute path to the PKCS#12 keystore (.pfx/.p12) that signs the transfer. */
    keystorePath: string;
    /** Keystore PIN — used for this call. Persisted to the keyring ONLY when {@link savePin} is set. */
    pin: string;
    /** Whether the user opted to keep this PIN in the OS keyring after the (successful) send. */
    savePin: boolean;
}
/** Back-compat alias — the credentials shape is identical for a test and a live send. */
export type TestSendCredentials = SendCredentials;

/** Pre-fill + capability hints for a credentials dialog (certificate path, keyring-stored PIN, opt-in). */
export interface SendDefaults {
    /** The certificate path configured for the entity (pre-fills the path row). */
    keystorePath?: string;
    /** A PIN already kept in the keyring for the entity (pre-fills the PIN row). */
    pin?: string;
    /** Whether the OS keyring is reachable ⇒ offer the "PIN speichern" toggle. */
    canSavePin: boolean;
}
export type TestSendDefaults = SendDefaults;

/**
 * Shared builder for the two credential-collecting send dialogs (test + live). Explicit Abbrechen /
 * send buttons (window controls hidden ⇒ exactly one cancel and one deliberate send affordance); a
 * prominent warning card; the send button stays insensitive until BOTH the path and the PIN are set.
 * Resolves with the entered {@link SendCredentials} on the send click, or null on cancel/close.
 */
function promptSend(
    parent: Gtk.Widget,
    opts: {
        title: string;
        warning: { text: string; icon: string; css: 'warning' | 'error' };
        summary?: string;
        sendLabel: string;
        defaults?: SendDefaults;
    },
): Promise<SendCredentials | null> {
    return new Promise((resolve) => {
        const dialog = new Adw.Dialog();
        dialog.set_title(opts.title);
        dialog.set_content_width(520);

        let settled = false;
        const finish = (value: SendCredentials | null): void => {
            if (settled) return;
            settled = true;
            resolve(value);
            dialog.close();
        };

        const header = new Adw.HeaderBar();
        header.set_show_start_title_buttons(false);
        header.set_show_end_title_buttons(false);
        const cancel = new Gtk.Button({ label: 'Abbrechen' });
        cancel.connect('clicked', () => finish(null));
        header.pack_start(cancel);
        const send = new Gtk.Button({ label: opts.sendLabel, cssClasses: ['suggested-action'], sensitive: false });
        header.pack_end(send);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            marginTop: 14,
            marginBottom: 14,
            marginStart: 14,
            marginEnd: 14,
        });

        // Prominent warning card — test: discarded (Testmerker) · live: verbindlich + irreversibel.
        const warn = new Gtk.Box({ cssClasses: ['card'] });
        const warnInner = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            marginTop: 12,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        warnInner.append(
            new Gtk.Image({ iconName: opts.warning.icon, cssClasses: [opts.warning.css], valign: Gtk.Align.START }),
        );
        warnInner.append(new Gtk.Label({ label: opts.warning.text, wrap: true, xalign: 0, cssClasses: ['caption'] }));
        warn.append(warnInner);
        content.append(warn);

        // Optional final-read summary (e.g. the headline figure) before a binding send.
        if (opts.summary) {
            content.append(new Gtk.Label({ label: opts.summary, xalign: 0, cssClasses: ['heading'] }));
        }

        const group = new Adw.PreferencesGroup();
        const pathRow = new Adw.EntryRow({ title: 'Keystore-Pfad (.pfx/.p12)' });
        const browse = new Gtk.Button({
            iconName: 'document-open-symbolic',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltipText: 'Datei wählen',
        });
        browse.connect('clicked', () => {
            const chooser = new Gtk.FileDialog({ title: 'ELSTER-Keystore wählen' });
            chooser.open(parent.get_root() as Gtk.Window | null, null, (_s, res) => {
                try {
                    const file = chooser.open_finish(res);
                    if (file) pathRow.set_text(file.get_path() ?? '');
                } catch {
                    /* user cancelled the file chooser */
                }
            });
        });
        pathRow.add_suffix(browse);
        const pinRow = new Adw.PasswordEntryRow({ title: 'Keystore-PIN' });
        group.add(pathRow);
        group.add(pinRow);

        // Pre-fill from the entity's configured certificate path + any keyring-stored PIN.
        if (opts.defaults?.keystorePath) pathRow.set_text(opts.defaults.keystorePath);
        if (opts.defaults?.pin) pinRow.set_text(opts.defaults.pin);

        // Opt-in to keep the PIN in the OS keyring — only when a keyring is reachable. Default ON when a
        // PIN was pre-filled (keep the stored one), OFF for a freshly typed PIN (deliberate opt-in).
        let saveRow: Adw.SwitchRow | null = null;
        if (opts.defaults?.canSavePin) {
            saveRow = new Adw.SwitchRow({
                title: 'PIN im Schlüsselbund speichern',
                subtitle: 'Verschlüsselt im GNOME-Schlüsselbund, nie im Klartext.',
                active: !!opts.defaults?.pin,
            });
            group.add(saveRow);
        }
        content.append(group);

        const syncSensitive = (): void => {
            const hasPath = (pathRow.get_text() ?? '').trim().length > 0;
            const hasPin = (pinRow.get_text() ?? '').length > 0;
            send.set_sensitive(hasPath && hasPin);
        };
        pathRow.connect('changed', syncSensitive);
        pinRow.connect('changed', syncSensitive);
        syncSensitive(); // pre-fill may already satisfy both fields

        send.connect('clicked', () => {
            const keystorePath = (pathRow.get_text() ?? '').trim();
            const pin = pinRow.get_text() ?? '';
            if (!keystorePath || !pin) return; // guarded by sensitivity, but never send with a blank field
            finish({ keystorePath, pin, savePin: saveRow?.get_active() ?? false });
        });

        // Esc / tapping outside closes the dialog → treat as cancel (idempotent via the settled guard).
        dialog.connect('closed', () => finish(null));

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(content);
        dialog.set_child(toolbar);
        dialog.present(parent);
    });
}

/**
 * Present the TEST-send credentials dialog. Resolves with the entered {@link SendCredentials} on the
 * "Test senden" click (both fields non-empty), or null on cancel/close. Sends nothing — the caller
 * sends in test mode (Testmerker, discarded at the clearing house).
 */
export function promptTestSend(
    parent: Gtk.Widget,
    formTitle: string,
    defaults?: SendDefaults,
): Promise<SendCredentials | null> {
    return promptSend(parent, {
        title: 'Test-Übermittlung',
        warning: {
            icon: 'dialog-warning-symbolic',
            css: 'warning',
            text:
                `Test-Übermittlung von „${formTitle}“ an das ELSTER-Clearing-House — ` +
                'wird dort verworfen (Testmerker). Es wird nichts verbindlich abgegeben.',
        },
        sendLabel: 'Test senden',
        defaults,
    });
}

/**
 * Present the LIVE (verbindlich) send dialog — a heavier variant of {@link promptTestSend} carrying an
 * irreversibility warning and, when given, a final read of the headline figure (`summary`, e.g.
 * "Erstattung 443,17 €"). Resolves with the entered {@link SendCredentials} on the explicit
 * "Jetzt verbindlich senden" click, or null on cancel/close. Sends nothing itself — the caller performs
 * the live send (via the core release gate) and persists the PIN only on success.
 */
export function promptLiveSend(
    parent: Gtk.Widget,
    formTitle: string,
    defaults?: SendDefaults,
    summary?: string,
): Promise<SendCredentials | null> {
    return promptSend(parent, {
        title: 'Verbindlich absenden',
        warning: {
            icon: 'dialog-error-symbolic',
            css: 'error',
            text:
                `„${formTitle}“ wird VERBINDLICH an das Finanzamt übermittelt. ` +
                'Der Vorgang kann NICHT rückgängig gemacht werden — bitte die Werte im Prüfblatt vorher gegenlesen.',
        },
        summary,
        sendLabel: 'Jetzt verbindlich senden',
        defaults,
    });
}

/**
 * Confirm a sign-off (release) with an optional note. Resolves with the trimmed note (possibly '')
 * when confirmed, or null on cancel. The note goes on the append-only sign-off record.
 */
export function promptRelease(parent: Gtk.Widget, formTitle: string): Promise<string | null> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({
            heading: 'Freigeben',
            body:
                `„${formTitle}“ für die Übermittlung freigeben. Die Freigabe ist an den aktuellen Snapshot ` +
                'gebunden und verfällt automatisch, sobald sich die zugrunde liegenden Daten ändern.',
        });
        const group = new Adw.PreferencesGroup();
        const noteRow = new Adw.EntryRow({ title: 'Notiz (optional)' });
        group.add(noteRow);
        dlg.set_extra_child(group);

        dlg.add_response('cancel', 'Abbrechen');
        dlg.add_response('confirm', 'Freigeben');
        dlg.set_response_appearance('confirm', Adw.ResponseAppearance.SUGGESTED);
        dlg.set_close_response('cancel');
        dlg.set_default_response('confirm');
        dlg.choose(parent, null, (_s, res) => {
            const response = dlg.choose_finish(res);
            resolve(response === 'confirm' ? (noteRow.get_text() ?? '').trim() : null);
        });
    });
}
