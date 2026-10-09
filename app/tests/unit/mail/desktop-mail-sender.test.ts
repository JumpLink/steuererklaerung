import { describe, it, expect } from '@gjsify/unit';
import { createServer, type Server } from 'node:net';
import { SmtpError, type SmtpAccount } from '@curlew/smtp';
import {
    createMailSender,
    describeMailError,
    type SmtpLibrary,
} from '../../../src/frontends/desktop/data/mail-sender.ts';
import { sendInvoiceEmail } from '../../../src/core/actions/send-invoice-email.ts';

const PASSWORD = 'demo-pass-9c1f';

const account: SmtpAccount = {
    host: 'smtp.example.invalid',
    port: 465,
    security: 'tls',
    username: 'demo@example.invalid',
    auth: { kind: 'password', password: PASSWORD },
};

const message = {
    from: 'studio@example.invalid',
    to: ['test@example.invalid'],
    subject: 'Rechnung RE-0001',
    text: 'Hallo',
};

const lib = (over: Partial<SmtpLibrary> = {}): SmtpLibrary & { calls: string[] } => {
    const calls: string[] = [];
    return {
        calls,
        verifyAccount: async () => void calls.push('verify'),
        sendMessage: async (_a, m) => {
            calls.push('send');
            return { messageId: '<x@example.invalid>', accepted: m.to, rejected: [], response: '250 ok' };
        },
        ...over,
    };
};

/** Minimal SMTP server on loopback: accepts any login and one message, keeps the DATA it received. */
function fakeSmtp(): Promise<{ server: Server; port: number; data: () => string }> {
    let received = '';
    const server = createServer((socket) => {
        let inData = false;
        let buffer = '';
        socket.write('220 fake ESMTP\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let at: number;
            while ((at = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                if (inData) {
                    if (line === '.') {
                        inData = false;
                        socket.write('250 queued\r\n');
                    } else received += `${line}\n`;
                    continue;
                }
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
                else if (cmd.startsWith('AUTH')) socket.write('235 ok\r\n');
                else if (cmd.startsWith('DATA')) {
                    inData = true;
                    socket.write('354 go\r\n');
                } else if (cmd.startsWith('QUIT')) {
                    socket.write('221 bye\r\n');
                    socket.end();
                } else socket.write('250 ok\r\n');
            }
        });
    });
    return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ server, port: addr.port, data: () => received });
        }),
    );
}

const failure = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (err) {
        return (err as Error).message;
    }
    return '';
};

export default async () => {
    await describe('desktop mail sender', async () => {
        await it('passes verify and send through to the library', async () => {
            const fake = lib();
            const sender = createMailSender(fake);
            await sender.verify(account);
            const result = await sender.send(account, message);
            expect(fake.calls.join(',')).toBe('verify,send');
            expect(result.messageId).toBe('<x@example.invalid>');
            expect(result.accepted[0]).toBe('test@example.invalid');
        });

        await it('turns each error code into German text', async () => {
            expect(describeMailError(new SmtpError('auth', 'SMTP login failed', 535))).toContain('Anmeldung');
            expect(describeMailError(new SmtpError('tls', 'SMTP TLS handshake failed'))).toContain('verschlüsselte');
            expect(describeMailError(new SmtpError('connect', 'SMTP connection failed'))).toContain('erreichbar');
            expect(describeMailError(new SmtpError('rejected', 'SMTP server rejected the message'))).toContain(
                'abgelehnt',
            );
        });

        await it('keeps the server reply and names the invalid field of a config error', async () => {
            expect(
                describeMailError(new SmtpError('rejected', 'SMTP server rejected the message: 550 no such user', 550)),
            ).toContain('550 no such user');
            expect(describeMailError(new SmtpError('config', 'SMTP port must be 1-65535'))).toContain(
                'SMTP port must be 1-65535',
            );
        });

        await it('never forwards the text of a foreign error', async () => {
            const sender = createMailSender(
                lib({
                    sendMessage: async () => {
                        throw new Error(`boom ${PASSWORD}`);
                    },
                }),
            );
            const text = await failure(() => sender.send(account, message));
            expect(text).toContain('unerwarteter Fehler');
            expect(text.includes(PASSWORD)).toBe(false);
        });

        await it('refuses security none for a non-loopback host before any network use', async () => {
            const sender = createMailSender();
            const text = await failure(() => sender.verify({ ...account, security: 'none' }));
            expect(text).toContain('ungültig');
            expect(text.includes(PASSWORD)).toBe(false);
        });

        await it('lets the invoice action show the adapter message without the secret', async () => {
            const sender = createMailSender(
                lib({
                    sendMessage: async () => {
                        throw new SmtpError('auth', 'SMTP login failed', 535);
                    },
                }),
            );
            const text = await failure(() =>
                sendInvoiceEmail(
                    { entityId: 'demo', invoiceId: 'i', invoiceNumber: null, ...message, account },
                    { confirm: true },
                    { sender, loadPdf: async () => ({ kind: 'bytes', bytes: new Uint8Array([1]), filename: 'a.pdf' }) },
                ),
            );
            expect(text).toContain('Versand fehlgeschlagen');
            expect(text).toContain('Anmeldung');
            expect(text.includes(PASSWORD)).toBe(false);
        });

        await it('delivers a message with attachment to a fake SMTP on 127.0.0.1', async () => {
            const smtp = await fakeSmtp();
            try {
                const sender = createMailSender();
                const local: SmtpAccount = { ...account, host: '127.0.0.1', port: smtp.port, security: 'none' };
                await sender.verify(local);
                const result = await sender.send(local, {
                    ...message,
                    attachments: [
                        {
                            filename: 'RE-0001.pdf',
                            content: new Uint8Array([37, 80, 68, 70]),
                            contentType: 'application/pdf',
                        },
                    ],
                });
                expect(result.accepted[0]).toBe('test@example.invalid');
                expect(smtp.data()).toContain('Subject: Rechnung RE-0001');
                expect(smtp.data()).toContain('RE-0001.pdf');
            } finally {
                smtp.server.close();
            }
        });
    });
};
