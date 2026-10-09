/**
 * Which parts of a received mail are receipts (Idee 15): PDF files and e-invoice XML — nothing else.
 *
 * The test is positive, not a list of things to ignore: a part qualifies by being a PDF or an XML
 * data set that reads as an e-invoice, so an inline logo, a signature (`smime.p7s`, `.asc`), a
 * calendar entry or a vCard never qualifies, whatever their disposition says. A mail's own XML that
 * is NOT an invoice (a sitemap, a DATEV export) is left alone for the same reason.
 *
 * Pure: the e-invoice check is the reader of Idee 2, handed the bytes.
 */

import { readEInvoice } from '../invoices/e-rechnung/index.ts';
import type { MimePart } from './mime.ts';

export interface MailAttachment {
    /** A safe file name for the DMS: no path, no control characters, the right extension. */
    filename: string;
    mimeType: 'application/pdf' | 'application/xml';
    bytes: Uint8Array;
}

/** Media types that mean "some file" and so are decided by the extension instead. */
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-download']);

function extensionOf(name: string | null): string | null {
    return /\.([A-Za-z0-9]{1,8})$/.exec(name ?? '')?.[1].toLowerCase() ?? null;
}

function kindOf(part: MimePart): 'pdf' | 'xml' | null {
    const ext = extensionOf(part.filename);
    if (part.type === 'application/pdf' || part.type === 'application/x-pdf') return 'pdf';
    if (part.type === 'application/xml' || part.type === 'text/xml') return 'xml';
    if (GENERIC_TYPES.has(part.type)) return ext === 'pdf' ? 'pdf' : ext === 'xml' ? 'xml' : null;
    return null;
}

/** The file name without directory parts or control characters; the extension follows the content. */
export function safeFilename(name: string | null, fallbackBase: string, ext: 'pdf' | 'xml'): string {
    const base = (name ?? '')
        .split(/[\\/]/)
        .pop()!
        .split('')
        .filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim();
    const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
    return `${stem || fallbackBase}.${ext}`;
}

/**
 * The receipts among a message's parts, in message order. `fallbackBase` names a file that came
 * without a usable name (`mail-4711`). Empty parts and e-invoice-less XML are skipped.
 */
export function selectAttachments(parts: readonly MimePart[], fallbackBase: string): MailAttachment[] {
    const out: MailAttachment[] = [];
    let n = 0;
    for (const part of parts) {
        const kind = kindOf(part);
        if (!kind || part.body.length === 0) continue;
        if (kind === 'xml' && !readEInvoice(part.body).invoice) continue;
        n++;
        out.push({
            filename: safeFilename(part.filename, n === 1 ? fallbackBase : `${fallbackBase}-${n}`, kind),
            mimeType: kind === 'pdf' ? 'application/pdf' : 'application/xml',
            bytes: part.body,
        });
    }
    return out;
}
