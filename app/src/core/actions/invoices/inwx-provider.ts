/** INWX implementation of the InvoiceProvider interface. */

import { listInwxInvoices, getInwxInvoice } from '../../clients/inwx/index.ts';
import { isDateInRange } from '@steuererklaerung/shared';
import type {
    InvoiceProvider,
    InvoiceListItem,
    InvoiceDownloadResult,
    InvoiceListFilter,
} from '../../types/invoice-provider.ts';

/** Map a raw INWX invoice to the universal InvoiceListItem. */
function mapInvoice(inv: {
    invoiceId: number;
    date: string;
    afterTax: number;
    preTax: number;
    type: string;
    currency?: string;
}): InvoiceListItem {
    return {
        id: String(inv.invoiceId),
        date: inv.date,
        amountGross: inv.afterTax,
        amountNet: inv.preTax,
        currency: inv.currency ?? 'EUR',
        type: inv.type,
    };
}

export function createInwxProvider(): InvoiceProvider {
    // Cache the invoice list so downloadInvoice can include metadata without re-fetching
    let cachedInvoices: Map<string, InvoiceListItem> | null = null;

    return {
        name: 'INWX',

        async listInvoices(filter?: InvoiceListFilter): Promise<InvoiceListItem[]> {
            const response = await listInwxInvoices();
            const invoices = (response.invoice ?? []).map(mapInvoice);
            cachedInvoices = new Map(invoices.map((inv) => [inv.id, inv]));

            if (filter?.from || filter?.to) {
                return invoices.filter((inv) => isDateInRange(inv.date, filter?.from, filter?.to));
            }
            return invoices;
        },

        async downloadInvoice(id: string): Promise<InvoiceDownloadResult> {
            // Ensure we have metadata; if not cached, fetch the list
            if (!cachedInvoices) {
                const response = await listInwxInvoices();
                cachedInvoices = new Map(
                    (response.invoice ?? []).map((inv) => [String(inv.invoiceId), mapInvoice(inv)]),
                );
            }

            const invoiceId = parseInt(id, 10);
            const response = await getInwxInvoice(invoiceId);
            const pdf = Buffer.from(response.pdf, 'base64');

            const metadata = cachedInvoices.get(id) ?? {
                id,
                date: '',
                amountGross: 0,
                amountNet: 0,
                currency: 'EUR',
                type: 'invoice',
            };

            return {
                id,
                pdf,
                filename: `inwx-invoice-${id}.pdf`,
                metadata,
            };
        },
    };
}
