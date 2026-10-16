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
import { _ } from '../../i18n.ts';
import { showToast } from '../../toast.ts';
import { errorDialog } from '../dialogs.ts';
import type { SettingsHost } from './rows.ts';

const SECURITY = ['tls', 'starttls', 'none'] as const;
const securityLabels = (): string[] => ['TLS (Port 465)', 'STARTTLS (Port 587)', _('None (local only)')];
const DEFAULT_PORT: Record<(typeof SECURITY)[number], number> = { tls: 465, starttls: 587, none: 25 };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function buildMailGroup(host: SettingsHost, entity: AppEntity, parent: Gtk.Widget): Adw.PreferencesGroup {
    const account = loadInvoicing(entity).mail ?? null;
    let storedPassword = lookupMailPassword(entity.id);

    const group = new Adw.PreferencesGroup({
        title: _('Mail sending'),
        description: _(
            'The account that invoices are mailed through. The password lives in the keyring, not in the configuration.',
        ),
    });
    const own = new Adw.ActionRow({ title: _('Own account (SMTP)') });
    const ownCheck = new Gtk.CheckButton({ active: true, valign: Gtk.Align.CENTER });
    own.add_prefix(ownCheck);
    group.add(own);
    const system = new Adw.ActionRow({
        title: _('System account (GNOME Online Accounts)'),
        subtitle: _('follows with @gjsify/system-accounts'),
        sensitive: false,
    });
    system.add_prefix(new Gtk.CheckButton({ group: ownCheck, valign: Gtk.Align.CENTER }));
    group.add(system);

    const hostRow = new Adw.EntryRow({ title: _('Server') });
    const portRow = new Adw.EntryRow({ title: _('Port') });
    const securityRow = new Adw.ComboRow({ title: _('Encryption'), model: Gtk.StringList.new(securityLabels()) });
    const userRow = new Adw.EntryRow({ title: _('User') });
    const passwordRow = new Adw.PasswordEntryRow({ title: storedPassword ? _('Password (saved)') : _('Password') });
    const fromRow = new Adw.EntryRow({ title: _('Sender address') });

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
        if (!server || !username || !from) throw new Error(_('Server, user and sender address are required.'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(_('The port is invalid.'));
        return { host: server, port, security: SECURITY[securityRow.get_selected()], username, from };
    };

    const save = new Adw.ButtonRow({ title: _('Save account') });
    save.add_css_class('suggested-action');
    save.connect('activated', () => {
        if (host.isFilling()) return;
        let mail: MailAccountConfig;
        try {
            mail = accountConfig();
        } catch (err) {
            void errorDialog(parent, _('Account not saved'), errorText(err));
            return;
        }
        host.saveWith(() => {
            saveMailAccount(entity, mail);
            const typed = passwordRow.get_text();
            if (!typed) return;
            if (!storeMailPassword(entity.id, typed))
                throw new Error(_('The password could not be saved in the keyring.'));
            storedPassword = typed;
            passwordRow.set_text('');
            passwordRow.set_title(_('Password (saved)'));
        });
    });
    group.add(save);

    let testing = false;
    const test = new Adw.ButtonRow({ title: _('Test the connection') });
    test.connect('activated', () => {
        if (testing) return;
        void (async () => {
            testing = true;
            try {
                const mail = accountConfig();
                const password = passwordRow.get_text() || storedPassword || '';
                if (!password) throw new Error(_('The password is missing.'));
                // Logs in and quits; nothing is sent.
                await desktopMailSender.verify(smtpAccountFor(mail, password));
                showToast(_('Signed in to the mail server'));
            } catch (err) {
                await errorDialog(parent, _('Connection failed'), errorText(err));
            } finally {
                testing = false;
            }
        })();
    });
    group.add(test);

    const forget = new Adw.ButtonRow({ title: _('Delete the saved password') });
    forget.add_css_class('destructive-action');
    forget.connect('activated', () => {
        if (!storedPassword) {
            showToast(_('No password is saved'));
            return;
        }
        if (!clearMailPassword(entity.id)) {
            void errorDialog(parent, _('Password not deleted'), _('The keyring could not be reached.'));
            return;
        }
        storedPassword = null;
        passwordRow.set_title(_('Password'));
        showToast(_('Password deleted'));
    });
    group.add(forget);
    return group;
}
