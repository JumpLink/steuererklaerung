/**
 * Invented mail for the mail-folder tests (Idee 15): raw RFC 822 messages built from parts, and a
 * fake mailbox that stands in for an IMAP server. Every name, address and file is made up
 * (`*.invalid` / `*.example` addresses, a PDF that is only a few lines of text).
 */
import type { FetchedMessage, MailConnector, MailFolderInfo, MailSource } from '../../src/core/clients/imap/client.ts';

const CRLF = '\r\n';

export interface FixturePart {
    type: string;
    /** Content-Disposition value, e.g. `attachment`; omitted = none. */
    disposition?: string;
    filename?: string;
    /** Raw filename parameter text, for the encoded forms (`filename*=utf-8''…`). */
    filenameParam?: string;
    body: string | Uint8Array;
    encoding?: 'base64' | '7bit';
}

export interface FixtureMail {
    from?: string;
    date?: string;
    subject?: string;
    /** MIME boundary; give a nested message its own. */
    boundary?: string;
    parts: FixturePart[];
}

function b64(bytes: Uint8Array): string {
    return (
        Buffer.from(bytes)
            .toString('base64')
            .match(/.{1,76}/g) ?? []
    ).join(CRLF);
}

/** A multipart/mixed message. */
export function rawMail(mail: FixtureMail): Uint8Array {
    const boundary = mail.boundary ?? 'testgrenze-4711';
    const lines: string[] = [
        `From: ${mail.from ?? 'Anna Beispiel <anna@lieferant.example>'}`,
        'To: belege@firma.invalid',
        `Subject: ${mail.subject ?? 'Rechnung'}`,
        `Date: ${mail.date ?? 'Tue, 12 May 2026 09:30:00 +0200'}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        'Dies ist eine mehrteilige Nachricht.',
    ];
    for (const part of mail.parts) {
        lines.push(`--${boundary}`);
        const name = part.filenameParam ?? (part.filename ? `filename="${part.filename}"` : '');
        lines.push(`Content-Type: ${part.type}${part.filename ? `; name="${part.filename}"` : ''}`);
        if (part.disposition) lines.push(`Content-Disposition: ${part.disposition}${name ? `; ${name}` : ''}`);
        const bytes = typeof part.body === 'string' ? new TextEncoder().encode(part.body) : part.body;
        const encoding =
            part.encoding ?? (typeof part.body === 'string' && part.type.startsWith('text/') ? '7bit' : 'base64');
        lines.push(`Content-Transfer-Encoding: ${encoding}`, '');
        lines.push(encoding === 'base64' ? b64(bytes) : new TextDecoder().decode(bytes));
    }
    lines.push(`--${boundary}--`, '');
    return new TextEncoder().encode(lines.join(CRLF));
}

/** A tiny text PDF; `marker` makes two of them differ. */
export function fixturePdf(marker: string): Uint8Array {
    return new TextEncoder().encode(
        `%PDF-1.4\n% ${marker}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    );
}

export interface FakeMailboxState {
    uidValidity: number;
    uidNext: number | null;
    messages: Map<number, Uint8Array>;
}

/** An IMAP server in a map. Records what was asked of it, so a test can prove what was NOT asked. */
export class FakeMailbox implements MailConnector {
    uidValidity = 1;
    uidNext: number | null = null;
    readonly messages = new Map<number, Uint8Array>();
    readonly fetched: number[] = [];
    readonly searches: Array<{ lastUid: number; sender?: string }> = [];
    connects = 0;
    closed = 0;
    lastPassword: string | null = null;
    failConnect: string | null = null;
    /** Sizes to report instead of the real one, for the too-large path. */
    readonly sizes = new Map<number, number>();

    add(uid: number, mail: FixtureMail | Uint8Array): this {
        this.messages.set(uid, mail instanceof Uint8Array ? mail : rawMail(mail));
        return this;
    }

    async connect(
        _account: { host: string; port: number; security: 'tls' | 'none'; username: string },
        password: string,
    ): Promise<MailSource> {
        this.connects++;
        this.lastPassword = password;
        if (this.failConnect) throw new Error(this.failConnect);
        return {
            openFolder: async (): Promise<MailFolderInfo> => ({ uidValidity: this.uidValidity, uidNext: this.uidNext }),
            uidsAbove: async (lastUid: number, sender?: string): Promise<number[]> => {
                this.searches.push({ lastUid, sender });
                return [...this.messages.keys()]
                    .filter((uid) => uid > lastUid)
                    .filter((uid) => {
                        if (!sender) return true;
                        const head = new TextDecoder().decode(this.messages.get(uid)!.subarray(0, 400));
                        return new RegExp(`^From:.*${sender}`, 'im').test(head);
                    })
                    .sort((a, b) => a - b);
            },
            fetchMessage: async (uid: number, maxBytes: number): Promise<FetchedMessage> => {
                const bytes = this.messages.get(uid);
                if (!bytes) return { kind: 'missing' };
                const size = this.sizes.get(uid) ?? bytes.length;
                if (size > maxBytes) return { kind: 'too-large', size };
                this.fetched.push(uid);
                return { kind: 'ok', bytes };
            },
            close: async (): Promise<void> => {
                this.closed++;
            },
        };
    }
}
