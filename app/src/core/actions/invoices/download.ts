/** Download invoice PDFs from a provider to local disk. */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../lib/logger.ts';
import type { InvoiceProvider, InvoiceListFilter } from '../../types/invoice-provider.ts';

const log = getLogger('invoices-download');

export interface DownloadInvoicesOptions {
    filter?: InvoiceListFilter;
    /** Output directory (default: cwd/invoices/<source>). */
    outputDir?: string;
    /** If set, only download these invoice IDs (skip listing). */
    ids?: string[];
}

export interface DownloadInvoiceDetail {
    id: string;
    filename: string;
    path: string;
    sizeBytes: number;
}

export interface DownloadInvoicesResult {
    source: string;
    downloaded: number;
    errors: number;
    details: DownloadInvoiceDetail[];
}

export async function downloadProviderInvoices(
    provider: InvoiceProvider,
    options: DownloadInvoicesOptions = {},
): Promise<DownloadInvoicesResult> {
    const outputDir = options.outputDir ?? join(process.cwd(), 'invoices', provider.name.toLowerCase());
    mkdirSync(outputDir, { recursive: true });

    let ids: string[];
    if (options.ids && options.ids.length > 0) {
        ids = options.ids;
    } else {
        const invoices = await provider.listInvoices(options.filter);
        ids = invoices.map((inv) => inv.id);
    }

    const details: DownloadInvoiceDetail[] = [];
    let errors = 0;

    for (const id of ids) {
        try {
            const result = await provider.downloadInvoice(id);
            const filePath = join(outputDir, result.filename);
            writeFileSync(filePath, result.pdf);
            details.push({ id, filename: result.filename, path: filePath, sizeBytes: result.pdf.length });
            log.info(`Downloaded ${result.filename} (${result.pdf.length} bytes)`);
        } catch (err) {
            errors++;
            log.error(`Failed to download invoice ${id}`, err);
            console.error(`Error downloading invoice ${id}: ${err instanceof Error ? err.message : err}`);
        }
    }

    return { source: provider.name, downloaded: details.length, errors, details };
}
