import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFirstSheet } from '../../../src/core/clients/qonto-export/spreadsheet.ts';
import { getTransactionDate, parseQontoExport } from '../../../src/core/clients/qonto-export/parser.ts';

// Every workbook here is built byte by byte, so no real bank export ever enters the repo.

const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const f64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return [...b];
};
const zeros = (n: number) => Array.from({ length: n }, () => 0);
const latin1 = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const utf16 = (s: string) => [...s].flatMap((ch) => u16(ch.charCodeAt(0)));

// ── BIFF8 records ──

const rec = (type: number, body: number[]) => [...u16(type), ...u16(body.length), ...body];
const bof = (dt: number) => rec(0x0809, [...u16(0x0600), ...u16(dt), ...zeros(12)]);
const eof = () => rec(0x000a, []);
const sst = (strings: string[]) =>
    rec(0x00fc, [
        ...u32(strings.length),
        ...u32(strings.length),
        ...strings.flatMap((s) => [...u16(s.length), 0, ...latin1(s)]),
    ]);
const dimensions = (rows: number, cols: number) =>
    rec(0x0200, [...u32(0), ...u32(rows), ...u16(0), ...u16(cols), ...u16(0)]);
const cell = (r: number, c: number) => [...u16(r), ...u16(c), ...u16(0)];
const labelSst = (r: number, c: number, i: number) => rec(0x00fd, [...cell(r, c), ...u32(i)]);
const number = (r: number, c: number, v: number) => rec(0x0203, [...cell(r, c), ...f64(v)]);
const rk = (r: number, c: number, v: number) => rec(0x027e, [...cell(r, c), ...u32(v)]);
const mulRk = (r: number, c: number, rks: number[]) =>
    rec(0x00bd, [...u16(r), ...u16(c), ...rks.flatMap((x) => [...u16(0), ...u32(x)]), ...u16(c + rks.length - 1)]);

/** One-sheet BIFF8 workbook in an OLE2 container: header, one FAT sector, one directory sector, the stream. */
function buildXls(sstRecords: number[], sheetRecords: number[]): Uint8Array {
    const boundSheet = (offset: number) => rec(0x0085, [...u32(offset), 0, 0, 6, 0, ...latin1('Sheet1')]);
    const globalsLength = bof(5).length + boundSheet(0).length + sstRecords.length + eof().length;
    const workbook = [...bof(5), ...boundSheet(globalsLength), ...sstRecords, ...eof(), ...sheetRecords];
    // At or above the 4096-byte cutoff the stream lives in regular sectors, not the mini stream.
    const streamSectors = Math.max(8, Math.ceil(workbook.length / 512));
    const stream = [...workbook, ...zeros(streamSectors * 512 - workbook.length)];

    const END = 0xfffffffe;
    const FREE = 0xffffffff;
    const header = [
        0xd0,
        0xcf,
        0x11,
        0xe0,
        0xa1,
        0xb1,
        0x1a,
        0xe1,
        ...zeros(16),
        ...u16(0x3e),
        ...u16(3),
        ...u16(0xfffe),
        ...u16(9),
        ...u16(6),
        ...zeros(6),
        ...u32(0),
        ...u32(1),
        ...u32(1),
        ...u32(0),
        ...u32(4096),
        ...u32(END),
        ...u32(0),
        ...u32(END),
        ...u32(0),
        ...u32(0),
        ...zeros(108).flatMap(() => u32(FREE)),
    ];
    const fatEntries = [0xfffffffd, END];
    for (let i = 0; i < streamSectors; i++) fatEntries.push(i === streamSectors - 1 ? END : 3 + i);
    while (fatEntries.length < 128) fatEntries.push(FREE);
    const dirEntry = (name: string, type: number, start: number, size: number) => {
        const nameBytes = utf16(name);
        return [
            ...nameBytes,
            ...zeros(64 - nameBytes.length),
            ...u16((name.length + 1) * 2),
            type,
            1,
            ...u32(FREE),
            ...u32(FREE),
            ...u32(type === 5 ? 1 : FREE),
            ...zeros(36),
            ...u32(start),
            ...u32(size),
            ...u32(0),
        ];
    };
    const dir = [...dirEntry('Root Entry', 5, END, 0), ...dirEntry('Workbook', 2, 2, stream.length), ...zeros(256)];
    return Uint8Array.from([...header, ...fatEntries.flatMap(u32), ...dir, ...stream]);
}

// ── .xlsx: a stored (uncompressed) zip ──

function buildZip(files: Record<string, string>): Uint8Array {
    const enc = new TextEncoder();
    const local: number[] = [];
    const central: number[] = [];
    const names = Object.keys(files);
    for (const name of names) {
        const n = [...enc.encode(name)];
        const data = [...enc.encode(files[name])];
        const sizes = [...u32(0), ...u32(data.length), ...u32(data.length)];
        central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...sizes);
        central.push(
            ...u16(n.length),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u32(0),
            ...u32(local.length),
            ...n,
        );
        local.push(
            ...u32(0x04034b50),
            ...u16(20),
            ...u16(0),
            ...u16(0),
            ...u32(0),
            ...sizes,
            ...u16(n.length),
            ...u16(0),
            ...n,
            ...data,
        );
    }
    const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(names.length), ...u16(names.length)];
    return Uint8Array.from([...local, ...central, ...eocd, ...u32(central.length), ...u32(local.length), ...u16(0)]);
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XLSX_FILES = {
    '_rels/.rels': `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/sharedStrings.xml':
        '<sst><si><t>Status</t></si><si><r><t>Geb</t></r><r><t xml:space="preserve">ühr &amp; Co</t></r><rPh><t>x</t></rPh></si></sst>',
    'xl/worksheets/sheet1.xml':
        '<worksheet><dimension ref="A1:D3"/><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2"><v>12.5</v></c><c r="C2" t="inlineStr"><is><t>inline</t></is></c><c r="D2" t="b"><v>1</v></c></row>' +
        '<row r="3"><c r="B3" t="str"><v>a&lt;b</v></c><c r="C3" t="e"><v>#DIV/0!</v></c></row>' +
        '</sheetData></worksheet>',
};

export default async () => {
    await describe('Qonto export spreadsheet reader', async () => {
        await it('reads a BIFF8 .xls: shared strings split by CONTINUE, NUMBER, RK and MULRK cells', async () => {
            // "Gebühr" breaks after "Geb"; the CONTINUE restates the width and switches to UTF-16.
            const sstRecords = [
                ...rec(0x00fc, [
                    ...u32(2),
                    ...u32(2),
                    ...u16(6),
                    0,
                    ...latin1('Status'),
                    ...u16(6),
                    0,
                    ...latin1('Geb'),
                ]),
                ...rec(0x003c, [1, ...utf16('ühr')]),
            ];
            const sheet = [
                ...bof(0x10),
                ...dimensions(3, 5),
                ...labelSst(0, 0, 0),
                ...labelSst(0, 1, 1),
                ...number(1, 0, 12.5),
                ...rk(1, 2, (42 << 2) | 2),
                ...rk(1, 3, (1234 << 2) | 3),
                ...mulRk(2, 1, [(7 << 2) | 2, (-3 << 2) | 2]),
                ...eof(),
            ];
            const rows = readFirstSheet(buildXls(sstRecords, sheet));
            expect(rows).toHaveLength(3);
            expect(rows[0][0]).toBe('Status');
            expect(rows[0][1]).toBe('Gebühr');
            expect(rows[1][0]).toBe(12.5);
            expect(1 in rows[1]).toBe(false);
            expect(rows[1][2]).toBe(42);
            expect(rows[1][3]).toBe(12.34);
            expect(0 in rows[2]).toBe(false);
            expect(rows[2][1]).toBe(7);
            expect(rows[2][2]).toBe(-3);
        });

        await it('reads an .xlsx: rich-text shared strings, inline strings, booleans and errors', async () => {
            const rows = readFirstSheet(buildZip(XLSX_FILES));
            expect(rows).toHaveLength(3);
            expect(rows[0][0]).toBe('Status');
            expect(rows[0][1]).toBe('Gebühr & Co');
            expect(rows[1][0]).toBe(12.5);
            expect(rows[1][2]).toBe('inline');
            expect(rows[1][3]).toBe(true);
            expect(rows[2][1]).toBe('a<b');
            // Like SheetJS, an error cell other than #NULL! leaves a hole.
            expect(2 in rows[2]).toBe(false);
        });

        await it('rejects input that is not a spreadsheet', async () => {
            expect(() => readFirstSheet(new TextEncoder().encode('Datum;Betrag\n'))).toThrow(
                /not an \.xls or \.xlsx file/,
            );
        });

        await it('rejects a truncated .xls instead of reading past its end', async () => {
            const xls = buildXls(sst(['Status']), [...bof(0x10), ...dimensions(1, 1), ...labelSst(0, 0, 0), ...eof()]);
            expect(() => readFirstSheet(xls.subarray(0, 1024))).toThrow(/^Spreadsheet: /);
        });
    });

    await describe('Qonto export parser', async () => {
        await it('maps the columns of an .xls export to transactions, skipping the header row', async () => {
            const sheet = [
                ...bof(0x10),
                ...dimensions(2, 23),
                ...labelSst(0, 0, 0),
                ...labelSst(1, 0, 1),
                ...labelSst(1, 4, 2),
                ...number(1, 5, -10.6),
                ...labelSst(1, 22, 3),
                ...eof(),
            ];
            const xls = buildXls(sst(['Status', 'settled', '07-11-2025 12:35:14', 'ACME GmbH']), sheet);
            const dir = mkdtempSync(join(tmpdir(), 'qonto-export-'));
            try {
                const file = join(dir, 'export.xls');
                writeFileSync(file, xls);
                const txs = parseQontoExport(file);
                expect(txs).toHaveLength(1);
                expect(txs[0].status).toBe('settled');
                expect(txs[0].totalAmount).toBe(-10.6);
                expect(txs[0].debit).toBeNull();
                expect(txs[0].counterpartyName).toBe('ACME GmbH');
                expect(getTransactionDate(txs[0])).toBe('2025-11-07');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
};
