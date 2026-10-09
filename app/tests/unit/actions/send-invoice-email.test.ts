import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applySentLog,
    defaultInvoiceMailDeps,
    loadInvoiceMailHistory,
    loadInvoiceMailSetup,
    sendInvoiceEmail,
    pickTemplateId,
    withLegacySent,
    type MailAttempt,
    type InvoiceMailRequest,
    type SentLog,
} from '../../../src/core/actions/send-invoice-email.ts';
import type { MailSender, OutgoingMessage, SendResult, SmtpAccount } from '../../../src/core/mail/mail-sender.ts';
import { RecurringInvoiceSchema } from '../../../src/core/config/schema/recurring.ts';
import { loadRecurringInvoices } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const PASSWORD = 'demo-pass-9c1f';

const account: SmtpAccount = {
    host: 'smtp.example.invalid',
    port: 465,
    security: 'tls',
    username: 'demo@example.invalid',
    auth: { kind: 'password', password: PASSWORD },
};

const request: InvoiceMailRequest = {
    entityId: 'demo',
    invoiceId: 'inv-1',
    invoiceNumber: 'RE-0001',
    from: 'studio@example.invalid',
    to: ['kunde@example.invalid'],
    subject: 'Rechnung RE-0001',
    text: 'Hallo,\n\nanbei die Rechnung.',
    account,
};

/** Records what it was asked to send; never opens a connection. */
class FakeSender implements MailSender {
    sent: { account: SmtpAccount; message: OutgoingMessage }[] = [];
    fail: Error | null = null;
    async verify(): Promise<void> {}
    async send(acct: SmtpAccount, message: OutgoingMessage): Promise<SendResult> {
        if (this.fail) throw this.fail;
        this.sent.push({ account: acct, message });
        return { messageId: '<fake-1@example.invalid>', accepted: message.to, rejected: [], response: '250 ok' };
    }
}

const pdf = async () => ({ kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3, 4]), filename: 'RE-0001.pdf' });
const now = () => new Date('2026-03-01T10:00:00.000Z');

export default async () => {
    await describe('sendInvoiceEmail', async () => {
        await it('previews without sending or logging anything', async () => {
            const sender = new FakeSender();
            const logs: SentLog[] = [];
            const res = await sendInvoiceEmail(
                request,
                { confirm: false },
                {
                    sender,
                    loadPdf: pdf,
                    recordSent: (l) => void logs.push(l),
                },
            );
            expect(res.status).toBe('preview');
            expect(res.preview.to[0]).toBe('kunde@example.invalid');
            expect(res.preview.subject).toBe('Rechnung RE-0001');
            expect(res.preview.attachment.filename).toBe('RE-0001.pdf');
            expect(res.preview.attachment.size).toBe(4);
            expect(sender.sent.length).toBe(0);
            expect(logs.length).toBe(0);
        });

        await it('sends exactly once on confirm and writes the log', async () => {
            const sender = new FakeSender();
            const logs: SentLog[] = [];
            const res = await sendInvoiceEmail(
                request,
                { confirm: true },
                {
                    sender,
                    loadPdf: pdf,
                    recordSent: (l) => void logs.push(l),
                    now,
                },
            );
            expect(sender.sent.length).toBe(1);
            expect(sender.sent[0].message.attachments?.[0].filename).toBe('RE-0001.pdf');
            expect(sender.sent[0].message.attachments?.[0].content.byteLength).toBe(4);
            expect(logs.length).toBe(1);
            expect(logs[0].messageId).toBe('<fake-1@example.invalid>');
            expect(logs[0].sentTo[0]).toBe('kunde@example.invalid');
            expect(logs[0].sentAt).toBe('2026-03-01T10:00:00.000Z');
            expect(res.status).toBe('sent');
        });

        await it('treats anything but boolean true as "do not send"', async () => {
            const sender = new FakeSender();
            const res = await sendInvoiceEmail(
                request,
                { confirm: 'yes' as unknown as boolean },
                {
                    sender,
                    loadPdf: pdf,
                },
            );
            expect(res.status).toBe('preview');
            expect(sender.sent.length).toBe(0);
        });

        await it('keeps the secret out of a sender error', async () => {
            const sender = new FakeSender();
            sender.fail = new Error(`535 login failed for demo@example.invalid with ${PASSWORD}`);
            let message = '';
            try {
                await sendInvoiceEmail(request, { confirm: true }, { sender, loadPdf: pdf });
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toContain('Versand fehlgeschlagen');
            expect(message.includes(PASSWORD)).toBe(false);
        });

        await it('records a failed attempt with its cause, without the secret', async () => {
            const sender = new FakeSender();
            sender.fail = new Error(`535 login failed ${PASSWORD}`);
            const attempts: MailAttempt[] = [];
            try {
                await sendInvoiceEmail(
                    request,
                    { confirm: true },
                    { sender, loadPdf: pdf, now, recordAttempt: (a) => void attempts.push(a) },
                );
            } catch {
                // expected
            }
            expect(attempts.length).toBe(1);
            expect(attempts[0].result).toBe('failed');
            expect(attempts[0].error?.includes('535')).toBe(true);
            expect(attempts[0].error?.includes(PASSWORD)).toBe(false);
            expect(attempts[0].messageId).toBe(null);
        });

        await it('warns about unknown placeholders in the preview', async () => {
            const sender = new FakeSender();
            const attempts: MailAttempt[] = [];
            const res = await sendInvoiceEmail(
                { ...request, subject: 'Re {rechnungsnr}' },
                { confirm: false },
                { sender, loadPdf: pdf, now, recordAttempt: (a) => void attempts.push(a) },
            );
            expect(res.preview.unknownPlaceholders[0]).toBe('rechnungsnr');
            expect(attempts.length).toBe(0);
        });

        await it('blocks sending with an unknown placeholder: sender.send is never called', async () => {
            const sender = new FakeSender();
            const attempts: MailAttempt[] = [];
            let message = '';
            try {
                await sendInvoiceEmail(
                    { ...request, text: 'Betrag {betrg}' },
                    { confirm: true },
                    { sender, loadPdf: pdf, recordAttempt: (a) => void attempts.push(a) },
                );
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toContain('{betrg}');
            expect(message).toContain('Nicht gesendet');
            expect(sender.sent.length).toBe(0);
            expect(attempts.length).toBe(0);
        });

        await it('sends with an unknown placeholder only on explicit allowUnknownPlaceholders', async () => {
            const sender = new FakeSender();
            const res = await sendInvoiceEmail(
                { ...request, text: 'Betrag {betrg}' },
                { confirm: true, allowUnknownPlaceholders: true },
                { sender, loadPdf: pdf },
            );
            expect(res.status).toBe('sent');
            expect(sender.sent.length).toBe(1);
        });

        await it('writes a sent row with the message id to invoice_mails, and a failing manifest write does not hide it', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-mail-'));
            const prev = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            try {
                const sender = new FakeSender();
                const base = defaultInvoiceMailDeps(request, sender);
                const res = await sendInvoiceEmail(
                    request,
                    { confirm: true },
                    {
                        ...base,
                        loadPdf: pdf,
                        now,
                        recordSent: () => {
                            throw new Error(`manifest locked ${PASSWORD}`);
                        },
                    },
                );
                expect(res.status).toBe('sent');
                if (res.status === 'sent') {
                    expect(res.logError?.includes('manifest locked')).toBe(true);
                    expect(res.logError?.includes(PASSWORD)).toBe(false);
                }
                const rows = loadInvoiceMailHistory('demo', 'inv-1');
                expect(rows.length).toBe(1);
                expect(rows[0].result).toBe('sent');
                expect(rows[0].messageId).toBe('<fake-1@example.invalid>');
                expect(rows[0].to[0]).toBe('kunde@example.invalid');
                expect(rows[0].error).toBe(null);
            } finally {
                if (prev === undefined) delete process.env.LEDGER_DB_PATH;
                else process.env.LEDGER_DB_PATH = prev;
                rmSync(dir, { recursive: true, force: true });
            }
        });

        await it('writes a failed row with the cause to invoice_mails', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-mail-'));
            const prev = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            try {
                const sender = new FakeSender();
                sender.fail = new Error(`550 refused ${PASSWORD}`);
                try {
                    await sendInvoiceEmail(
                        request,
                        { confirm: true },
                        { ...defaultInvoiceMailDeps(request, sender), loadPdf: pdf, now },
                    );
                } catch {
                    // expected
                }
                const rows = loadInvoiceMailHistory('demo', 'inv-1');
                expect(rows.length).toBe(1);
                expect(rows[0].result).toBe('failed');
                expect(rows[0].error?.includes('550')).toBe(true);
                expect(rows[0].error?.includes(PASSWORD)).toBe(false);
            } finally {
                if (prev === undefined) delete process.env.LEDGER_DB_PATH;
                else process.env.LEDGER_DB_PATH = prev;
                rmSync(dir, { recursive: true, force: true });
            }
        });

        await it('picks the template contract → project → entity default → built-in', async () => {
            const t = [
                { id: 'a', name: 'A', subject: 's', body: 'b' },
                { id: 'b', name: 'B', subject: 's', body: 'b' },
            ];
            expect(pickTemplateId(t, 'b', 'a', 'a')).toBe('b');
            expect(pickTemplateId(t, undefined, 'a', null)).toBe('a');
            expect(pickTemplateId(t, 'gone', null, 'b')).toBe('b');
            expect(pickTemplateId(t, 'gone')).toBe('standard');
        });

        await it('reports a failed log write without hiding that the mail went out', async () => {
            const sender = new FakeSender();
            const res = await sendInvoiceEmail(
                request,
                { confirm: true },
                {
                    sender,
                    loadPdf: pdf,
                    recordSent: () => {
                        throw new Error(`disk full ${PASSWORD}`);
                    },
                },
            );
            expect(res.status).toBe('sent');
            if (res.status === 'sent') {
                expect(res.logError?.includes(PASSWORD)).toBe(false);
                expect(res.logError).toContain('disk full');
            }
            expect(sender.sent.length).toBe(1);
        });

        await it('refuses a subject that would add mail headers', async () => {
            const sender = new FakeSender();
            let failed = false;
            try {
                await sendInvoiceEmail(
                    { ...request, subject: 'x\r\nBcc: a@example.invalid' },
                    { confirm: true },
                    {
                        sender,
                        loadPdf: pdf,
                    },
                );
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
            expect(sender.sent.length).toBe(0);
        });

        await it('refuses an invalid recipient and a missing or hosted PDF', async () => {
            const sender = new FakeSender();
            const bad = [
                () => sendInvoiceEmail({ ...request, to: ['kein-at'] }, { confirm: true }, { sender, loadPdf: pdf }),
                () => sendInvoiceEmail({ ...request, to: [] }, { confirm: true }, { sender, loadPdf: pdf }),
                () => sendInvoiceEmail(request, { confirm: true }, { sender, loadPdf: async () => null }),
                () =>
                    sendInvoiceEmail(
                        request,
                        { confirm: true },
                        {
                            sender,
                            loadPdf: async () => ({ kind: 'url' as const, url: 'https://example.invalid/x' }),
                        },
                    ),
            ];
            for (const run of bad) {
                let failed = false;
                try {
                    await run();
                } catch {
                    failed = true;
                }
                expect(failed).toBe(true);
            }
            expect(sender.sent.length).toBe(0);
        });
    });

    await describe('applySentLog', async () => {
        const schedule = RecurringInvoiceSchema.parse({
            id: 'demo-hosting',
            entityId: 'demo',
            customer: { name: 'Demo Kunde' },
            nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
            items: [{ title: 'Hosting', unitPrice: 100 }],
            lastInvoice: { number: 'RE-0001', issueDate: '2026-01-01', providerId: 'inv-1' },
        });
        const log: SentLog = {
            sentAt: '2026-03-01T10:00:00.000Z',
            sentTo: ['kunde@example.invalid'],
            messageId: '<a@example.invalid>',
        };

        await it('files the log under the schedule that issued the invoice', async () => {
            const next = applySentLog([schedule], 'demo', { invoiceId: 'inv-1', invoiceNumber: null }, log);
            expect(next?.[0].lastInvoice?.messageId).toBe('<a@example.invalid>');
            expect(next?.[0].lastInvoice?.sentTo?.[0]).toBe('kunde@example.invalid');
            expect(next?.[0].lastInvoice?.number).toBe('RE-0001');
        });

        await it('matches by number when the back-end id is unknown', async () => {
            const next = applySentLog([schedule], 'demo', { invoiceId: 'other', invoiceNumber: 'RE-0001' }, log);
            expect(next?.[0].lastInvoice?.sentAt).toBe(log.sentAt);
        });

        await it('returns null for an invoice without a schedule or of another entity', async () => {
            expect(applySentLog([schedule], 'demo', { invoiceId: 'zzz', invoiceNumber: 'RE-9' }, log)).toBe(null);
            expect(applySentLog([schedule], 'other', { invoiceId: 'inv-1', invoiceNumber: null }, log)).toBe(null);
        });

        await it('stores no credentials, only the three log fields', async () => {
            const next = applySentLog([schedule], 'demo', { invoiceId: 'inv-1', invoiceNumber: null }, log);
            const keys = Object.keys(next![0].lastInvoice!).sort();
            expect(keys).toStrictEqual(['issueDate', 'messageId', 'number', 'providerId', 'sentAt', 'sentTo'].sort());
        });
    });

    await describe('loadInvoiceMailSetup and defaultInvoiceMailDeps', async () => {
        const ref = { invoiceId: 'inv-1', invoiceNumber: 'RE-0001' };
        const mail = {
            host: 'smtp.example.invalid',
            port: 587,
            security: 'starttls',
            username: 'demo',
            from: 'studio@example.invalid',
        };
        const schedule = {
            id: 'demo-hosting',
            customer: { name: 'Demo Kunde', email: 'kunde@example.invalid', closing: 'Beste Grüße' },
            nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
            items: [{ title: 'Hosting', unitPrice: 100 }],
            lastInvoice: {
                number: 'RE-0001',
                issueDate: '2026-01-01',
                providerId: 'inv-1',
                sentAt: '2026-02-01T08:00:00.000Z',
                sentTo: ['alt@example.invalid'],
            },
        };
        const dirs: string[] = [];
        const fixture = (entity: Record<string, unknown>) => {
            const made = writeManifestFixture({ entities: [{ id: 'demo', name: 'Demo Studio', ...entity }] });
            dirs.push(made.dir);
            return made.path;
        };
        const cleanup = () => {
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        };

        await it('collects account, recipient, closing and the last send from entity and schedule', async () => {
            const path = fixture({ invoicing: { type: 'qonto', mail }, recurring: [schedule] });
            const setup = loadInvoiceMailSetup('demo', ref, null, 'Demo Studio', path);
            expect(setup.account?.host).toBe('smtp.example.invalid');
            expect(setup.account?.security).toBe('starttls');
            expect(setup.recipient).toBe('kunde@example.invalid');
            expect(setup.closing).toBe('Beste Grüße');
            expect(setup.issuerName).toBe('Demo Studio');
            expect(setup.lastSent?.sentTo[0]).toBe('alt@example.invalid');
            cleanup();
        });

        await it('signs with the issuer signature, else the issuer name, else the entity', async () => {
            const signed = fixture({
                invoicing: { type: 'qonto', mail, self: { issuer: { name: 'Demo Name', signature: 'Demo | Studio' } } },
                recurring: [schedule],
            });
            expect(loadInvoiceMailSetup('demo', ref, null, 'Demo Studio', signed).issuerName).toBe('Demo | Studio');
            const named = fixture({
                invoicing: { type: 'qonto', mail, self: { issuer: { name: 'Demo Name', signature: '  ' } } },
                recurring: [schedule],
            });
            expect(loadInvoiceMailSetup('demo', ref, null, 'Demo Studio', named).issuerName).toBe('Demo Name');
            cleanup();
        });

        await it('prefers the address of the invoice detail over the schedule', async () => {
            const path = fixture({ invoicing: { type: 'qonto', mail }, recurring: [schedule] });
            const setup = loadInvoiceMailSetup('demo', ref, ' detail@example.invalid ', 'Demo Studio', path);
            expect(setup.recipient).toBe('detail@example.invalid');
            cleanup();
        });

        await it('falls back to empty defaults for an invoice without schedule or account', async () => {
            const path = fixture({ invoicing: { type: 'qonto' } });
            const setup = loadInvoiceMailSetup(
                'demo',
                { invoiceId: 'x', invoiceNumber: null },
                null,
                'Demo Studio',
                path,
            );
            expect(setup.account).toBe(null);
            expect(setup.recipient).toBe('');
            expect(setup.formality).toBe('du');
            expect(setup.lastSent).toBe(null);
            cleanup();
        });

        await it('writes the log onto the issuing schedule in the manifest', async () => {
            const path = fixture({ invoicing: { type: 'qonto', mail }, recurring: [schedule] });
            const deps = defaultInvoiceMailDeps({ entityId: 'demo', ...ref }, new FakeSender(), path);
            await deps.recordSent?.({
                sentAt: '2026-03-01T10:00:00.000Z',
                sentTo: ['kunde@example.invalid'],
                messageId: '<m@example.invalid>',
            });
            const last = loadRecurringInvoices(path)[0].lastInvoice;
            expect(last?.messageId).toBe('<m@example.invalid>');
            expect(last?.sentTo?.[0]).toBe('kunde@example.invalid');
            cleanup();
        });

        await it('leaves the manifest alone for an invoice no schedule issued (log lives in the result only)', async () => {
            const path = fixture({ invoicing: { type: 'qonto', mail }, recurring: [schedule] });
            const deps = defaultInvoiceMailDeps(
                { entityId: 'demo', invoiceId: 'other', invoiceNumber: 'RE-9' },
                new FakeSender(),
                path,
            );
            await deps.recordSent?.({
                sentAt: '2026-03-01T10:00:00.000Z',
                sentTo: ['kunde@example.invalid'],
                messageId: '<m@example.invalid>',
            });
            expect(loadRecurringInvoices(path)[0].lastInvoice?.messageId).toBe(undefined);
            cleanup();
        });
    });

    await describe('withLegacySent', async () => {
        const sent = {
            sentAt: '2026-02-01T09:00:00.000Z',
            sentTo: ['kunde@example.invalid'],
            messageId: '<legacy@example.invalid>',
        };
        const schedule = (lastInvoice: Record<string, unknown>) =>
            RecurringInvoiceSchema.parse({
                id: 'demo-hosting',
                entityId: 'demo',
                customer: { name: 'Demo Kunde' },
                nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
                items: [{ title: 'Hosting', unitPrice: 100 }],
                lastInvoice: { issueDate: '2026-01-01', ...lastInvoice },
            });

        await it('marks an invoice sent by providerId from the contract', async () => {
            const merged = withLegacySent(
                new Map(),
                [schedule({ number: 'RE-0001', providerId: 'inv-1', ...sent })],
                'demo',
                [{ id: 'inv-1', number: 'RE-0001' }],
            );
            const rec = merged.get('inv-1');
            expect(rec?.result).toBe('sent');
            expect(rec?.at).toBe(sent.sentAt);
            expect(rec?.to[0]).toBe('kunde@example.invalid');
        });

        await it('falls back to the invoice number when the back-end id differs', async () => {
            const merged = withLegacySent(new Map(), [schedule({ number: 'RE-0001', ...sent })], 'demo', [
                { id: 'other', number: 'RE-0001' },
            ]);
            expect(merged.get('other')?.result).toBe('sent');
        });

        await it('ignores contracts without a send mark and other entities', async () => {
            const open = schedule({ number: 'RE-0001', providerId: 'inv-1' });
            expect(withLegacySent(new Map(), [open], 'demo', [{ id: 'inv-1', number: 'RE-0001' }]).size).toBe(0);
            const marked = schedule({ number: 'RE-0001', providerId: 'inv-1', ...sent });
            expect(withLegacySent(new Map(), [marked], 'other', [{ id: 'inv-1', number: 'RE-0001' }]).size).toBe(0);
        });

        await it('keeps what the ledger already knows, a failed attempt included', async () => {
            const failed = {
                id: 7,
                entityId: 'demo',
                invoiceId: 'inv-1',
                invoiceNumber: 'RE-0001',
                at: '2026-03-01T10:00:00.000Z',
                from: 'studio@example.invalid',
                to: [],
                subject: 'Rechnung',
                messageId: null,
                result: 'failed' as const,
                error: 'refused',
            };
            const merged = withLegacySent(
                new Map([['inv-1', failed]]),
                [schedule({ number: 'RE-0001', providerId: 'inv-1', ...sent })],
                'demo',
                [{ id: 'inv-1', number: 'RE-0001' }],
            );
            expect(merged.get('inv-1')?.result).toBe('failed');
        });
    });
};
