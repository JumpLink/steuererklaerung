/**
 * Read an incoming e-invoice file (XRechnung XML or ZUGFeRD/Factur-X PDF) from disk — the action
 * behind `invoices e-rechnung lesen` and the MCP tool `invoices_e_rechnung_lesen`. No AI, no network.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { extractPdfText } from '@steuererklaerung/dms';
import { MAX_RECEIPT_BYTES } from '../documents.ts';
import { readEInvoice, type EInvoiceReading } from '../../invoices/e-rechnung/index.ts';

export interface EInvoiceFileReading extends EInvoiceReading {
    file: string;
    sizeBytes: number;
}

/** Throws a German message when the file is missing, not a file, or larger than any receipt may be. */
export function readEInvoiceFile(path: string): EInvoiceFileReading {
    if (!existsSync(path)) throw new Error(`Datei nicht gefunden: ${path}`);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Keine reguläre Datei: ${path}`);
    if (stat.size > MAX_RECEIPT_BYTES) {
        throw new Error(`Datei zu groß (max. ${Math.round(MAX_RECEIPT_BYTES / (1024 * 1024))} MB).`);
    }
    const reading = readEInvoice(readFileSync(path), { pdfText: extractPdfText });
    return { file: basename(path), sizeBytes: stat.size, ...reading };
}
