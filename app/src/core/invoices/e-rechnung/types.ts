/**
 * Normalised shape of an incoming e-invoice (EN 16931), independent of the syntax it arrived in
 * (UN/CEFACT CII or OASIS UBL). Amounts are numbers in the invoice currency exactly as written in
 * the file — a credit note keeps its positive amounts and says so in {@link EInvoice.documentKind}.
 */

export interface EInvoiceParty {
    name: string | null;
    /** USt-IdNr. (schemeID "VA" in CII, TaxScheme "VAT" in UBL). */
    vatId: string | null;
    /** Steuernummer (schemeID "FC" in CII, any other TaxScheme in UBL). */
    taxNumber: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
    /** ISO 3166-1 alpha-2. */
    country: string | null;
    email: string | null;
    /** Payee account, filled for the seller only (BT-84). */
    iban: string | null;
}

export interface EInvoiceLine {
    id: string | null;
    description: string | null;
    quantity: number | null;
    unit: string | null;
    unitPriceNet: number | null;
    net: number | null;
    vatRate: number | null;
    vatCategory: string | null;
}

export interface EInvoiceVat {
    category: string | null;
    /** Percent, e.g. 19. */
    rate: number | null;
    basis: number | null;
    amount: number | null;
}

export interface EInvoiceTotals {
    net: number | null;
    vat: number | null;
    gross: number | null;
    prepaid: number | null;
    due: number | null;
}

export interface EInvoice {
    syntax: 'cii' | 'ubl';
    /** Credit notes (TypeCode 381 and relatives, or a UBL CreditNote root) are recognised here. */
    documentKind: 'invoice' | 'credit-note';
    /** UNTDID 1001 code as written (BT-3), e.g. "380". */
    typeCode: string | null;
    /** CustomizationID / GuidelineSpecifiedDocumentContextParameter (BT-24). */
    guidelineId: string | null;
    /** UBL ProfileID (BT-23) — the Peppol process, not the format. */
    profileId: string | null;
    number: string | null;
    issueDate: string | null;
    dueDate: string | null;
    paymentTerms: string | null;
    currency: string | null;
    buyerReference: string | null;
    /** BT-25 / BG-3: the invoice a credit note refers to. */
    precedingNumber: string | null;
    servicePeriodStart: string | null;
    servicePeriodEnd: string | null;
    seller: EInvoiceParty;
    buyer: EInvoiceParty;
    lines: EInvoiceLine[];
    vat: EInvoiceVat[];
    totals: EInvoiceTotals;
}

export type InvoiceKind = 'e-rechnung' | 'sonstige-rechnung';

export type InvoiceFormat =
    | 'xrechnung'
    | 'zugferd'
    | 'en16931'
    | 'zugferd-1'
    | 'ohne-datensatz'
    | 'unbekannt'
    | 'fehler';

export interface EInvoiceClassification {
    kind: InvoiceKind;
    format: InvoiceFormat;
    /** The ZUGFeRD/Factur-X profile when the guideline names one, e.g. "MINIMUM", "EN 16931". */
    profile: string | null;
    /** One German sentence for the person looking at the document. */
    reason: string;
}

export interface EInvoiceReading {
    /** What the bytes were: a bare XML file, a PDF, or something else (scan, image). */
    source: 'xml' | 'pdf' | 'sonstiges';
    /** Null when there is no readable data set (plain PDF, scan, ZUGFeRD 1.x, broken XML). */
    invoice: EInvoice | null;
    classification: EInvoiceClassification;
    /** Name of the XML attached to a hybrid PDF. */
    embeddedName: string | null;
    /** Plausibility notes, German. Never fatal. */
    warnings: string[];
    /** Set when a data set was present but could not be read. */
    error: string | null;
}

/** A German, user-presentable failure while reading an e-invoice. */
export class EInvoiceError extends Error {
    constructor(
        message: string,
        readonly code: 'xml' | 'format' | 'zugferd-1' | 'pdf' | 'encrypted' = 'format',
    ) {
        super(message);
        this.name = 'EInvoiceError';
    }
}
