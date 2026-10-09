/** INWX API - Invoice operations. */

import { callApi } from './request.ts';
import type { InwxListInvoicesResponse, InwxGetInvoiceResponse } from './types.ts';

/** List all invoices from INWX account. */
export async function listInwxInvoices(): Promise<InwxListInvoicesResponse> {
    return callApi<InwxListInvoicesResponse>('accounting.listInvoices', {});
}

/** Download a single invoice PDF by invoiceId. Returns base64-encoded PDF. */
export async function getInwxInvoice(invoiceId: number): Promise<InwxGetInvoiceResponse> {
    return callApi<InwxGetInvoiceResponse>('accounting.getInvoice', { invoiceId });
}
