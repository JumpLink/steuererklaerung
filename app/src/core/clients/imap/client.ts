/**
 * A minimal, READ-ONLY IMAP client (RFC 3501) over any byte transport.
 *
 * It does exactly what fetching receipts needs: LOGIN, EXAMINE one folder, `UID SEARCH`, `UID FETCH
 * BODY.PEEK[]`, LOGOUT. The folder is opened with EXAMINE, so the server itself refuses every
 * change — nothing here can set a flag, move or delete a message. Which transport carries the bytes
 * (a TLS socket, a scripted fake in a test) is the caller's business: see `gio-transport.ts`.
 *
 * Why not a library: imapflow & co. need Node's streams and `tls`, which a GJS bundle does not
 * have in the shape they expect, and `@curlew/imap` is not published. The subset here is ~250 lines.
 *
 * Errors carry fixed text plus the server's reply with the password cut out — never the dialogue.
 */

import {
    bytesToLatin1,
    encodeMutf7,
    isQuotable,
    parseMailboxInfo,
    parseMessageSize,
    parseSearchUids,
    quoteImapString,
    type MailboxInfo,
} from './protocol.ts';

/** The socket as the client sees it: bytes in, bytes out. `read` resolves null at end of stream. */
export interface RawTransport {
    read(): Promise<Uint8Array | null>;
    write(bytes: Uint8Array): Promise<void>;
    close(): void;
}

export class ImapError extends Error {
    constructor(
        message: string,
        readonly kind: 'auth' | 'protocol' | 'connection',
    ) {
        super(message);
        this.name = 'ImapError';
    }
}

/** An open folder, as the fetch needs it. */
export interface MailFolderInfo {
    uidValidity: number;
    uidNext: number | null;
}

export type FetchedMessage =
    | { kind: 'ok'; bytes: Uint8Array }
    | { kind: 'too-large'; size: number }
    | { kind: 'missing' };

/** An authenticated, read-only session on one server — the port `core/actions/mail-eingang.ts` fetches through. */
export interface MailSource {
    openFolder(folder: string): Promise<MailFolderInfo>;
    /** UIDs above `lastUid`, ascending; with `sender`, only messages whose From contains it. */
    uidsAbove(lastUid: number, sender?: string): Promise<number[]>;
    fetchMessage(uid: number, maxBytes: number): Promise<FetchedMessage>;
    close(): Promise<void>;
}

/** Opens a session. The password is a parameter for this one call; the connector never stores it. */
export interface MailConnector {
    connect(
        account: { host: string; port: number; security: 'tls' | 'none'; username: string },
        password: string,
    ): Promise<MailSource>;
}

interface Response {
    ok: boolean;
    text: string;
    literals: Uint8Array[];
}

/** One command argument: plain text for the line, or a literal sent after the server's `+`. */
type Part = string | { literal: Uint8Array };

class BufferedReader {
    private buf = new Uint8Array(0);

    constructor(private readonly transport: RawTransport) {}

    private async fill(): Promise<boolean> {
        const chunk = await this.transport.read();
        if (!chunk || chunk.length === 0) return false;
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
        return true;
    }

    /** One line without its CRLF, as latin1; null at end of stream. */
    async readLine(): Promise<string | null> {
        for (;;) {
            const nl = this.buf.indexOf(0x0a);
            if (nl >= 0) {
                const end = nl > 0 && this.buf[nl - 1] === 0x0d ? nl - 1 : nl;
                const line = bytesToLatin1(this.buf.subarray(0, end));
                this.buf = this.buf.slice(nl + 1);
                return line;
            }
            if (!(await this.fill())) return null;
        }
    }

    /** Exactly `n` bytes; throws when the stream ends first (a truncated message must never be stored). */
    async readBytes(n: number): Promise<Uint8Array> {
        const out = new Uint8Array(n);
        let have = 0;
        while (have < n) {
            if (this.buf.length === 0 && !(await this.fill())) {
                throw new ImapError('Die Verbindung brach mitten in einer Nachricht ab.', 'connection');
            }
            const take = Math.min(n - have, this.buf.length);
            out.set(this.buf.subarray(0, take), have);
            this.buf = this.buf.slice(take);
            have += take;
        }
        return out;
    }
}

const encoder = new TextEncoder();

/** `value` as a quoted string, or as a literal when it holds anything a quoted string cannot. */
function argument(value: string): Part[] {
    return isQuotable(value) ? [quoteImapString(value)] : [{ literal: encoder.encode(value) }];
}

export class ImapSession implements MailSource {
    private tag = 0;
    private readonly reader: BufferedReader;
    private secrets: string[] = [];

    private constructor(private readonly transport: RawTransport) {
        this.reader = new BufferedReader(transport);
    }

    /** Greet, log in. Throws {@link ImapError}; the transport is closed on every failure. */
    static async open(
        transport: RawTransport,
        credentials: { username: string; password: string },
    ): Promise<ImapSession> {
        const session = new ImapSession(transport);
        session.secrets = [credentials.password];
        try {
            const greeting = await session.reader.readLine();
            if (!greeting || !/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) {
                throw new ImapError('Der Server meldet sich nicht als IMAP-Server.', 'protocol');
            }
            if (!/^\*\s+PREAUTH\b/i.test(greeting)) {
                const login = await session.command([
                    'LOGIN ',
                    ...argument(credentials.username),
                    ' ',
                    ...argument(credentials.password),
                ]);
                if (!login.ok) {
                    throw new ImapError(`Anmeldung abgelehnt${session.reply(login.text)}`, 'auth');
                }
            }
            return session;
        } catch (err) {
            transport.close();
            throw err;
        }
    }

    /** The server's own words after a failure, with the password removed; empty when there are none. */
    private reply(text: string): string {
        let clean = text.split('\n').pop() ?? '';
        for (const secret of this.secrets) if (secret) clean = clean.split(secret).join('***');
        clean = clean
            .replace(/^\S+\s+(?:NO|BAD)\s*/i, '')
            .split('')
            .map((c) => (c.charCodeAt(0) < 0x20 ? ' ' : c))
            .join('')
            .trim()
            .slice(0, 160);
        return clean ? `: ${clean}` : '';
    }

    private async write(text: string): Promise<void> {
        await this.transport.write(encoder.encode(text));
    }

    private async command(parts: Part[]): Promise<Response> {
        const tag = `a${++this.tag}`;
        let pending = `${tag} `;
        for (const part of parts) {
            if (typeof part === 'string') {
                pending += part;
                continue;
            }
            // Announce the literal, wait for the server's `+`, then send it.
            await this.write(`${pending}{${part.literal.length}}\r\n`);
            const cont = await this.reader.readLine();
            if (!cont || !cont.startsWith('+')) {
                throw new ImapError(`Der Server hat einen Wert nicht angenommen${this.reply(cont ?? '')}`, 'protocol');
            }
            await this.transport.write(part.literal);
            pending = '';
        }
        await this.write(`${pending}\r\n`);
        return this.readResponse(tag);
    }

    /** Read up to the tagged status line; a `{n}` at the end of a line announces n bytes of literal. */
    private async readResponse(tag: string): Promise<Response> {
        const lines: string[] = [];
        const literals: Uint8Array[] = [];
        for (;;) {
            let line = await this.reader.readLine();
            if (line === null) throw new ImapError('Der Server hat die Verbindung beendet.', 'connection');
            for (;;) {
                const m = /\{(\d+)\}$/.exec(line);
                if (!m) break;
                literals.push(await this.reader.readBytes(Number.parseInt(m[1], 10)));
                const rest = await this.reader.readLine();
                if (rest === null) throw new ImapError('Der Server hat die Verbindung beendet.', 'connection');
                line = `${line.slice(0, m.index)}<literal>${rest}`;
            }
            lines.push(line);
            if (line.startsWith(`${tag} `)) {
                const status = /^\S+\s+(OK|NO|BAD)\b/i.exec(line)?.[1].toUpperCase();
                return { ok: status === 'OK', text: lines.join('\n'), literals };
            }
        }
    }

    async openFolder(folder: string): Promise<MailFolderInfo> {
        const r = await this.command(['EXAMINE ', ...argument(encodeMutf7(folder))]);
        if (!r.ok)
            throw new ImapError(`Der Ordner „${folder}“ ließ sich nicht öffnen${this.reply(r.text)}`, 'protocol');
        const info: MailboxInfo = parseMailboxInfo(r.text);
        if (info.uidValidity == null) {
            throw new ImapError(
                'Der Server nennt keine UIDVALIDITY — ohne sie lässt sich nicht merken, was schon geholt ist.',
                'protocol',
            );
        }
        return { uidValidity: info.uidValidity, uidNext: info.uidNext };
    }

    async uidsAbove(lastUid: number, sender?: string): Promise<number[]> {
        const parts: Part[] = [`UID SEARCH UID ${lastUid + 1}:*`];
        if (sender?.trim()) parts.push(' FROM ', ...argument(sender.trim()));
        const r = await this.command(parts);
        if (!r.ok) throw new ImapError(`Die Suche im Ordner schlug fehl${this.reply(r.text)}`, 'protocol');
        // `n:*` always includes the newest message, even when it is older than n.
        return parseSearchUids(r.text).filter((uid) => uid > lastUid);
    }

    async fetchMessage(uid: number, maxBytes: number): Promise<FetchedMessage> {
        const sized = await this.command([`UID FETCH ${uid} (RFC822.SIZE)`]);
        if (!sized.ok)
            throw new ImapError(`Nachricht ${uid} ließ sich nicht abfragen${this.reply(sized.text)}`, 'protocol');
        const size = parseMessageSize(sized.text);
        if (size == null) return { kind: 'missing' };
        if (size > maxBytes) return { kind: 'too-large', size };
        // BODY.PEEK: reading must not mark the message as seen.
        const r = await this.command([`UID FETCH ${uid} (BODY.PEEK[])`]);
        if (!r.ok) throw new ImapError(`Nachricht ${uid} ließ sich nicht laden${this.reply(r.text)}`, 'protocol');
        const bytes = r.literals[0];
        return bytes ? { kind: 'ok', bytes } : { kind: 'missing' };
    }

    async close(): Promise<void> {
        try {
            await this.command(['LOGOUT']);
        } catch {
            // The server may hang up before answering; the socket is closed either way.
        } finally {
            this.transport.close();
        }
    }
}

/** A connector over a transport factory — the one place that decides how bytes reach the server. */
export function imapConnector(
    openTransport: (target: { host: string; port: number; tls: boolean }) => Promise<RawTransport>,
): MailConnector {
    return {
        async connect(account, password) {
            const transport = await openTransport({
                host: account.host,
                port: account.port,
                tls: account.security === 'tls',
            });
            return ImapSession.open(transport, { username: account.username, password });
        },
    };
}
