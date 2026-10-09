/**
 * Read an incoming invoice file as an e-invoice: a bare XRechnung XML, or a hybrid PDF
 * (ZUGFeRD / Factur-X) with the XML attached. The ONE entry point the import paths, the CLI and
 * the MCP tool share; it never throws — a broken data set becomes `error` + a classification.
 *
 * Hybrid PDFs: the XML wins (tax-sources.md, "Hybride Formate": the structured part is decisive).
 * When a text extractor is supplied, the PDF's own text is compared with the XML and a difference
 * in gross or VAT becomes a warning.
 */

import { classifyBroken, classifyGuideline, classifyInvoice, classifyWithoutDataSet } from './classify.ts';
import { extractEmbeddedXml } from './pdf.ts';
import { decodeXml, eInvoiceWarnings, parseEInvoiceXml } from './xml.ts';
import { EInvoiceError, type EInvoice, type EInvoiceReading } from './types.ts';

export interface ReadEInvoiceOptions {
    /** Text layer of a PDF (e.g. Poppler); omit where none is available. */
    pdfText?: (pdf: Uint8Array) => string | null;
}

function sniff(bytes: Uint8Array): 'pdf' | 'xml' | 'other' {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
    if (head.includes('%PDF-')) return 'pdf';
    if (/^(?:\xEF\xBB\xBF)?\s*</.test(head)) return 'xml';
    return 'other';
}

/** Amounts as the PDF prints them ("1.234,56", "1234.56") → integer cents. */
function amountsInText(text: string): Set<number> {
    const out = new Set<number>();
    for (const m of text.matchAll(/\d{1,3}(?:[. ]\d{3})*[.,]\d{2}\b|\d+[.,]\d{2}\b/g)) {
        const s = m[0].replace(/[. ](?=\d{3}\b)/g, '').replace(',', '.');
        const v = Number(s);
        if (Number.isFinite(v)) out.add(Math.round(v * 100));
    }
    return out;
}

/**
 * Compare the PDF's text layer with the XML. A figure that the XML states but the PDF never prints
 * is the signal — checking "is this number somewhere on the page" keeps it free of layout guesses.
 * Silent when the PDF has no readable amounts at all (a scan inside a PDF/A, an empty text layer).
 */
export function comparePdfText(inv: EInvoice, text: string): string[] {
    const found = amountsInText(text);
    if (found.size === 0) return [];
    const warnings: string[] = [];
    const check = (label: string, value: number | null): void => {
        if (value == null || value === 0) return;
        if (!found.has(Math.round(Math.abs(value) * 100))) {
            warnings.push(
                `${label} laut XML (${Math.abs(value).toFixed(2).replace('.', ',')}) steht nicht im PDF-Text — das XML gilt, bitte prüfen.`,
            );
        }
    };
    check('Bruttobetrag', inv.totals.gross);
    check('USt-Betrag', inv.totals.vat);
    return warnings;
}

function fromXml(
    bytes: Uint8Array,
    hybrid: boolean,
    embeddedName: string | null,
    pdf: Uint8Array | null,
    opts: ReadEInvoiceOptions,
): EInvoiceReading {
    const source = hybrid ? 'pdf' : 'xml';
    try {
        const invoice = parseEInvoiceXml(decodeXml(bytes));
        const warnings = eInvoiceWarnings(invoice);
        if (pdf && opts.pdfText) {
            const text = opts.pdfText(pdf);
            if (text) warnings.push(...comparePdfText(invoice, text));
        }
        return {
            source,
            invoice,
            classification: classifyInvoice(invoice, hybrid),
            embeddedName,
            warnings,
            error: null,
        };
    } catch (err) {
        if (!(err instanceof EInvoiceError)) throw err;
        if (err.code === 'zugferd-1') {
            return {
                source,
                invoice: null,
                classification: classifyGuideline('urn:ferd:', hybrid),
                embeddedName,
                warnings: [],
                error: null,
            };
        }
        // An unrelated XML attached to a PDF is no data set; a damaged invoice XML is an error.
        if (hybrid && err.code === 'format') {
            return {
                source,
                invoice: null,
                classification: classifyWithoutDataSet(true),
                embeddedName,
                warnings: [`Der Anhang „${embeddedName}“ ist keine Rechnung: ${err.message}`],
                error: null,
            };
        }
        return {
            source,
            invoice: null,
            classification: classifyBroken(err.message),
            embeddedName,
            warnings: [],
            error: err.message,
        };
    }
}

/** Read `bytes` as an e-invoice. Never throws. */
export function readEInvoice(bytes: Uint8Array, opts: ReadEInvoiceOptions = {}): EInvoiceReading {
    const kind = sniff(bytes);
    if (kind === 'xml') return fromXml(bytes, false, null, null, opts);
    if (kind === 'other') {
        return {
            source: 'sonstiges',
            invoice: null,
            classification: classifyWithoutDataSet(false),
            embeddedName: null,
            warnings: [],
            error: null,
        };
    }
    try {
        const embedded = extractEmbeddedXml(bytes);
        if (!embedded) {
            return {
                source: 'pdf',
                invoice: null,
                classification: classifyWithoutDataSet(true),
                embeddedName: null,
                warnings: [],
                error: null,
            };
        }
        return fromXml(embedded.bytes, true, embedded.name, bytes, opts);
    } catch (err) {
        if (!(err instanceof EInvoiceError)) throw err;
        return {
            source: 'pdf',
            invoice: null,
            classification: classifyBroken(err.message),
            embeddedName: null,
            warnings: [],
            error: err.message,
        };
    }
}
