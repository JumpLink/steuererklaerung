/** INWX API response types derived from accounting.* methods. */

/** Raw invoice from accounting.listInvoices response. */
export interface InwxRawInvoice {
    invoiceId: number;
    date: string;
    afterTax: number;
    preTax: number;
    type: string;
    currency?: string;
}

/** Raw response from accounting.listInvoices. */
export interface InwxListInvoicesResponse {
    count: number;
    invoice: InwxRawInvoice[];
}

/** Raw response from accounting.getInvoice. */
export interface InwxGetInvoiceResponse {
    pdf: string; // base64-encoded PDF
}
