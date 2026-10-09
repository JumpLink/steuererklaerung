import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmtpAccount } from '@curlew/smtp';
import { createMailSender } from '../../../src/frontends/desktop/data/mail-sender.ts';
import {
    defaultInvoiceMailDeps,
    sendInvoiceEmail,
    type InvoiceMailRequest,
} from '../../../src/core/actions/send-invoice-email.ts';
import { loadRecurringInvoices } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';
import { startFakeSmtp, type FakeSmtp } from '../../helpers/fake-smtp.ts';

// The real way out: sendInvoiceEmail -> defaultInvoiceMailDeps (PDF from the Qonto back-end, log in
// the manifest) -> the desktop sender -> @curlew/smtp -> a socket on 127.0.0.1. Only Qonto's HTTP
// and the SMTP peer are fake; everything between is the shipped code.

/** Every byte value plus a lone dot line, the two things a transport tends to mangle. */
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.4\n'), ...Array.from({ length: 256 }, (_, i) => i)]);
const PDF_TAIL = new TextEncoder().encode('\r\n.\r\n%%EOF\r\n');
const pdfBytes = new Uint8Array([...PDF, ...PDF_TAIL]);

const year = { start: '2026-01-01', end: '2026-12-31' };

const header = (raw: string, name: string): string => {
    const head = raw.slice(0, raw.indexOf('\n\n'));
    const unfolded = head.replace(/\n[ \t]+/g, ' ');
    const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
};

/** The attachment part of a multipart message, decoded. */
function attachment(raw: string): { contentType: string; filename: string; bytes: Uint8Array } | null {
    const boundary = header(raw, 'Content-Type').match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary) return null;
    for (const part of raw.split(`--${boundary}`)) {
        const split = part.indexOf('\n\n');
        if (split < 0) continue;
        const head = part.slice(0, split).replace(/\n[ \t]+/g, ' ');
        if (!/content-disposition:\s*attachment/i.test(head)) continue;
        const body = part.slice(split + 2).replace(/\s+/g, '');
        const bin = atob(body);
        return {
            contentType: head.match(/content-type:\s*([^;\s]+)/i)?.[1] ?? '',
            filename: head.match(/filename="?([^";]+)"?/i)?.[1] ?? '',
            bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)),
        };
    }
    return null;
}

export default async () => {
    await describe('invoice mail end to end (fake Qonto, fake SMTP on 127.0.0.1)', async () => {
        const dirs: string[] = [];
        let smtp: FakeSmtp;
        let fetchFn: ReturnType<typeof vi.fn>;
        let prevLedger: string | undefined;

        const fixture = (): string => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        name: 'Demo Studio',
                        accounts: ['qonto:demo*'],
                        invoicing: { type: 'qonto' },
                        recurring: [
                            {
                                id: 'demo-hosting',
                                entityId: 'demo',
                                customer: { name: 'Demo Kunde', email: 'test@example.invalid' },
                                nextPeriod: { start: '2027-01-01', end: '2027-12-31' },
                                items: [{ title: 'Hosting', unitPrice: 100 }],
                                lastInvoice: {
                                    number: 'RE/0001',
                                    issueDate: '2026-01-05',
                                    period: year,
                                    providerId: 'inv-1',
                                },
                            },
                        ],
                    },
                ],
            });
            dirs.push(made.dir);
            return made.path;
        };

        /** Qonto answers the invoice, its attachment, and the pre-signed file URL. */
        const fakeQonto = (invoice: Record<string, unknown>) => {
            fetchFn = vi.fn(async (input: unknown) => {
                const url = String(input);
                if (url.startsWith('https://files.example.invalid/'))
                    return { ok: true, status: 200, arrayBuffer: async () => pdfBytes.buffer.slice(0) };
                const json = url.includes('/attachments/')
                    ? {
                          attachment: {
                              id: 'att-1',
                              file_content_type: 'application/pdf',
                              url: 'https://files.example.invalid/att-1.pdf',
                          },
                      }
                    : { client_invoice: { id: 'inv-1', number: 'RE/0001', status: 'unpaid', ...invoice } };
                return { ok: true, status: 200, text: async () => JSON.stringify(json) };
            });
            vi.stubGlobal('fetch', fetchFn);
        };

        const request = (): InvoiceMailRequest => {
            const account: SmtpAccount = {
                host: '127.0.0.1',
                port: smtp.port,
                security: 'none',
                username: 'demo@example.invalid',
                auth: { kind: 'password', password: 'demo-pass-9c1f' },
            };
            return {
                entityId: 'demo',
                invoiceId: 'inv-1',
                invoiceNumber: 'RE/0001',
                from: 'studio@example.invalid',
                to: ['test@example.invalid'],
                subject: 'Rechnung RE/0001',
                text: 'Hallo,\n\nanbei die Rechnung.',
                account,
            };
        };

        beforeEach(async () => {
            process.env.QONTO_ENV = 'production';
            process.env.QONTO_SIGN_IN = 'org-id';
            process.env.QONTO_SECRET_KEY = 'secret';
            // The send logs to the ledger: keep that out of the real one.
            const ledgerDir = mkdtempSync(join(tmpdir(), 'steuer-e2e-'));
            dirs.push(ledgerDir);
            prevLedger = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(ledgerDir, 'ledger.db');
            smtp = await startFakeSmtp();
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            smtp.server.close();
            delete process.env.QONTO_ENV;
            delete process.env.QONTO_SIGN_IN;
            delete process.env.QONTO_SECRET_KEY;
            if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prevLedger;
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });

        await it('delivers subject, text, an identical PDF and a Message-ID, and logs the send in the manifest', async () => {
            const path = fixture();
            fakeQonto({ attachment_id: 'att-1' });
            const req = request();
            const deps = defaultInvoiceMailDeps(req, createMailSender(), path);

            const preview = await sendInvoiceEmail(req, { confirm: false }, deps);
            expect(preview.status).toBe('preview');
            expect(smtp.messages).toHaveLength(0);
            expect(loadRecurringInvoices(path)[0].lastInvoice?.sentAt).toBe(undefined);

            const sent = await sendInvoiceEmail(req, { confirm: true }, deps);
            expect(sent.status).toBe('sent');
            expect(smtp.messages).toHaveLength(1);

            const mail = smtp.messages[0];
            expect(mail.rcptTo[0]).toBe('test@example.invalid');
            expect(header(mail.raw, 'Subject')).toBe('Rechnung RE/0001');
            expect(mail.raw).toContain('anbei die Rechnung.');
            const messageId = header(mail.raw, 'Message-ID');
            expect(messageId.length > 0).toBe(true);

            const file = attachment(mail.raw);
            expect(file?.contentType).toBe('application/pdf');
            expect(file?.filename).toBe('RE_0001.pdf');
            expect(Array.from(file!.bytes).join(',')).toBe(Array.from(pdfBytes).join(','));

            const last = loadRecurringInvoices(path)[0].lastInvoice;
            expect(last?.messageId).toBe(messageId);
            expect(last?.sentTo?.[0]).toBe('test@example.invalid');
            expect(typeof last?.sentAt).toBe('string');
        });

        await it('loadPdf downloads the Qonto invoice file through its attachment', async () => {
            const path = fixture();
            fakeQonto({ attachment_id: 'att-1' });
            const pdf = await defaultInvoiceMailDeps(request(), createMailSender(), path).loadPdf();
            expect(pdf?.kind).toBe('bytes');
            if (pdf?.kind === 'bytes') {
                expect(pdf.bytes.byteLength).toBe(pdfBytes.byteLength);
                expect(pdf.filename).toBe('RE_0001.pdf');
            }
        });

        await it('says so when Qonto has not generated the file yet, and sends nothing', async () => {
            const path = fixture();
            fakeQonto({});
            let message = '';
            try {
                await sendInvoiceEmail(
                    request(),
                    { confirm: true },
                    defaultInvoiceMailDeps(request(), createMailSender(), path),
                );
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toContain('noch nicht erzeugt');
            expect(smtp.messages).toHaveLength(0);
        });

        await it('refuses a draft, which has no final PDF', async () => {
            const path = fixture();
            fakeQonto({ status: 'draft', attachment_id: 'att-1' });
            let message = '';
            try {
                await defaultInvoiceMailDeps(request(), createMailSender(), path).loadPdf();
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toContain('Entwurf');
        });
    });
};
