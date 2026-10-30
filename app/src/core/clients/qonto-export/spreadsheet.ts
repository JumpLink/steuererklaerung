/**
 * Reads the first worksheet of a legacy Excel file (.xls, BIFF8 in an OLE2 container) or an
 * OOXML workbook (.xlsx) into rows of cell values.
 *
 * Replaces SheetJS (`xlsx`), whose npm releases carry unpatched advisories (prototype pollution,
 * ReDoS) while the fixed builds live only on a CDN that `gjsify install` cannot consume. Qonto
 * exports are plain BIFF8 — shared strings and numbers in one sheet — so cell VALUES are all this
 * reads: no styles, number formats or formula text. The row shape mirrors
 * `XLSX.utils.sheet_to_json(ws, { header: 1 })`, which the Qonto parser was written against: one
 * array per row of the sheet's used range, with holes for empty cells.
 *
 * The input is untrusted: offsets are bounds-checked, sector and record chains are length-capped,
 * and the XML scan uses indexOf and anchored patterns only, so no input can make it backtrack.
 */

import { inflateRawSync } from 'node:zlib';

export type CellValue = string | number | boolean | null;

interface Range {
    s: { r: number; c: number };
    e: { r: number; c: number };
}

interface ParsedSheet {
    /** Inclusive used range; null when the sheet has none. */
    range: Range | null;
    cells: Map<number, Map<number, CellValue>>;
}

/** Excel's own grid limits — a corrupt dimension cannot ask for more rows than these. */
const MAX_ROW = 1048575;
const MAX_COL = 16383;

export function readFirstSheet(buf: Uint8Array): CellValue[][] {
    try {
        if (isCfb(buf)) return toRows(readXls(buf));
        if (isZip(buf)) return toRows(readXlsx(buf));
    } catch (e) {
        if (e instanceof RangeError) fail('truncated or corrupt file');
        throw e;
    }
    return fail('not an .xls or .xlsx file');
}

function fail(msg: string): never {
    throw new Error(`Spreadsheet: ${msg}`);
}

function toRows({ range, cells }: ParsedSheet): CellValue[][] {
    if (!range) return [];
    const rows: CellValue[][] = [];
    // The declared range is untrusted: a tiny file may claim the whole grid, so allocate only up to
    // the last row and column that really hold a cell.
    let lastRow = -1;
    let lastCol = -1;
    for (const [r, src] of cells) {
        for (const c of src.keys()) {
            if (r > lastRow) lastRow = r;
            if (c > lastCol) lastCol = c;
        }
    }
    lastRow = Math.min(range.e.r, lastRow, MAX_ROW);
    lastCol = Math.min(range.e.c, lastCol, MAX_COL);
    for (let r = range.s.r; r <= lastRow; r++) {
        const row: CellValue[] = [];
        const src = cells.get(r);
        if (src) for (const [c, v] of src) if (c >= range.s.c && c <= lastCol) row[c - range.s.c] = v;
        rows.push(row);
    }
    return rows;
}

function setCell(cells: ParsedSheet['cells'], r: number, c: number, v: CellValue): void {
    let row = cells.get(r);
    if (!row) cells.set(r, (row = new Map()));
    row.set(c, v);
}

function view(b: Uint8Array): DataView {
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function fromCodes(codes: number[]): string {
    let s = '';
    for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode(...codes.slice(i, i + 8192));
    return s;
}

// ── .xls: OLE2 compound file ────────────────────────────────────────────────────────────────

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;

function isCfb(b: Uint8Array): boolean {
    return b.length >= 512 && CFB_SIGNATURE.every((x, i) => b[i] === x);
}

function u32Table(chunks: Uint8Array[]): Uint32Array {
    const bytes = concat(chunks);
    const dv = view(bytes);
    const out = new Uint32Array(bytes.length >>> 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
    return out;
}

/**
 * Follow a FAT or miniFAT chain. `limit` is the number of sectors that exist: every id must lie
 * below it, so a chain longer than that has a cycle and is cut off before it is read.
 */
function chain(start: number, table: Uint32Array, limit: number): number[] {
    const ids: number[] = [];
    for (let id = start; id < END_OF_CHAIN; id = table[id]) {
        if (id >= table.length || id >= limit || ids.length >= limit) fail('corrupt OLE2 sector chain');
        ids.push(id);
    }
    return ids;
}

function readWorkbookStream(buf: Uint8Array): Uint8Array {
    const dv = view(buf);
    const shift = dv.getUint16(0x1e, true);
    if (shift !== 9 && shift !== 12) fail('unsupported OLE2 sector size');
    if (dv.getUint16(0x20, true) !== 6) fail('unsupported OLE2 sector size');
    const size = 1 << shift;
    const miniSize = 64;
    const sectorCount = Math.ceil(buf.length / size) - 1;
    const sector = (id: number): Uint8Array => {
        if (id >= sectorCount) fail('OLE2 sector out of range');
        return buf.subarray((id + 1) * size, (id + 2) * size);
    };

    // Every table below is sized from these counts, so none may claim more sectors than the file has.
    const fatCount = dv.getUint32(0x2c, true);
    if (fatCount > sectorCount) fail('corrupt OLE2 sector chain');
    const fatIds: number[] = [];
    for (let i = 0; i < 109 && fatIds.length < fatCount; i++) fatIds.push(dv.getUint32(0x4c + 4 * i, true));
    const difatSeen = new Set<number>();
    for (let id = dv.getUint32(0x44, true); fatIds.length < fatCount && id < END_OF_CHAIN;) {
        if (difatSeen.has(id)) fail('corrupt OLE2 sector chain');
        difatSeen.add(id);
        const s = view(sector(id));
        for (let o = 0; o < size - 4 && fatIds.length < fatCount; o += 4) fatIds.push(s.getUint32(o, true));
        id = s.getUint32(size - 4, true);
    }
    const fat = u32Table(fatIds.map(sector));
    const readChain = (start: number) => concat(chain(start, fat, sectorCount).map(sector));

    const dir = readChain(dv.getUint32(0x30, true));
    const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
        const e = view(dir.subarray(o, o + 128));
        const chars = Math.max(0, Math.min(e.getUint16(0x40, true), 64) / 2 - 1);
        const codes: number[] = [];
        for (let i = 0; i < chars; i++) codes.push(e.getUint16(i * 2, true));
        entries.push({
            name: fromCodes(codes).toLowerCase(),
            type: e.getUint8(0x42),
            start: e.getUint32(0x74, true),
            size: e.getUint32(0x78, true),
        });
    }

    const wb = entries.find((e) => e.type === 2 && e.name === 'workbook');
    if (!wb) {
        if (entries.some((e) => e.type === 2 && e.name === 'book'))
            fail('only Excel 97 and later (BIFF8) .xls files are supported');
        fail('no Workbook stream in the .xls file');
    }

    if (wb.size > buf.length) fail('truncated Workbook stream');
    let data: Uint8Array;
    if (wb.size < dv.getUint32(0x38, true)) {
        const ministream = readChain(entries[0].start);
        const miniFat = u32Table(chain(dv.getUint32(0x3c, true), fat, sectorCount).map(sector));
        const miniCount = Math.ceil(ministream.length / miniSize);
        data = concat(
            chain(wb.start, miniFat, miniCount).map((id) => ministream.subarray(id * miniSize, (id + 1) * miniSize)),
        );
    } else {
        data = readChain(wb.start);
    }
    if (data.length < wb.size) fail('truncated Workbook stream');
    return data.subarray(0, wb.size);
}

// ── .xls: BIFF8 records ─────────────────────────────────────────────────────────────────────

const BIFF = {
    FORMULA: 0x0006,
    EOF: 0x000a,
    FILEPASS: 0x002f,
    CONTINUE: 0x003c,
    BOUNDSHEET: 0x0085,
    MULRK: 0x00bd,
    SST: 0x00fc,
    LABELSST: 0x00fd,
    DIMENSIONS: 0x0200,
    NUMBER: 0x0203,
    LABEL: 0x0204,
    BOOLERR: 0x0205,
    STRING: 0x0207,
    RK: 0x027e,
    BOF: 0x0809,
} as const;

interface BiffRecord {
    type: number;
    data: Uint8Array;
    /** Offsets in `data` where a merged CONTINUE record's body begins. */
    breaks: Set<number>;
}

function* biffRecords(stream: Uint8Array, start: number): Generator<BiffRecord> {
    const dv = view(stream);
    let pos = start;
    while (pos + 4 <= stream.length) {
        const type = dv.getUint16(pos, true);
        const parts = [stream.subarray(pos + 4, pos + 4 + dv.getUint16(pos + 2, true))];
        pos += 4 + parts[0].length;
        const breaks = new Set<number>();
        let total = parts[0].length;
        while (pos + 4 <= stream.length && dv.getUint16(pos, true) === BIFF.CONTINUE) {
            const part = stream.subarray(pos + 4, pos + 4 + dv.getUint16(pos + 2, true));
            breaks.add(total);
            parts.push(part);
            total += part.length;
            pos += 4 + part.length;
        }
        yield { type, data: parts.length === 1 ? parts[0] : concat(parts), breaks };
    }
}

/** Character data may be split by CONTINUE; each continuation restates the width in one flag byte. */
function readChars(rec: BiffRecord, pos: number, count: number, wide: boolean): { text: string; pos: number } {
    const { data, breaks } = rec;
    const codes: number[] = [];
    for (let i = 0; i < count; i++) {
        if (breaks.has(pos)) {
            wide = data[pos] !== 0;
            pos++;
        }
        if (pos + (wide ? 2 : 1) > data.length) fail('truncated string in .xls');
        codes.push(wide ? data[pos] | (data[pos + 1] << 8) : data[pos]);
        pos += wide ? 2 : 1;
    }
    return { text: fromCodes(codes), pos };
}

function readXlString(rec: BiffRecord, pos: number): string {
    const d = view(rec.data);
    return readChars(rec, pos + 3, d.getUint16(pos, true), (d.getUint8(pos + 2) & 1) !== 0).text;
}

function readSst(rec: BiffRecord): string[] {
    const d = view(rec.data);
    const count = d.getUint32(4, true);
    const out: string[] = [];
    let pos = 8;
    for (let i = 0; i < count && pos < rec.data.length; i++) {
        const cch = d.getUint16(pos, true);
        const flags = d.getUint8(pos + 2);
        pos += 3;
        let runs = 0;
        let ext = 0;
        if (flags & 0x8) {
            runs = d.getUint16(pos, true);
            pos += 2;
        }
        if (flags & 0x4) {
            ext = d.getUint32(pos, true);
            pos += 4;
        }
        const s = readChars(rec, pos, cch, (flags & 1) !== 0);
        out.push(s.text);
        pos = s.pos + 4 * runs + ext;
    }
    return out;
}

function expectBiff8Bof(rec: BiffRecord): void {
    if (rec.type !== BIFF.BOF) fail('not a BIFF8 workbook');
    if (view(rec.data).getUint16(0, true) !== 0x0600) fail('only Excel 97 and later (BIFF8) .xls files are supported');
}

/** RK: a 30-bit integer or the top 30 bits of a double, optionally scaled by 1/100. */
function rkValue(rk: number): number {
    let n: number;
    if (rk & 2) n = rk >> 2;
    else {
        const dv = new DataView(new ArrayBuffer(8));
        dv.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
        n = dv.getFloat64(0, true);
    }
    return rk & 1 ? n / 100 : n;
}

/** SheetJS keeps `#NULL!` (code 0) as null and drops every other error cell from the row. */
function errorValue(code: number): CellValue | undefined {
    return code === 0 ? null : undefined;
}

function readXls(buf: Uint8Array): ParsedSheet {
    const stream = readWorkbookStream(buf);
    let sst: string[] = [];
    let sheetAt = -1;
    let first = true;
    for (const rec of biffRecords(stream, 0)) {
        if (first) {
            expectBiff8Bof(rec);
            first = false;
        } else if (rec.type === BIFF.FILEPASS) fail('encrypted .xls files are not supported');
        else if (rec.type === BIFF.SST) sst = readSst(rec);
        else if (rec.type === BIFF.BOUNDSHEET && sheetAt < 0) sheetAt = view(rec.data).getUint32(0, true);
        else if (rec.type === BIFF.EOF) break;
    }
    if (sheetAt < 0) fail('the workbook has no sheet');
    return readBiffSheet(stream, sheetAt, sst);
}

function readBiffSheet(stream: Uint8Array, at: number, sst: string[]): ParsedSheet {
    const cells: ParsedSheet['cells'] = new Map();
    // Exclusive end, as the DIMENSIONS record stores it; a cell outside it widens it.
    let range: Range | null = null;
    let depth = 0;
    let pendingString: { r: number; c: number } | null = null;

    const add = (r: number, c: number, v: CellValue | undefined) => {
        range ??= { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        range.s.r = Math.min(range.s.r, r);
        range.s.c = Math.min(range.s.c, c);
        range.e.r = Math.max(range.e.r, r + 1);
        range.e.c = Math.max(range.e.c, c + 1);
        if (v !== undefined) setCell(cells, r, c, v);
    };

    for (const rec of biffRecords(stream, at)) {
        if (rec.type === BIFF.BOF) {
            if (depth === 0) expectBiff8Bof(rec);
            depth++;
            continue;
        }
        if (rec.type === BIFF.EOF) {
            if (--depth <= 0) break;
            continue;
        }
        // Deeper substreams are embedded charts; their records are not this sheet's cells.
        if (depth !== 1) continue;
        const d = view(rec.data);
        const at2 = () => [d.getUint16(0, true), d.getUint16(2, true)] as const;
        switch (rec.type) {
            case BIFF.DIMENSIONS:
                range = {
                    s: { r: d.getUint32(0, true), c: d.getUint16(8, true) },
                    e: { r: d.getUint32(4, true), c: d.getUint16(10, true) },
                };
                break;
            case BIFF.LABELSST: {
                const [r, c] = at2();
                const i = d.getUint32(6, true);
                if (i >= sst.length) fail('shared string index out of range');
                add(r, c, sst[i]);
                break;
            }
            case BIFF.NUMBER: {
                const [r, c] = at2();
                add(r, c, d.getFloat64(6, true));
                break;
            }
            case BIFF.RK: {
                const [r, c] = at2();
                add(r, c, rkValue(d.getInt32(6, true)));
                break;
            }
            case BIFF.MULRK: {
                const [r, c] = at2();
                const n = Math.floor((rec.data.length - 6) / 6);
                for (let i = 0; i < n; i++) add(r, c + i, rkValue(d.getInt32(4 + 6 * i + 2, true)));
                break;
            }
            case BIFF.LABEL: {
                const [r, c] = at2();
                add(r, c, readXlString(rec, 6));
                break;
            }
            case BIFF.BOOLERR: {
                const [r, c] = at2();
                const v = d.getUint8(6);
                add(r, c, d.getUint8(7) === 1 ? errorValue(v) : v === 1);
                break;
            }
            case BIFF.FORMULA: {
                const [r, c] = at2();
                pendingString = null;
                if (d.getUint16(12, true) !== 0xffff) add(r, c, d.getFloat64(6, true));
                else if (d.getUint8(6) === 0) pendingString = { r, c };
                else if (d.getUint8(6) === 1) add(r, c, d.getUint8(8) === 1);
                else if (d.getUint8(6) === 2) add(r, c, errorValue(d.getUint8(8)));
                else if (d.getUint8(6) === 3) add(r, c, '');
                else add(r, c, undefined);
                break;
            }
            case BIFF.STRING:
                if (pendingString) add(pendingString.r, pendingString.c, readXlString(rec, 0));
                pendingString = null;
                break;
        }
    }

    const used = range as Range | null;
    if (!used || used.e.r <= 0 || used.e.c <= 0) return { range: null, cells };
    return { range: { s: used.s, e: { r: used.e.r - 1, c: used.e.c - 1 } }, cells };
}

// ── .xlsx: zip container ────────────────────────────────────────────────────────────────────

/** Refuse to inflate a part that claims to be bigger than any real export (~1200 rows are well under 1 MiB of XML). */
const MAX_PART_BYTES = 64 * 1024 * 1024;

function isZip(b: Uint8Array): boolean {
    return b.length >= 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
}

/**
 * Inflate a raw deflate stream, aborting once it yields more than `limit` bytes — the size the zip
 * directory declared — so an entry that lies about its size cannot allocate past it.
 */
function inflateAtMost(raw: Uint8Array, limit: number): Uint8Array {
    try {
        return inflateRawSync(raw, { maxOutputLength: Math.max(limit, 1) });
    } catch (e) {
        if (e instanceof RangeError && (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
            fail('.xlsx part too large');
        }
        fail('corrupt .xlsx (zip entry)');
    }
}

function readZip(buf: Uint8Array): Map<string, () => Uint8Array> {
    const dv = view(buf);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) fail('corrupt .xlsx (no zip directory)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map<string, () => Uint8Array>();
    const decoder = new TextDecoder();
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) fail('corrupt .xlsx (zip directory)');
        const method = dv.getUint16(p + 10, true);
        const compSize = dv.getUint32(p + 20, true);
        const size = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const local = dv.getUint32(p + 42, true);
        const name = decoder
            .decode(buf.subarray(p + 46, p + 46 + nameLen))
            .replace(/\\/g, '/')
            .toLowerCase();
        entries.set(name, () => {
            if (dv.getUint32(local, true) !== 0x04034b50) fail('corrupt .xlsx (zip entry)');
            const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
            const raw = buf.subarray(start, start + compSize);
            if (raw.length < compSize) fail('truncated .xlsx');
            if (method === 0) return raw;
            if (method !== 8) fail('unsupported .xlsx compression');
            if (size > MAX_PART_BYTES) fail('.xlsx part too large');
            return inflateAtMost(raw, size);
        });
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return entries;
}

// ── .xlsx: XML ──────────────────────────────────────────────────────────────────────────────

interface XmlTag {
    /** Local name, namespace prefix stripped. */
    name: string;
    attrs: Map<string, string>;
    closing: boolean;
    selfClosing: boolean;
    start: number;
    end: number;
}

function skipPast(xml: string, marker: string, from: number): number {
    const i = xml.indexOf(marker, from);
    return i < 0 ? xml.length : i + marker.length;
}

/** The `>` that closes a tag, skipping quoted attribute values; one forward pass, never rescans. */
function tagEnd(xml: string, from: number): number {
    for (let i = from; i < xml.length; i++) {
        const ch = xml[i];
        if (ch === '>') return i;
        if (ch === '"' || ch === "'") {
            i = xml.indexOf(ch, i + 1);
            if (i < 0) return -1;
        }
    }
    return -1;
}

function* xmlTags(xml: string): Generator<XmlTag> {
    let i = 0;
    for (;;) {
        const lt = xml.indexOf('<', i);
        if (lt < 0) return;
        if (xml.startsWith('<!--', lt)) i = skipPast(xml, '-->', lt);
        else if (xml.startsWith('<![CDATA[', lt)) i = skipPast(xml, ']]>', lt);
        else if (xml[lt + 1] === '?' || xml[lt + 1] === '!') i = skipPast(xml, '>', lt);
        else {
            const gt = tagEnd(xml, lt + 1);
            if (gt < 0) return;
            const closing = xml[lt + 1] === '/';
            const selfClosing = xml[gt - 1] === '/';
            const inner = xml.slice(lt + (closing ? 2 : 1), selfClosing ? gt - 1 : gt);
            const raw = /^[^\s/>]*/.exec(inner)![0];
            yield {
                name: raw.slice(raw.indexOf(':') + 1),
                attrs: parseAttrs(inner.slice(raw.length)),
                closing,
                selfClosing,
                start: lt,
                end: gt + 1,
            };
            i = gt + 1;
        }
    }
}

function parseAttrs(s: string): Map<string, string> {
    const out = new Map<string, string>();
    let i = 0;
    for (;;) {
        const eq = s.indexOf('=', i);
        if (eq < 0) return out;
        let q = eq + 1;
        while (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r') q++;
        const quote = s[q];
        if (quote !== '"' && quote !== "'") return out;
        const close = s.indexOf(quote, q + 1);
        if (close < 0) return out;
        out.set(s.slice(i, eq).trim(), decodeXml(s.slice(q + 1, close)));
        i = close + 1;
    }
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", gt: '>', lt: '<', amp: '&' };

function decodeEntities(s: string): string {
    return s
        .replace(/&(quot|apos|gt|lt|amp|#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7});/g, (m, e: string) => {
            if (e[0] !== '#') return NAMED_ENTITIES[e];
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return code <= 0x10ffff ? String.fromCodePoint(code) : m;
        })
        .replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Entity-decode XML text, passing CDATA sections through verbatim. */
function decodeXml(s: string): string {
    let out = '';
    let i = 0;
    for (;;) {
        const c = s.indexOf('<![CDATA[', i);
        if (c < 0) return out + decodeEntities(s.slice(i));
        const end = s.indexOf(']]>', c + 9);
        out += decodeEntities(s.slice(i, c)) + s.slice(c + 9, end < 0 ? s.length : end);
        if (end < 0) return out;
        i = end + 3;
    }
}

function decodeCellRef(ref: string): { r: number; c: number } | null {
    let i = 0;
    let c = 0;
    for (; i < ref.length && ref.charCodeAt(i) >= 65 && ref.charCodeAt(i) <= 90; i++)
        c = c * 26 + ref.charCodeAt(i) - 64;
    const r = Number(ref.slice(i));
    if (i === 0 || i > 3 || !Number.isInteger(r) || r < 1) return null;
    return { r: r - 1, c: c - 1 };
}

function dirOf(path: string): string {
    return path.slice(0, path.lastIndexOf('/') + 1);
}

function resolvePart(base: string, target: string): string {
    const segs: string[] = [];
    for (const s of (target.startsWith('/') ? target.slice(1) : base + target).split('/')) {
        if (s === '..') segs.pop();
        else if (s !== '.' && s !== '') segs.push(s);
    }
    return segs.join('/').toLowerCase();
}

function relationships(xml: string | undefined, base: string): Array<{ id: string; type: string; target: string }> {
    const out: Array<{ id: string; type: string; target: string }> = [];
    if (!xml) return out;
    for (const t of xmlTags(xml)) {
        if (t.closing || t.name !== 'Relationship') continue;
        out.push({
            id: t.attrs.get('Id') ?? '',
            type: t.attrs.get('Type') ?? '',
            target: resolvePart(base, t.attrs.get('Target') ?? ''),
        });
    }
    return out;
}

/** Text runs of an `<si>` / `<is>`: every `<t>`, minus phonetic `<rPh>` guides. */
function collectRichText(xml: string, container: string, onItem: (text: string) => void): void {
    let text: string | null = null;
    let tStart = -1;
    let inPhonetic = false;
    for (const t of xmlTags(xml)) {
        if (t.name === container) {
            if (!t.closing) text = '';
            if ((t.closing || t.selfClosing) && text !== null) {
                onItem(text);
                text = null;
            }
        } else if (text === null) continue;
        else if (t.name === 'rPh') inPhonetic = !t.closing && !t.selfClosing;
        else if (t.name === 't' && !inPhonetic) {
            if (t.closing && tStart >= 0) text += decodeXml(xml.slice(tStart, t.start));
            tStart = !t.closing && !t.selfClosing ? t.end : -1;
        }
    }
}

function readXlsx(buf: Uint8Array): ParsedSheet {
    const zip = readZip(buf);
    const decoder = new TextDecoder();
    const text = (path: string) => {
        const entry = zip.get(path);
        return entry ? decoder.decode(entry()) : undefined;
    };
    const relsOf = (part: string) => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;

    const wbPath =
        relationships(text('_rels/.rels'), '').find((r) => r.type.endsWith('/officeDocument'))?.target ??
        'xl/workbook.xml';
    const wbXml = text(wbPath) ?? fail('no workbook in the .xlsx file');
    const wbRels = relationships(text(relsOf(wbPath)), dirOf(wbPath));

    let sheetRid: string | undefined;
    for (const t of xmlTags(wbXml)) {
        if (t.closing || t.name !== 'sheet') continue;
        for (const [k, v] of t.attrs) if (k.endsWith(':id')) sheetRid = v;
        break;
    }
    const sheetPath = wbRels.find((r) => r.id === sheetRid)?.target ?? fail('the workbook has no sheet');
    const sstPath = wbRels.find((r) => r.type.endsWith('/sharedStrings'))?.target;
    const sst: string[] = [];
    const sstXml = sstPath ? text(sstPath) : undefined;
    if (sstXml) collectRichText(sstXml, 'si', (s) => sst.push(s));

    return readXlsxSheet(text(sheetPath) ?? fail('sheet part missing from the .xlsx file'), sst);
}

function readXlsxSheet(xml: string, sst: string[]): ParsedSheet {
    const cells: ParsedSheet['cells'] = new Map();
    let dimension: Range | null = null;
    const guess: Range = { s: { r: 2000000, c: 2000000 }, e: { r: -1, c: -1 } };
    let row = 0;
    let col = -1;
    let cell: { r: number; c: number; type: string; v?: string; inline?: string } | null = null;
    let vStart = -1;
    let isStart = -1;
    let inlineText: string | undefined;

    const finish = () => {
        if (!cell) return;
        const { r, c, type, v } = cell;
        cell = null;
        let value: CellValue | undefined;
        switch (type) {
            case 'n':
                value = v === undefined || v === '' ? undefined : parseFloat(v);
                break;
            case 's':
                if (v === undefined) break;
                value = sst[parseInt(v, 10)];
                if (value === undefined) fail('shared string index out of range');
                break;
            case 'str':
                value = v ?? '';
                break;
            case 'inlineStr':
                value = inlineText ?? '';
                break;
            case 'b':
                value = v === '1' || v === 'true' || v === 'TRUE';
                break;
            case 'e':
                value = v === '#NULL!' ? null : undefined;
                break;
            case 'd': {
                const t = v === undefined ? NaN : Date.parse(v);
                value = Number.isNaN(t) ? undefined : (t - Date.UTC(1899, 11, 30)) / 86400000;
                break;
            }
        }
        if (value !== undefined) setCell(cells, r, c, value);
    };

    for (const t of xmlTags(xml)) {
        if (t.name === 'dimension' && !t.closing) {
            const [a, b = a] = (t.attrs.get('ref') ?? '').split(':');
            const s = decodeCellRef(a);
            const e = decodeCellRef(b);
            if (s && e && s.r <= e.r && s.c <= e.c) dimension = { s, e };
        } else if (t.name === 'row' && !t.closing) {
            const r = Number(t.attrs.get('r'));
            row = Number.isInteger(r) && r > 0 ? r - 1 : row + 1;
            col = -1;
            guess.s.r = Math.min(guess.s.r, row);
            guess.e.r = Math.max(guess.e.r, row);
        } else if (t.name === 'c' && !t.closing) {
            const ref = decodeCellRef(t.attrs.get('r') ?? '');
            col = ref ? ref.c : col + 1;
            cell = { r: ref ? ref.r : row, c: col, type: t.attrs.get('t') ?? 'n' };
            inlineText = undefined;
            if (t.attrs.has('t')) {
                guess.s.c = Math.min(guess.s.c, col);
                guess.e.c = Math.max(guess.e.c, col);
            }
            if (t.selfClosing) finish();
        } else if (t.name === 'c' && t.closing) {
            finish();
        } else if (cell && t.name === 'v') {
            if (t.closing && vStart >= 0) {
                const v = decodeXml(xml.slice(vStart, t.start));
                if (v !== '') {
                    cell.v = v;
                    guess.s.c = Math.min(guess.s.c, cell.c);
                    guess.e.c = Math.max(guess.e.c, cell.c);
                }
            }
            vStart = !t.closing && !t.selfClosing ? t.end : -1;
        } else if (cell && t.name === 'is') {
            if (!t.closing && !t.selfClosing) isStart = t.start;
            if (t.closing && isStart >= 0) {
                collectRichText(xml.slice(isStart, t.end), 'is', (s) => (inlineText = s));
                isStart = -1;
            }
        }
    }

    const range = dimension ?? (guess.e.r >= guess.s.r && guess.e.c >= guess.s.c ? guess : null);
    return { range, cells };
}
