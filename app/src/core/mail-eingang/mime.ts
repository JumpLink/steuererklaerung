/**
 * A small MIME reader (RFC 5322 / 2045 / 2047 / 2231) for received mail — pure, no I/O.
 *
 * It answers three questions about a message and nothing else: who sent it, when, and which parts
 * are files. It decodes headers (encoded words, folded lines, parameter continuations) and bodies
 * (base64, quoted-printable), walks multipart structures, and does NOT descend into attached
 * messages (`message/rfc822`) — a forwarded mail is not an attachment of this one.
 *
 * Text parts are never decoded to text: the body of a message is not stored or read here, so the
 * parser only produces bytes for parts that carry a file name.
 */

export interface MimePart {
    /** Lower-case media type, e.g. `application/pdf`. */
    type: string;
    /** `attachment`, `inline`, or null when the part says nothing. */
    disposition: 'attachment' | 'inline' | null;
    /** The file name as the part gives it, decoded; null when it has none. */
    filename: string | null;
    /** The decoded content. Only filled for parts the caller asked for with `wantBody`. */
    body: Uint8Array;
}

export interface ParsedMail {
    /** The From header, decoded: `Name <addr>` or the bare address; null when absent. */
    from: string | null;
    /** The date the message states, YYYY-MM-DD as written (no timezone shift); null when unreadable. */
    date: string | null;
    /** Every leaf part, in message order. */
    parts: MimePart[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Bytes → one char per byte (the wire is 8-bit; interpretation happens per header). */
function latin1(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return out;
}

function fromLatin1(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
    const cs = charset.toLowerCase();
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return new TextDecoder('utf-8').decode(bytes);
    // latin1 and windows-1252 agree outside 0x80–0x9F; anything else unknown is read the same way.
    return latin1(bytes);
}

function qDecode(text: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '_') bytes.push(0x20);
        else if (c === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
            bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
        } else bytes.push(c.charCodeAt(0) & 0xff);
    }
    return Uint8Array.from(bytes);
}

/** RFC 2047 encoded words in a header value; whitespace between two encoded words is dropped. */
export function decodeEncodedWords(value: string): string {
    const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
    return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
        const bytes = enc.toLowerCase() === 'b' ? Uint8Array.from(Buffer.from(text, 'base64')) : qDecode(text);
        return decodeCharset(bytes, charset.split('*')[0]);
    });
}

/** Headers of a block, names lower-cased, folded lines joined; the first occurrence of a name wins. */
function parseHeaders(block: string): Map<string, string> {
    const headers = new Map<string, string>();
    let name: string | null = null;
    let value = '';
    const commit = (): void => {
        if (name && !headers.has(name)) headers.set(name, value.trim());
    };
    for (const line of block.split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && name) {
            value += ` ${line.trim()}`;
            continue;
        }
        commit();
        const colon = line.indexOf(':');
        if (colon > 0) {
            name = line.slice(0, colon).trim().toLowerCase();
            value = line.slice(colon + 1);
        } else {
            name = null;
        }
    }
    commit();
    return headers;
}

interface ParamHeader {
    value: string;
    params: Map<string, string>;
}

function pctDecode(text: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
            bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
        } else bytes.push(text.charCodeAt(i) & 0xff);
    }
    return Uint8Array.from(bytes);
}

/** `value; name=x; name*=utf-8''%C3%BC; name*0=…; name*1=…` → value + decoded parameters. */
function parseParamHeader(raw: string | undefined): ParamHeader {
    const params = new Map<string, string>();
    if (!raw) return { value: '', params };
    const segments: string[] = [];
    let current = '';
    let quoted = false;
    for (const ch of raw) {
        if (ch === '"') quoted = !quoted;
        if (ch === ';' && !quoted) {
            segments.push(current);
            current = '';
        } else current += ch;
    }
    segments.push(current);
    const value = (segments.shift() ?? '').trim().toLowerCase();

    const pieces = new Map<string, Array<{ index: number; extended: boolean; text: string }>>();
    for (const seg of segments) {
        const eq = seg.indexOf('=');
        if (eq < 0) continue;
        const name = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(seg.slice(0, eq).trim().toLowerCase());
        if (!name) continue;
        const key = name[1];
        let text = seg.slice(eq + 1).trim();
        if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
            text = text.slice(1, -1).replace(/\\(.)/g, '$1');
        }
        // `name*=` and `name*0*=` are percent-encoded with a charset; `name*1=` continues them.
        const extended = name[3] === '*';
        const list = pieces.get(key) ?? [];
        list.push({ index: name[2] ? Number.parseInt(name[2], 10) : 0, extended, text });
        pieces.set(key, list);
    }
    for (const [key, list] of pieces) {
        list.sort((a, b) => a.index - b.index);
        if (list.some((p) => p.extended)) {
            let charset = 'utf-8';
            let joined = '';
            list.forEach((p, i) => {
                let t = p.text;
                if (i === 0 && p.extended) {
                    const m = /^([^']*)'[^']*'(.*)$/.exec(t);
                    if (m) {
                        charset = m[1] || 'utf-8';
                        t = m[2];
                    }
                }
                joined += t;
            });
            params.set(key, decodeCharset(pctDecode(joined), charset));
        } else {
            params.set(key, decodeEncodedWords(list.map((p) => p.text).join('')));
        }
    }
    return { value, params };
}

/** Decode a part body by its Content-Transfer-Encoding. */
function decodeBody(body: string, encoding: string): Uint8Array {
    const enc = encoding.trim().toLowerCase();
    if (enc === 'base64') return Uint8Array.from(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
    if (enc === 'quoted-printable') {
        const soft = body.replace(/=\r?\n/g, '');
        const bytes: number[] = [];
        for (let i = 0; i < soft.length; i++) {
            if (soft[i] === '=' && /^[0-9a-fA-F]{2}$/.test(soft.slice(i + 1, i + 3))) {
                bytes.push(Number.parseInt(soft.slice(i + 1, i + 3), 16));
                i += 2;
            } else bytes.push(soft.charCodeAt(i) & 0xff);
        }
        return Uint8Array.from(bytes);
    }
    return fromLatin1(body);
}

function splitHeadBody(text: string): [string, string] {
    const m = /\r?\n\r?\n/.exec(text);
    if (!m) return [text, ''];
    return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
}

/** A part as it stands between two delimiters: headers, a blank line, body — the headers may be empty. */
function splitPart(chunk: string): [string, string] {
    if (chunk.startsWith('\r\n')) return ['', chunk.slice(2)];
    if (chunk.startsWith('\n')) return ['', chunk.slice(1)];
    return splitHeadBody(chunk);
}

/** Is a part worth decoding? Parts without a file name are text bodies: never decoded. */
function walk(headBlock: string, body: string, out: MimePart[], depth: number): void {
    const headers = parseHeaders(headBlock);
    const ct = parseParamHeader(headers.get('content-type'));
    const type = ct.value || 'text/plain';

    if (type.startsWith('multipart/') && depth < 8) {
        const boundary = ct.params.get('boundary');
        if (!boundary) return;
        const delimiter = `--${boundary}`;
        const chunks = body.split(delimiter);
        // chunks[0] is the preamble; the part after `--boundary--` is the epilogue.
        for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk.startsWith('--')) break;
            const [h, b] = splitPart(chunk.replace(/^[^\r\n]*\r?\n/, ''));
            walk(h, b.replace(/\r?\n$/, ''), out, depth + 1);
        }
        return;
    }
    if (type === 'message/rfc822') return;

    const cd = parseParamHeader(headers.get('content-disposition'));
    const filename = cd.params.get('filename') ?? ct.params.get('name') ?? null;
    const disposition = cd.value === 'attachment' || cd.value === 'inline' ? cd.value : null;
    const named = filename != null && filename.trim() !== '';
    out.push({
        type,
        disposition,
        filename: named ? filename : null,
        body: named ? decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit') : new Uint8Array(0),
    });
}

/** `Name <a@b>` / `a@b` from a From header value, decoded. */
export function readFrom(raw: string | undefined): string | null {
    if (!raw) return null;
    const decoded = decodeEncodedWords(raw).trim();
    const angle = /^(.*?)<([^>]+)>/.exec(decoded);
    if (angle) {
        const name = angle[1]
            .trim()
            .replace(/^"(.*)"$/, '$1')
            .trim();
        return name ? `${name} <${angle[2].trim()}>` : angle[2].trim();
    }
    return decoded || null;
}

/** The date a Date header states, as written: `Tue, 12 May 2026 09:30:00 +0200` → `2026-05-12`. */
export function readDate(raw: string | undefined): string | null {
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})/.exec(raw ?? '');
    if (!m) return null;
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (month === 0) return null;
    let year = Number.parseInt(m[3], 10);
    if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
    const day = Number.parseInt(m[1], 10);
    if (day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse one raw message. Never throws on odd input: an unreadable structure just yields no parts. */
export function parseMail(raw: Uint8Array): ParsedMail {
    const text = latin1(raw);
    const [headBlock, body] = splitHeadBody(text);
    const headers = parseHeaders(headBlock);
    const parts: MimePart[] = [];
    try {
        walk(headBlock, body, parts, 0);
    } catch {
        // A malformed structure keeps what was found so far.
    }
    return { from: readFrom(headers.get('from')), date: readDate(headers.get('date')), parts };
}
