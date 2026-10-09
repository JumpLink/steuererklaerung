/**
 * Pull the attached XML out of a hybrid PDF (ZUGFeRD / Factur-X) in plain TypeScript — no PDF library.
 *
 * The app has no PDF parser (Poppler is only used for thumbnails), so this reads just enough of the
 * file format: it scans for indirect objects instead of walking xref → catalog → /Names →
 * /EmbeddedFiles, which makes it immune to a damaged or incrementally updated xref table. The
 * price is that an orphaned file specification left behind by an incremental save can be found
 * too; the caller therefore checks that the extracted bytes really are an invoice.
 *
 * Handled: classic objects, compressed object streams (/ObjStm), FlateDecode on the attachment,
 * file names as literal / hex / UTF-16BE strings. Not handled: encrypted PDFs, filters other than
 * Flate (reported in German, never thrown as a raw error).
 */

import { inflateSync } from 'node:zlib';
import { EInvoiceError } from './types.ts';

/** Attachment names the e-invoice formats prescribe, best first (compared case-insensitively). */
const KNOWN_NAMES = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml'];

interface PdfObject {
    dict: string;
    /** Byte range of the stream data in the file, when the object has one. */
    stream?: { start: number; end: number };
}

export interface EmbeddedXml {
    name: string;
    bytes: Uint8Array;
}

/** Latin-1 view: one char per byte, so string offsets are file offsets. */
function latin1(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

/** Decode a PDF string token — literal `( … )` with escapes, or hex `< … >`; UTF-16BE when BOM-marked. */
export function decodePdfString(token: string): string {
    let raw: number[] = [];
    if (token.startsWith('(')) {
        const body = token.slice(1, -1);
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c !== '\\') {
                raw.push(body.charCodeAt(i) & 0xff);
                continue;
            }
            const n = body[++i];
            if (n >= '0' && n <= '7') {
                let oct = n;
                while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
                raw.push(parseInt(oct, 8) & 0xff);
            } else {
                const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
                if (n === '\n' || n === '\r') continue; // line continuation
                raw.push(map[n] ?? n.charCodeAt(0));
            }
        }
    } else {
        const hex = token.slice(1, -1).replace(/\s+/g, '');
        const padded = hex.length % 2 ? `${hex}0` : hex;
        raw = (padded.match(/../g) ?? []).map((h) => parseInt(h, 16));
    }
    if (raw[0] === 0xfe && raw[1] === 0xff) {
        let s = '';
        for (let i = 2; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
        return s;
    }
    return String.fromCharCode(...raw);
}

const STRING = String.raw`(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)`;

/** Scan the file into objects, then expand every object stream. */
function readObjects(bytes: Uint8Array, text: string): Map<number, PdfObject> {
    const objects = new Map<number, PdfObject>();
    const objRe = /(\d+)\s+\d+\s+obj\b/g;
    const streamRe = />>\s*stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(text))) {
        const num = Number(m[1]);
        const bodyStart = objRe.lastIndex;
        const endobj = text.indexOf('endobj', bodyStart);
        streamRe.lastIndex = bodyStart;
        const s = streamRe.exec(text);
        if (s && (endobj === -1 || s.index < endobj)) {
            const dict = text.slice(bodyStart, s.index + 2);
            const dataStart = s.index + s[0].length;
            let dataEnd = text.indexOf('endstream', dataStart);
            const len = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
            if (len) {
                const declared = dataStart + Number(len[1]);
                if (/^\s*endstream/.test(text.slice(declared, declared + 12))) dataEnd = declared;
            }
            if (dataEnd === -1) break;
            // Without a trustworthy /Length the data runs to endstream minus its line break.
            if (!len || dataEnd !== dataStart + Number(len[1])) {
                if (text[dataEnd - 1] === '\n') dataEnd--;
                if (text[dataEnd - 1] === '\r') dataEnd--;
            }
            objects.set(num, { dict, stream: { start: dataStart, end: dataEnd } });
            objRe.lastIndex = dataEnd;
        } else if (endobj !== -1) {
            objects.set(num, { dict: text.slice(bodyStart, endobj) });
            objRe.lastIndex = endobj;
        } else {
            break;
        }
    }
    for (const obj of objects.values()) {
        if (!obj.stream || !/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
        const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1]);
        const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1]);
        if (!(n > 0 && first > 0)) continue;
        let inner: string;
        try {
            inner = latin1(decodeStream(bytes, obj));
        } catch {
            continue; // an unreadable object stream hides only the objects inside it
        }
        const header = inner.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i < n; i++) {
            const id = header[i * 2];
            const off = header[i * 2 + 1];
            const next = i + 1 < n ? header[(i + 1) * 2 + 1] : inner.length - first;
            if (Number.isFinite(id) && Number.isFinite(off)) {
                objects.set(id, { dict: inner.slice(first + off, first + next) });
            }
        }
    }
    return objects;
}

function decodeStream(bytes: Uint8Array, obj: PdfObject): Uint8Array {
    const { start, end } = obj.stream!;
    const data = bytes.subarray(start, end);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.dict)?.[1] ?? '';
    if (!filter) return data;
    if (/^\[?\s*\/FlateDecode\s*\]?$/.test(filter) || filter === '/Fl') {
        return new Uint8Array(inflateSync(data));
    }
    throw new EInvoiceError(`Die eingebettete Datei nutzt einen nicht unterstützten PDF-Filter (${filter}).`, 'pdf');
}

/**
 * The XML attached to a hybrid PDF, or `null` when the PDF carries none.
 * Throws {@link EInvoiceError} for an encrypted PDF or an attachment that cannot be unpacked.
 */
export function extractEmbeddedXml(pdf: Uint8Array): EmbeddedXml | null {
    const text = latin1(pdf);
    if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(text)) {
        throw new EInvoiceError(
            'Das PDF ist verschlüsselt — ein eingebetteter Datensatz lässt sich nicht lesen.',
            'encrypted',
        );
    }
    const objects = readObjects(pdf, text);

    const candidates: Array<{ name: string; obj: PdfObject }> = [];
    for (const obj of objects.values()) {
        if (!/\/EF\s*<</.test(obj.dict)) continue;
        const ef = /\/EF\s*<<([^>]*)>>/.exec(obj.dict)?.[1] ?? '';
        const ref = /\/(?:UF|F)\s+(\d+)\s+\d+\s+R/.exec(ef)?.[1];
        const target = ref ? objects.get(Number(ref)) : undefined;
        if (!target?.stream) continue;
        const outside = obj.dict.replace(/\/EF\s*<<[^>]*>>/, '');
        const token =
            new RegExp(String.raw`/UF\s*${STRING}`).exec(outside)?.[1] ??
            new RegExp(String.raw`/F(?![A-Za-z])\s*${STRING}`).exec(outside)?.[1];
        if (!token) continue;
        candidates.push({ name: decodePdfString(token), obj: target });
    }
    const rank = (name: string): number => {
        const i = KNOWN_NAMES.indexOf(name.toLowerCase());
        return i >= 0 ? i : name.toLowerCase().endsWith('.xml') ? KNOWN_NAMES.length : -1;
    };
    const best = candidates.filter((c) => rank(c.name) >= 0).sort((a, b) => rank(a.name) - rank(b.name))[0];
    if (!best) return null;
    try {
        return { name: best.name, bytes: decodeStream(pdf, best.obj) };
    } catch (err) {
        if (err instanceof EInvoiceError) throw err;
        throw new EInvoiceError(`Die eingebettete Datei „${best.name}“ lässt sich nicht entpacken.`, 'pdf');
    }
}
