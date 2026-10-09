/**
 * Einstellungen → Anbindungen → E-Mail-Versand: the SMTP account an entity mails its invoices
 * through. Host, port, user and sender go to the manifest; the password goes to the keyring and
 * never into the manifest. The invoice-mail dialog only reads this account.
 *
 * The system-account entry (GNOME Online-Konten) is a disabled placeholder until
 * `@gjsify/system-accounts` exists; showing it keeps the choice visible.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import type { MailAccountConfig } from '../../../../core/config/index.ts';
import { smtpAccountFor } from '../../../../core/mail/mail-sender.ts';
import { clearMailPassword, lookupMailPassword, storeMailPassword } from '../../data/mail-secret.ts';
import { desktopMailSender } from '../../data/mail-sender.ts';
import { loadInvoicing, saveMailAccount } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { showToast } from '../../toast.ts';
import { errorDialog } from '../dialogs.ts';
import type { SettingsHost } from './rows.ts';

const SECURITY = ['tls', 'starttls', 'none'] as const;
const SECURITY_LABELS = ['TLS (Port 465)', 'STARTTLS (Port 587)', 'Keine (nur lokal)'];
const DEFAULT_PORT: Record<(typeof SECURITY)[number], number> = { tls: 465, starttls: 587, none: 25 };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function buildMailGroup(host: SettingsHost, entity: AppEntity, parent: Gtk.Widget): Adw.PreferencesGroup {
    const account = loadInvoicing(entity).mail ?? null;
    let storedPassword = lookupMailPassword(entity.id);

    const group = new Adw.PreferencesGroup({
        title: 'E-Mail-Versand',
        description:
            'Das Konto, über das Rechnungen per E-Mail rausgehen. Das Passwort liegt im Schlüsselbund, nicht in der Konfiguration.',
    });
    const own = new Adw.ActionRow({ title: 'Eigenes Konto (SMTP)' });
    const ownCheck = new Gtk.CheckButton({ active: true, valign: Gtk.Align.CENTER });
    own.add_prefix(ownCheck);
    group.add(own);
    const system = new Adw.ActionRow({
        title: 'Systemkonto (GNOME Online-Konten)',
        subtitle: 'folgt mit @gjsify/system-accounts',
        sensitive: false,
    });
    system.add_prefix(new Gtk.CheckButton({ group: ownCheck, valign: Gtk.Align.CENTER }));
    group.add(system);

    const hostRow = new Adw.EntryRow({ title: 'Server' });
    const portRow = new Adw.EntryRow({ title: 'Port' });
    const securityRow = new Adw.ComboRow({ title: 'Verschlüsselung', model: Gtk.StringList.new(SECURITY_LABELS) });
    const userRow = new Adw.EntryRow({ title: 'Benutzer' });
    const passwordRow = new Adw.PasswordEntryRow({ title: storedPassword ? 'Passwort (gespeichert)' : 'Passwort' });
    const fromRow = new Adw.EntryRow({ title: 'Absenderadresse' });

    hostRow.set_text(account?.host ?? '');
    securityRow.set_selected(Math.max(0, SECURITY.indexOf(account?.security ?? 'tls')));
    portRow.set_text(String(account?.port ?? DEFAULT_PORT[SECURITY[securityRow.get_selected()]]));
    userRow.set_text(account?.username ?? '');
    fromRow.set_text(account?.from ?? '');

    // Follow the encryption choice with its usual port, unless the person typed another one.
    securityRow.connect('notify::selected', () => {
        const known = Object.values(DEFAULT_PORT).map(String);
        if (!portRow.get_text() || known.includes(portRow.get_text()))
            portRow.set_text(String(DEFAULT_PORT[SECURITY[securityRow.get_selected()]]));
    });
    for (const row of [hostRow, portRow, securityRow, userRow, passwordRow, fromRow]) group.add(row);

    const accountConfig = (): MailAccountConfig => {
        const server = hostRow.get_text().trim();
        const username = userRow.get_text().trim();
        const from = fromRow.get_text().trim();
        const port = Number.parseInt(portRow.get_text().trim(), 10);
        if (!server || !username || !from) throw new Error('Server, Benutzer und Absenderadresse sind nötig.');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Der Port ist ungültig.');
        return { host: server, port, security: SECURITY[securityRow.get_selected()], username, from };
    };

    const save = new Adw.ButtonRow({ title: 'Konto speichern' });
    save.add_css_class('suggested-action');
    save.connect('activated', () => {
        if (host.isFilling()) return;
        let mail: MailAccountConfig;
        try {
            mail = accountConfig();
        } catch (err) {
            void errorDialog(parent, 'Konto nicht gespeichert', errorText(err));
            return;
        }
        host.saveWith(() => {
            saveMailAccount(entity, mail);
            const typed = passwordRow.get_text();
            if (!typed) return;
            if (!storeMailPassword(entity.id, typed))
                throw new Error('Das Passwort ließ sich nicht im Schlüsselbund speichern.');
            storedPassword = typed;
            passwordRow.set_text('');
            passwordRow.set_title('Passwort (gespeichert)');
        });
    });
    group.add(save);

    let testing = false;
    const test = new Adw.ButtonRow({ title: 'Verbindung testen' });
    test.connect('activated', () => {
        if (testing) return;
        void (async () => {
            testing = true;
            try {
                const mail = accountConfig();
                const password = passwordRow.get_text() || storedPassword || '';
                if (!password) throw new Error('Das Passwort fehlt.');
                // Logs in and quits; nothing is sent.
                await desktopMailSender.verify(smtpAccountFor(mail, password));
                showToast('Anmeldung am Mailserver erfolgreich');
            } catch (err) {
                await errorDialog(parent, 'Verbindung fehlgeschlagen', errorText(err));
            } finally {
                testing = false;
            }
        })();
    });
    group.add(test);

    const forget = new Adw.ButtonRow({ title: 'Gespeichertes Passwort löschen' });
    forget.add_css_class('destructive-action');
    forget.connect('activated', () => {
        if (!storedPassword) {
            showToast('Es ist kein Passwort gespeichert');
            return;
        }
        if (!clearMailPassword(entity.id)) {
            void errorDialog(parent, 'Passwort nicht gelöscht', 'Der Schlüsselbund ließ sich nicht erreichen.');
            return;
        }
        storedPassword = null;
        passwordRow.set_title('Passwort');
        showToast('Passwort gelöscht');
    });
    group.add(forget);
    return group;
}
