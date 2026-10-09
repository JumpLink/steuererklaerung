/**
 * The IMAP client against a scripted server: the dialogue it holds, that it is READ-ONLY on the wire
 * (EXAMINE, BODY.PEEK — never SELECT, STORE, EXPUNGE or COPY), literals, mailbox names, and that an
 * error never contains the password. The server is a function from command to reply; no socket.
 */
import { describe, it, expect } from '@gjsify/unit';
import { ImapError, ImapSession, type RawTransport } from '../../../src/core/clients/imap/client.ts';
import { encodeMutf7, parseSearchUids, quoteImapString } from '../../../src/core/clients/imap/protocol.ts';

const enc = new TextEncoder();

/** A transport that answers each complete command line with the bytes `reply(line)` returns. */
function scripted(reply: (line: string) => string | Uint8Array | null, greeting = '* OK IMAP bereit\r\n') {
    const sent: string[] = [];
    const out: Uint8Array[] = [enc.encode(greeting)];
    let waiters: Array<(chunk: Uint8Array | null) => void> = [];
    let closed = false;
    const push = (data: string | Uint8Array) => {
        const bytes = typeof data === 'string' ? enc.encode(data) : data;
        const w = waiters.shift();
        if (w) w(bytes);
        else out.push(bytes);
    };
    const transport: RawTransport = {
        async read() {
            if (out.length) return out.shift()!;
            if (closed) return null;
            return new Promise((resolve) => waiters.push(resolve));
        },
        async write(bytes) {
            const text = new TextDecoder().decode(bytes);
            for (const line of text.split('\r\n').filter(Boolean)) {
                sent.push(line);
                const r = reply(line);
                if (r !== null) push(r);
            }
        },
        close() {
            closed = true;
            for (const w of waiters) w(null);
            waiters = [];
        },
    };
    return { transport, sent, isClosed: () => closed };
}

const tag = (line: string) => line.split(' ')[0];

export default async () => {
    await describe('IMAP-Client — Protokollbausteine', async () => {
        await it('quotes arguments and writes mailbox names in modified UTF-7', async () => {
            expect(quoteImapString('a"b\\c')).toBe('"a\\"b\\\\c"');
            expect(encodeMutf7('INBOX')).toBe('INBOX');
            expect(encodeMutf7('Büro')).toBe('B&APw-ro');
            expect(encodeMutf7('Rechnungen & Belege')).toBe('Rechnungen &- Belege');
        });

        await it('reads a SEARCH answer ascending and without duplicates', async () => {
            expect(parseSearchUids('* SEARCH 9 4 4 12\na3 OK fertig')).toStrictEqual([4, 9, 12]);
            expect(parseSearchUids('* SEARCH\na3 OK fertig')).toStrictEqual([]);
        });
    });

    await describe('IMAP-Client — Sitzung', async () => {
        await it('logs in, opens the folder read-only, searches above the cursor and fetches with PEEK', async () => {
            const message = 'From: x@y.example\r\n\r\nHallo\r\n';
            const { transport, sent, isClosed } = scripted((line) => {
                const t = tag(line);
                if (line.includes(' LOGIN ')) return `${t} OK angemeldet\r\n`;
                if (line.includes(' EXAMINE '))
                    return `* 3 EXISTS\r\n* OK [UIDVALIDITY 4242] ok\r\n* OK [UIDNEXT 9] ok\r\n${t} OK [READ-ONLY] fertig\r\n`;
                if (line.includes('UID SEARCH')) return `* SEARCH 5 7 8\r\n${t} OK fertig\r\n`;
                if (line.includes('RFC822.SIZE'))
                    return `* 1 FETCH (UID 7 RFC822.SIZE ${message.length})\r\n${t} OK fertig\r\n`;
                if (line.includes('BODY.PEEK[]'))
                    return `* 1 FETCH (UID 7 BODY[] {${message.length}}\r\n${message})\r\n${t} OK fertig\r\n`;
                if (line.includes('LOGOUT')) return `* BYE\r\n${t} OK\r\n`;
                return `${t} BAD unbekannt\r\n`;
            });
            const session = await ImapSession.open(transport, {
                username: 'belege@firma.invalid',
                password: 'pw-4711',
            });
            const folder = await session.openFolder('Büro/Belege');
            expect(folder).toStrictEqual({ uidValidity: 4242, uidNext: 9 });
            // `5:*` also answers the newest message when it is older; the client drops it.
            expect(await session.uidsAbove(6)).toStrictEqual([7, 8]);
            const got = await session.fetchMessage(7, 10_000);
            expect(got.kind).toBe('ok');
            if (got.kind === 'ok') expect(new TextDecoder().decode(got.bytes)).toBe(message);
            await session.close();
            expect(isClosed()).toBe(true);

            const joined = sent.join('\n');
            expect(joined).toContain('EXAMINE "B&APw-ro/Belege"');
            expect(joined).toContain('UID SEARCH UID 7:*');
            expect(joined).toContain('BODY.PEEK[]');
            // Read-only on the wire: nothing that could change a mailbox is ever sent.
            expect(/\b(SELECT|STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE|CREATE|RENAME)\b/.test(joined)).toBe(false);
            expect(/BODY\[\]/.test(joined.replace(/BODY\.PEEK\[\]/g, ''))).toBe(false);
        });

        await it('does not download a message over the size limit', async () => {
            const { transport, sent } = scripted((line) => {
                const t = tag(line);
                if (line.includes(' LOGIN ')) return `${t} OK\r\n`;
                if (line.includes('RFC822.SIZE')) return `* 1 FETCH (UID 3 RFC822.SIZE 999999)\r\n${t} OK\r\n`;
                return `${t} OK\r\n`;
            });
            const session = await ImapSession.open(transport, { username: 'u', password: 'p' });
            expect(await session.fetchMessage(3, 1000)).toStrictEqual({ kind: 'too-large', size: 999999 });
            expect(sent.some((l) => l.includes('BODY.PEEK'))).toBe(false);
        });

        await it('adds a sender filter as a FROM search, with a literal for non-ASCII text', async () => {
            let lastTag = '';
            const { transport, sent } = scripted((line) => {
                if (/^a\d+ /.test(line)) lastTag = tag(line);
                if (line.includes('FROM {')) return '+ bitte\r\n';
                if (line.startsWith('Müller')) return `* SEARCH 2\r\n${lastTag} OK\r\n`;
                return `${lastTag} OK\r\n`;
            });
            const session = await ImapSession.open(transport, { username: 'u', password: 'p' });
            await session.uidsAbove(0, 'lieferant.example');
            expect(sent.some((l) => l.includes('FROM "lieferant.example"'))).toBe(true);
            await session.uidsAbove(0, 'Müller');
            expect(sent.some((l) => /FROM \{\d+\}/.test(l))).toBe(true);
        });

        await it('refuses a wrong password without echoing it, and closes the connection', async () => {
            const { transport, isClosed } = scripted(
                (line) => `${tag(line)} NO [AUTHENTICATIONFAILED] falsches pw-4711 für u\r\n`,
            );
            let error: unknown;
            try {
                await ImapSession.open(transport, { username: 'u', password: 'pw-4711' });
            } catch (err) {
                error = err;
            }
            expect(error instanceof ImapError).toBe(true);
            const message = (error as ImapError).message;
            expect(message).toContain('Anmeldung abgelehnt');
            expect(message.includes('pw-4711')).toBe(false);
            expect((error as ImapError).kind).toBe('auth');
            expect(isClosed()).toBe(true);
        });

        await it('does not trust a server that is not IMAP', async () => {
            const { transport } = scripted(() => null, '220 smtp.example ESMTP\r\n');
            let msg = '';
            try {
                await ImapSession.open(transport, { username: 'u', password: 'p' });
            } catch (err) {
                msg = (err as Error).message;
            }
            expect(msg).toContain('IMAP');
        });

        await it('needs a UIDVALIDITY — without it nothing can be remembered', async () => {
            const { transport } = scripted((line) => {
                const t = tag(line);
                return line.includes('EXAMINE') ? `* 0 EXISTS\r\n${t} OK\r\n` : `${t} OK\r\n`;
            });
            const session = await ImapSession.open(transport, { username: 'u', password: 'p' });
            let msg = '';
            try {
                await session.openFolder('INBOX');
            } catch (err) {
                msg = (err as Error).message;
            }
            expect(msg).toContain('UIDVALIDITY');
        });

        await it('fails loudly on a truncated message instead of returning half of it', async () => {
            const { transport } = scripted((line) => {
                const t = tag(line);
                if (line.includes('RFC822.SIZE')) return `* 1 FETCH (UID 1 RFC822.SIZE 50)\r\n${t} OK\r\n`;
                if (line.includes('BODY.PEEK')) return '* 1 FETCH (UID 1 BODY[] {50}\r\nnur ein Stück';
                return `${t} OK\r\n`;
            });
            const session = await ImapSession.open(transport, { username: 'u', password: 'p' });
            let msg = '';
            const pending = session.fetchMessage(1, 1000).catch((err) => {
                msg = (err as Error).message;
            });
            transport.close();
            await pending;
            expect(msg).toContain('brach');
        });
    });
};
