/**
 * The pure half of the IMAP client (RFC 3501): how arguments are quoted, how a mailbox name is
 * written on the wire, how the few responses we read are picked apart. No socket, no state.
 */

/** Bytes → one char per byte. IMAP's protocol text is ASCII; message bodies stay bytes elsewhere. */
export function bytesToLatin1(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return out;
}

/** True when `value` may travel as a quoted string: printable ASCII, no quote-breaking control bytes. */
export function isQuotable(value: string): boolean {
    return /^[\x20-\x7e]*$/.test(value);
}

/** A quoted string: `"` and `\` escaped. Only for {@link isQuotable} values; others go as literals. */
export function quoteImapString(value: string): string {
    return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * A mailbox name as it is written on the wire: modified UTF-7 (RFC 3501 §5.1.3). A folder called
 * „Büro“ is `B&APw-ro`; sending it as UTF-8 fails on a server that does not announce UTF8=ACCEPT.
 */
export function encodeMutf7(name: string): string {
    let out = '';
    let pending = '';
    const flush = (): void => {
        if (!pending) return;
        const bytes = new Uint8Array(pending.length * 2);
        for (let i = 0; i < pending.length; i++) {
            const c = pending.charCodeAt(i);
            bytes[i * 2] = c >> 8;
            bytes[i * 2 + 1] = c & 0xff;
        }
        out += `&${Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
        pending = '';
    };
    for (const ch of name) {
        const code = ch.codePointAt(0)!;
        if (code >= 0x20 && code <= 0x7e) {
            flush();
            out += ch === '&' ? '&-' : ch;
        } else {
            pending += ch;
        }
    }
    flush();
    return out;
}

/** What EXAMINE tells about a mailbox. */
export interface MailboxInfo {
    uidValidity: number | null;
    uidNext: number | null;
    exists: number;
}

export function parseMailboxInfo(text: string): MailboxInfo {
    const num = (re: RegExp): number | null => {
        const m = re.exec(text);
        return m ? Number.parseInt(m[1], 10) : null;
    };
    return {
        uidValidity: num(/\[UIDVALIDITY\s+(\d+)\]/i),
        uidNext: num(/\[UIDNEXT\s+(\d+)\]/i),
        exists: num(/^\*\s+(\d+)\s+EXISTS/im) ?? 0,
    };
}

/** The UIDs of a `* SEARCH 4 5 9` answer, ascending. */
export function parseSearchUids(text: string): number[] {
    const uids: number[] = [];
    for (const line of text.split('\n')) {
        const m = /^\*\s+SEARCH\b(.*)$/i.exec(line.trim());
        if (!m) continue;
        for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(Number.parseInt(n, 10));
    }
    return [...new Set(uids)].sort((a, b) => a - b);
}

/** `RFC822.SIZE` of a FETCH answer, or null. */
export function parseMessageSize(text: string): number | null {
    const m = /RFC822\.SIZE\s+(\d+)/i.exec(text);
    return m ? Number.parseInt(m[1], 10) : null;
}
