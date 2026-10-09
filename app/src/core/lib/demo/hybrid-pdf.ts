/**
 * A tiny hand-built hybrid PDF (ZUGFeRD / Factur-X style): one page of text plus an attached XML
 * file. Used by the demo seeder and by the tests; the bytes are valid enough for Poppler and for
 * `core/invoices/e-rechnung/pdf.ts`. Not a PDF/A-3 — it is a fixture generator, not a producer.
 */

import { deflateSync } from 'node:zlib';

export interface HybridPdfOptions {
    xml?: string;
    name?: string;
    compress?: boolean;
    /** Put the file specification into a compressed object stream. */
    objectStream?: boolean;
    /** Text printed on the page (the "text layer"). */
    text?: string;
}

/** A one-page PDF, optionally with an attached XML. */
export function buildHybridPdf(opts: HybridPdfOptions = {}): Uint8Array {
    const name = opts.name ?? 'factur-x.xml';
    const objects: Array<Uint8Array | string> = [];
    const hasXml = opts.xml !== undefined;
    const filespec = `<< /Type /Filespec /F (${name}) /UF (${name}) /EF << /F 6 0 R /UF 6 0 R >> >>`;
    const content = `BT /F1 12 Tf 50 700 Td (${opts.text ?? 'Rechnung'}) Tj ET`;
    objects[1] = `<< /Type /Catalog /Pages 2 0 R${hasXml ? ` /Names << /EmbeddedFiles << /Names [(${name}) 5 0 R] >> >>` : ''} >>`;
    objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objects[3] =
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>';
    objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    if (hasXml) {
        const raw = Buffer.from(opts.xml!, 'utf8');
        const body = opts.compress === false ? raw : Buffer.from(deflateSync(raw));
        const filter = opts.compress === false ? '' : ' /Filter /FlateDecode';
        objects[6] = Buffer.concat([
            Buffer.from(
                `<< /Type /EmbeddedFile /Subtype /text#2Fxml${filter} /Length ${body.length} >>\nstream\n`,
                'latin1',
            ),
            body,
            Buffer.from('\nendstream', 'latin1'),
        ]);
        if (opts.objectStream) {
            const inner = Buffer.from(`5 0\n${filespec}`, 'latin1');
            const packed = Buffer.from(deflateSync(inner));
            objects[7] = Buffer.concat([
                Buffer.from(
                    `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
                    'latin1',
                ),
                packed,
                Buffer.from('\nendstream', 'latin1'),
            ]);
        } else {
            objects[5] = filespec;
        }
    }
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
    const offsets: number[] = [];
    let pos = parts[0].length;
    for (let i = 1; i < objects.length; i++) {
        if (objects[i] === undefined) continue;
        offsets[i] = pos;
        const body =
            typeof objects[i] === 'string' ? Buffer.from(objects[i] as string, 'latin1') : (objects[i] as Buffer);
        const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
        parts.push(chunk);
        pos += chunk.length;
    }
    const size = objects.length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) {
        xref +=
            offsets[i] === undefined ? '0000000000 65535 f \n' : `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return new Uint8Array(Buffer.concat(parts));
}
