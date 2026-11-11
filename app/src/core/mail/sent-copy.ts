/**
 * Keep a byte-identical copy of a sent invoice mail in the sending account's Sent folder.
 *
 * This is a pure, testable seam: it builds the exact RFC 822 message that went out (through
 * `@curlew/smtp`), opens the account's IMAP server, discovers the `\Sent` SPECIAL-USE mailbox
 * and APPENDs the message with `\Seen`. Any failure is returned as a warning string; the SMTP
 * send itself stays successful.
 */

import { buildMessage } from '@curlew/smtp';
import type { OutgoingMessage } from '@curlew/smtp';
import type { MailConnector, MailSource } from '../clients/imap/client.ts';
import type { MailAccountConfig, MailImapConfig } from '../config/schema/mail.ts';
import { _, fmt } from '../lib/i18n.ts';

export interface SentCopyDeps {
    /** The connector that opens the IMAP transport (real Gio or fake in tests). */
    connector: MailConnector;
    /** The SMTP/IMAP account as stored in the manifest; password is looked up separately. */
    account: MailAccountConfig;
    /** The same password the SMTP send used; IMAP usually shares it. */
    password: string;
    /** The message that was handed to the SMTP sender, including the generated message id. */
    message: OutgoingMessage & { messageId: string };
}

export interface SentCopyResult {
    /** True when the message was appended to the Sent folder. */
    ok: boolean;
    /** Human warning when `ok` is false; never contains the password. */
    warning?: string;
    /** The folder that was used; present only on success. */
    folder?: string;
}

function randomMessageId(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the message id that SMTP send and the Sent copy will share.
 *
 * Mirrors `@curlew/smtp`'s `resolveMessageId` so the id is generated once and reused by both the
 * SMTP sender and `buildMessage` for the IMAP APPEND.
 */
export function resolveSentMessageId(message: OutgoingMessage): string {
    if (message.messageId) return message.messageId;
    return `<${randomMessageId()}@${message.from.slice(message.from.lastIndexOf('@') + 1)}>`;
}

/** Resolve the IMAP host/username, falling back to the SMTP values when omitted. */
function resolveImapAccount(mail: MailAccountConfig): {
    host: string;
    port: number;
    security: 'tls' | 'none';
    username: string;
} {
    const imap: MailImapConfig | undefined = mail.imap;
    return {
        host: imap?.host ?? mail.host,
        port: imap?.port ?? 993,
        security: imap?.security ?? 'tls',
        username: imap?.username ?? mail.username,
    };
}

/** Pick the Sent folder: `\Sent` SPECIAL-USE first, then the configured fallback. */
export function pickSentFolder(folders: { name: string; specialUse: string[] }[], configured?: string): string | null {
    const sent = folders.find((f) => f.specialUse.includes('\\Sent'));
    if (sent) return sent.name;
    if (configured) return configured;
    return null;
}

/**
 * Append a copy of `message` to the sending account's Sent folder.
 *
 * Does not throw: a failure becomes `ok: false` with a redacted warning.
 */
export async function appendSentCopy(deps: SentCopyDeps): Promise<SentCopyResult> {
    const imapAccount = resolveImapAccount(deps.account);
    let source: MailSource | null = null;
    try {
        source = await deps.connector.connect(imapAccount, deps.password);
        const folders = await source.listFolders();
        const folder = pickSentFolder(folders, deps.account.imap?.sentFolder);
        if (!folder) {
            return { ok: false, warning: _('No Sent folder found on the mail server.') };
        }
        const bytes = await buildMessage(deps.message);
        await source.appendMessage(folder, bytes, ['\\Seen']);
        return { ok: true, folder };
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const clean = raw.split(deps.password).join('***').slice(0, 200);
        return { ok: false, warning: fmt(_('Could not save a copy in the Sent folder: {error}'), { error: clean }) };
    } finally {
        await source?.close();
    }
}
