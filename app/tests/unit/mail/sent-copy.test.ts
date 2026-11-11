import { describe, it, expect } from '@gjsify/unit';
import { appendSentCopy, pickSentFolder, resolveSentMessageId } from '../../../src/core/mail/sent-copy.ts';
import type { MailAccountConfig } from '../../../src/core/config/schema/mail.ts';
import { FakeMailbox } from '../../helpers/mail-fixtures.ts';

const account: MailAccountConfig = {
    host: 'smtp.example.invalid',
    port: 465,
    security: 'tls',
    username: 'demo@example.invalid',
    from: 'studio@example.invalid',
    imap: { host: 'imap.example.invalid', port: 993, security: 'tls', username: 'demo@example.invalid' },
};

const message = {
    from: 'studio@example.invalid',
    to: ['kunde@example.invalid'],
    subject: 'Rechnung RE-0001',
    text: 'Hallo,\n\nanbei die Rechnung.',
    attachments: [{ filename: 'RE-0001.pdf', content: new Uint8Array([1, 2, 3, 4]), contentType: 'application/pdf' }],
    messageId: '<test-1@example.invalid>',
};

export default async () => {
    await describe('sent-copy', async () => {
        await it('picks \\Sent SPECIAL-USE over configured fallback', async () => {
            const folders = [
                { name: 'INBOX', specialUse: [] as string[] },
                { name: 'Sent Items', specialUse: ['\\Sent'] },
                { name: 'Custom', specialUse: [] as string[] },
            ];
            expect(pickSentFolder(folders, 'Custom')).toBe('Sent Items');
            expect(pickSentFolder(folders, undefined)).toBe('Sent Items');
        });

        await it('falls back to configured folder when server has no \\Sent', async () => {
            const folders = [{ name: 'INBOX', specialUse: [] as string[] }];
            expect(pickSentFolder(folders, 'Gesendet')).toBe('Gesendet');
        });

        await it('returns null when there is neither \\Sent nor a configured folder', async () => {
            expect(pickSentFolder([], undefined)).toBe(null);
        });

        await it('appends the exact bytes with \\Seen', async () => {
            const mailbox = new FakeMailbox();
            mailbox.folders = [
                { name: 'INBOX', specialUse: [] as string[] },
                { name: 'Sent', specialUse: ['\\Sent'] },
            ];
            const res = await appendSentCopy({ connector: mailbox, account, password: 'pw', message });
            expect(res.ok).toBe(true);
            expect(res.folder).toBe('Sent');
            expect(mailbox.appended.length).toBe(1);
            expect(mailbox.appended[0].folder).toBe('Sent');
            expect(mailbox.appended[0].flags).toStrictEqual(['\\Seen']);
            expect(mailbox.appended[0].bytes.length).toBeGreaterThan(0);
            expect(new TextDecoder().decode(mailbox.appended[0].bytes)).toContain('<test-1@example.invalid>');
        });

        await it('uses configured fallback folder when server has no \\Sent', async () => {
            const mailbox = new FakeMailbox();
            mailbox.folders = [{ name: 'INBOX', specialUse: [] as string[] }];
            const accountWithFallback: MailAccountConfig = {
                ...account,
                imap: { ...account.imap!, sentFolder: 'Gesendet' },
            };
            const res = await appendSentCopy({
                connector: mailbox,
                account: accountWithFallback,
                password: 'pw',
                message,
            });
            expect(res.ok).toBe(true);
            expect(res.folder).toBe('Gesendet');
        });

        await it('returns a warning without failing the send when append fails', async () => {
            const mailbox = new FakeMailbox();
            mailbox.failAppend = 'quota exceeded';
            mailbox.folders = [{ name: 'Sent', specialUse: ['\\Sent'] }];
            const res = await appendSentCopy({ connector: mailbox, account, password: 'secret-pw', message });
            expect(res.ok).toBe(false);
            expect(res.warning?.includes('quota exceeded')).toBe(true);
            expect(res.warning?.includes('secret-pw')).toBe(false);
        });

        await it('resolves messageId deterministically so SMTP and IMAP share it', async () => {
            const m = {
                from: 'studio@example.invalid',
                to: ['kunde@example.invalid'],
                subject: 'x',
                text: 'y',
            };
            const id = resolveSentMessageId(m);
            expect(id.startsWith('<') && id.endsWith('>')).toBe(true);
            expect(id.includes('@example.invalid')).toBe(true);
            const m2 = { ...m, messageId: id };
            expect(resolveSentMessageId(m2)).toBe(id);
        });
    });
};
