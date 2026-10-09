/**
 * The desktop's {@link MailSender}: a thin pass-through to `@curlew/smtp`.
 *
 * The library keeps credentials out of its errors; this adapter additionally turns them into
 * German text for the dialog and never forwards anything but that text, so a failure can be shown
 * and logged without leaking the login.
 */

import { SmtpError, sendMessage, verifyAccount, type SmtpErrorCode } from '@curlew/smtp';

import type { MailSender } from '../../../core/mail/mail-sender.ts';

const SUMMARY: Record<SmtpErrorCode, string> = {
    auth: 'Die Anmeldung am Mailserver ist fehlgeschlagen. Benutzer oder Passwort stimmen nicht.',
    tls: 'Die verschlüsselte Verbindung zum Mailserver ließ sich nicht aufbauen.',
    connect: 'Der Mailserver ist nicht erreichbar oder hat die Verbindung abgebrochen.',
    rejected: 'Der Mailserver hat die Nachricht abgelehnt.',
    config: 'Die Angaben zum Versandkonto oder zur Nachricht sind ungültig.',
};

/** The server's own reply, which the library appends after `": "`; empty when there is none. */
function serverReply(err: SmtpError): string {
    const at = err.message.indexOf(': ');
    return at < 0 ? '' : err.message.slice(at + 2).trim();
}

/** Readable German message for an adapter failure; carries no credential. */
export function describeMailError(err: unknown): string {
    if (!(err instanceof SmtpError)) return 'Beim Versand ist ein unerwarteter Fehler aufgetreten.';
    // A `config` error is fixed library text naming the invalid field, safe and the useful part.
    if (err.code === 'config') return `${SUMMARY.config} (${err.message})`;
    const reply = serverReply(err);
    return reply ? `${SUMMARY[err.code]} Antwort des Servers: ${reply}` : SUMMARY[err.code];
}

export interface SmtpLibrary {
    verifyAccount: typeof verifyAccount;
    sendMessage: typeof sendMessage;
}

export function createMailSender(lib: SmtpLibrary = { verifyAccount, sendMessage }): MailSender {
    const guard = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (err) {
            throw new Error(describeMailError(err));
        }
    };
    return {
        verify: (account) => guard(() => lib.verifyAccount(account)),
        send: (account, message) => guard(() => lib.sendMessage(account, message)),
    };
}

export const desktopMailSender: MailSender = createMailSender();
