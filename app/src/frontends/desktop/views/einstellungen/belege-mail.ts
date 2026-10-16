/**
 * Einstellungen → Belege aus Mail (Idee 15): the mail folder the built-in DMS fetches receipts from.
 * Server, port, encryption, user, folder and sender filter go to the manifest; the password goes to
 * the keyring and never into the manifest. „Jetzt abrufen“ fetches once and shows the result line;
 * nothing is changed on the mail server. With Paperless the group only points to Paperless' mail rules.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    belegeAusMailAbrufenFuer,
    mailEingangStatus,
    paperlessMailHint,
} from '../../../../core/actions/mail-eingang.ts';
import { gioMailConnector } from '../../../../core/clients/imap/index.ts';
import type { MailEingangConfig } from '../../../../core/config/index.ts';
import { loadMailEingang, saveMailEingang } from '../../../../core/config/index.ts';
import {
    clearMailEingangPassword,
    hasStoredMailEingangPassword,
    lookupMailEingangPassword,
    storeMailEingangPassword,
} from '../../../../core/mail/mail-eingang-secret.ts';
import { appSession } from '../../data/session.ts';
import { loadDms } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { _ } from '../../i18n.ts';
import { showToast } from '../../toast.ts';
import { BhGlossaryHelp, lernmodusOn } from '../../widgets/glossary-help.ts';
import { errorDialog } from '../dialogs.ts';
import type { SettingsHost } from './rows.ts';

const SECURITY = ['tls', 'none'] as const;
const securityLabels = (): string[] => ['TLS (Port 993)', _('None (local only)')];
const DEFAULT_PORT: Record<(typeof SECURITY)[number], number> = { tls: 993, none: 143 };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function buildBelegeMailGroup(host: SettingsHost, entity: AppEntity, parent: Gtk.Widget): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: _('Receipts from mail'),
        description: _(
            'PDF and e-invoice attachments of new messages in a folder land in the receipt inbox. It only reads — nothing is marked, moved or deleted. The password lives in the keyring.',
        ),
    });
    group.set_header_suffix(new BhGlossaryHelp('belege-aus-mail', lernmodusOn()));

    if (loadDms(entity).type === 'paperless') {
        group.add(new Adw.ActionRow({ title: _('Set up with Paperless'), subtitle: paperlessMailHint() }));
        return group;
    }

    const account = loadMailEingang(entity.id);
    let storedPassword = hasStoredMailEingangPassword(entity.id);

    const hostRow = new Adw.EntryRow({ title: _('Server') });
    const portRow = new Adw.EntryRow({ title: _('Port') });
    const securityRow = new Adw.ComboRow({ title: _('Encryption'), model: Gtk.StringList.new(securityLabels()) });
    const userRow = new Adw.EntryRow({ title: _('User') });
    const passwordRow = new Adw.PasswordEntryRow({ title: storedPassword ? _('Password (saved)') : _('Password') });
    const folderRow = new Adw.EntryRow({ title: _('Folder (e.g. INBOX or Belege)') });
    const senderRow = new Adw.EntryRow({ title: _('Only from senders containing … (optional)') });
    const startRow = new Adw.SwitchRow({
        title: _('Fetch when the app starts'),
        subtitle: _('Otherwise only on „Jetzt abrufen“.'),
    });

    hostRow.set_text(account?.host ?? '');
    securityRow.set_selected(Math.max(0, SECURITY.indexOf(account?.security ?? 'tls')));
    portRow.set_text(String(account?.port ?? DEFAULT_PORT[SECURITY[securityRow.get_selected()]]));
    userRow.set_text(account?.username ?? '');
    folderRow.set_text(account?.folder ?? 'INBOX');
    senderRow.set_text(account?.sender ?? '');
    startRow.set_active(account?.onStart === true);

    securityRow.connect('notify::selected', () => {
        const known = Object.values(DEFAULT_PORT).map(String);
        if (!portRow.get_text() || known.includes(portRow.get_text()))
            portRow.set_text(String(DEFAULT_PORT[SECURITY[securityRow.get_selected()]]));
    });
    for (const row of [hostRow, portRow, securityRow, userRow, passwordRow, folderRow, senderRow, startRow])
        group.add(row);

    const accountConfig = (): MailEingangConfig => {
        const server = hostRow.get_text().trim();
        const username = userRow.get_text().trim();
        const port = Number.parseInt(portRow.get_text().trim(), 10);
        if (!server || !username) throw new Error(_('Server and user are required.'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(_('The port is invalid.'));
        const sender = senderRow.get_text().trim();
        return {
            host: server,
            port,
            security: SECURITY[securityRow.get_selected()],
            username,
            folder: folderRow.get_text().trim() || 'INBOX',
            ...(sender ? { sender } : {}),
            ...(startRow.get_active() ? { onStart: true } : {}),
        };
    };

    const save = new Adw.ButtonRow({ title: _('Save mailbox') });
    save.add_css_class('suggested-action');
    save.connect('activated', () => {
        if (host.isFilling()) return;
        let config: MailEingangConfig;
        try {
            config = accountConfig();
        } catch (err) {
            void errorDialog(parent, _('Mailbox not saved'), errorText(err));
            return;
        }
        host.saveWith(() => {
            saveMailEingang(entity.id, config);
            const typed = passwordRow.get_text();
            if (!typed) return;
            if (!storeMailEingangPassword(entity.id, typed))
                throw new Error(_('The password could not be saved in the keyring.'));
            storedPassword = true;
            passwordRow.set_text('');
            passwordRow.set_title(_('Password (saved)'));
        });
    });
    group.add(save);

    const result = new Adw.ActionRow({ title: _('Last fetch'), subtitle: lastLine(entity.id) });
    result.set_subtitle_lines(0);
    const refreshResult = (): void => result.set_subtitle(lastLine(entity.id));

    let fetching = false;
    const fetchRow = new Adw.ButtonRow({ title: _('Fetch now') });
    fetchRow.connect('activated', () => {
        if (fetching) return;
        void (async () => {
            fetching = true;
            fetchRow.set_sensitive(false);
            try {
                // Saved settings are what is fetched; an unsaved edit is not.
                const r = await belegeAusMailAbrufenFuer(entity.id, gioMailConnector);
                if (!r.ok) await errorDialog(parent, _('Fetch not possible'), r.meldung);
                else showToast(r.zusammenfassung);
            } catch (err) {
                await errorDialog(parent, _('Fetch failed'), errorText(err));
            } finally {
                appSession().invalidate(entity.id);
                fetching = false;
                fetchRow.set_sensitive(true);
                refreshResult();
            }
        })();
    });
    group.add(fetchRow);
    group.add(result);

    const forget = new Adw.ButtonRow({ title: _('Delete the saved password') });
    forget.add_css_class('destructive-action');
    forget.connect('activated', () => {
        if (!storedPassword) {
            showToast(_('No password is saved'));
            return;
        }
        clearMailEingangPassword(entity.id);
        storedPassword = hasStoredMailEingangPassword(entity.id);
        passwordRow.set_title(_('Password'));
        showToast(storedPassword ? _('The password could not be deleted') : _('Password deleted'));
    });
    group.add(forget);
    return group;
}

function lastLine(entityId: string): string {
    const s = mailEingangStatus(entityId, lookupMailEingangPassword(entityId) != null);
    if (!s.letzterAbruf?.at) return _('Never fetched yet.');
    return `${s.letzterAbruf.at.slice(0, 16).replace('T', ' ')} · ${s.letzterAbruf.ergebnis ?? '—'}`;
}
