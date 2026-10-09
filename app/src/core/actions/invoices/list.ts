/** List invoices from a provider. */

import type { InvoiceProvider, InvoiceListItem, InvoiceListFilter } from '../../types/invoice-provider.ts';

export interface ListInvoicesResult {
    source: string;
    count: number;
    invoices: InvoiceListItem[];
}

export async function listProviderInvoices(
    provider: InvoiceProvider,
    filter?: InvoiceListFilter,
): Promise<ListInvoicesResult> {
    const invoices = await provider.listInvoices(filter);
    return { source: provider.name, count: invoices.length, invoices };
}
