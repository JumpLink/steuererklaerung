/**
 * Test helper: a minimal SMTP server on 127.0.0.1 that accepts any login and records every message
 * it receives, so a test can drive the real sender against it and read back what arrived. Never
 * relays anything.
 */

import { createServer, type Server } from 'node:net';

export interface ReceivedMail {
    mailFrom: string;
    rcptTo: string[];
    /** The DATA section, CRLF-normalized to LF and dot-unstuffed. */
    raw: string;
}

export interface FakeSmtp {
    server: Server;
    port: number;
    messages: ReceivedMail[];
}

export function startFakeSmtp(): Promise<FakeSmtp> {
    const messages: ReceivedMail[] = [];
    const server = createServer((socket) => {
        let inData = false;
        let buffer = '';
        let current: ReceivedMail = { mailFrom: '', rcptTo: [], raw: '' };
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
                        messages.push(current);
                        current = { mailFrom: '', rcptTo: [], raw: '' };
                        socket.write('250 queued\r\n');
                    } else current.raw += `${line.startsWith('..') ? line.slice(1) : line}\n`;
                    continue;
                }
                const cmd = line.toUpperCase();
                if (cmd.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
                else if (cmd.startsWith('AUTH')) socket.write('235 ok\r\n');
                else if (cmd.startsWith('MAIL FROM:')) {
                    current.mailFrom = line.slice(10).replace(/[<>\s]/g, '');
                    socket.write('250 ok\r\n');
                } else if (cmd.startsWith('RCPT TO:')) {
                    current.rcptTo.push(line.slice(8).replace(/[<>\s]/g, ''));
                    socket.write('250 ok\r\n');
                } else if (cmd.startsWith('DATA')) {
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
            resolve({ server, port: addr.port, messages });
        }),
    );
}
