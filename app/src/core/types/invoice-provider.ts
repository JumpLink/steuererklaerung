/** Universal invoice provider types. Each source maps its API response to these shapes. */

/** A single invoice in a listing. */
export interface InvoiceListItem {
    /** Source-specific unique identifier (e.g. INWX invoiceId). */
    id: string;
    /** Invoice date as YYYY-MM-DD. */
    date: string;
    /** Gross amount (after tax). */
    amountGross: number;
    /** Net amount (before tax). */
    amountNet: number;
    /** Currency code (e.g. 'EUR'). */
    currency: string;
    /** Invoice type from the source (e.g. 'invoice', 'credit'). */
    type: string;
}

/** Result of downloading a single invoice. */
export interface InvoiceDownloadResult {
    id: string;
    /** PDF content as a Buffer. */
    pdf: Buffer;
    /** Suggested filename (e.g. "inwx-invoice-2026013856.pdf"). */
    filename: string;
    /** Structured metadata from the API (not from OCR/LLM). */
    metadata: InvoiceListItem;
}

/** Filter options for listing invoices. */
export interface InvoiceListFilter {
    /** Only invoices on or after this date (YYYY-MM-DD). */
    from?: string;
    /** Only invoices on or before this date (YYYY-MM-DD). */
    to?: string;
}

/** Interface that each invoice source provider must implement. */
export interface InvoiceProvider {
    /** Human-readable name for display (e.g. "INWX"). */
    readonly name: string;
    /** List invoices, optionally filtered by date range. */
    listInvoices(filter?: InvoiceListFilter): Promise<InvoiceListItem[]>;
    /** Download a single invoice PDF by its source-specific ID. */
    downloadInvoice(id: string): Promise<InvoiceDownloadResult>;
}
