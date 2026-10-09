/**
 * The port through which the app sends mail. Core knows only this interface; no SMTP code, no
 * `gi://`, no secret store.
 *
 * The data types come from `@curlew/smtp` (type-only import, erased at build time), so core never
 * loads the library: the desktop injects the real sender, tests inject a fake.
 */

export type { OutgoingAttachment, OutgoingMessage, SendResult, SmtpAccount } from '@curlew/smtp';
import type { OutgoingMessage, SendResult, SmtpAccount } from '@curlew/smtp';

export interface MailSender {
    /** Connect and authenticate without sending; rejects when the account does not work. */
    verify(account: SmtpAccount): Promise<void>;
    send(account: SmtpAccount, message: OutgoingMessage): Promise<SendResult>;
}

/** The sender's account for a manifest account plus the password the keyring holds for it. */
export function smtpAccountFor(
    mail: { host: string; port: number; security: SmtpAccount['security']; username: string },
    password: string,
): SmtpAccount {
    return {
        host: mail.host,
        port: mail.port,
        security: mail.security,
        username: mail.username,
        auth: { kind: 'password', password },
    };
}
