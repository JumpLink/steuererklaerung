/**
 * The desktop's {@link MailSender}: a thin pass-through to `@curlew/smtp`.
 *
 * The library keeps credentials out of its errors; this adapter additionally turns them into
 * readable text for the dialog and never forwards anything but that text, so a failure can be shown
 * and logged without leaking the login.
 */

import { SmtpError, sendMessage, verifyAccount, type SmtpErrorCode } from '@curlew/smtp';

import type { MailSender } from '../../../core/mail/mail-sender.ts';
import { _, fmt } from '../../../core/lib/i18n.ts';

// A function, not a constant: a module-level record is built at import time, before the frontend
// registers its translator, and would stay English.
function summaries(): Record<SmtpErrorCode, string> {
    return {
        auth: _('Signing in to the mail server failed. The user name or the password is wrong.'),
        tls: _('The encrypted connection to the mail server could not be established.'),
        connect: _('The mail server cannot be reached or dropped the connection.'),
        rejected: _('The mail server rejected the message.'),
        config: _('The details of the sending account or of the message are invalid.'),
    };
}

/** The server's own reply, which the library appends after `": "`; empty when there is none. */
function serverReply(err: SmtpError): string {
    const at = err.message.indexOf(': ');
    return at < 0 ? '' : err.message.slice(at + 2).trim();
}

/** Readable message for an adapter failure; carries no credential. */
export function describeMailError(err: unknown): string {
    if (!(err instanceof SmtpError)) return _('Sending failed with an unexpected error.');
    const summary = summaries();
    // A `config` error is fixed library text naming the invalid field, safe and the useful part.
    if (err.code === 'config') return `${summary.config} (${err.message})`;
    const reply = serverReply(err);
    return reply
        ? fmt(_('{summary} The server replied: {reply}'), { summary: summary[err.code], reply })
        : summary[err.code];
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
