/**
 * Import Amazon "Tax Invoice" PDFs into Paperless, scoped business/private.
 *
 * The Amazon Business account is used for both business and private shopping, so
 * each receipt is scoped from its order's article categories (Computer & Zubehör
 * or the business phone case → business; everything else → private) and tagged via
 * the `data_scope` custom field. Business receipts document the EÜR expenses;
 * private ones land in the household file (private scope) — never in git. Reusable
 * each tax year. Run with `dryRun` first to preview the split.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    postDocument,
    bulkEditDocuments,
    listDocuments,
    waitForTaskResult,
    listCorrespondents,
    createCorrespondent,
} from '@steuererklaerung/paperless';
import { loadPaperlessConfig } from '../../config/index.ts';
import { parseAmazonOrderInfo, type AmazonOrderInfo } from '../../clients/amazon/parser.ts';

const ORDER_RE = /(\d{3}-\d{7}-\d{7})/;
const DATE_RE = /(\d{4})(\d{2})(\d{2})/;

type Scope = 'business' | 'private';

/** The owner's rule: Computer & Zubehör articles or the business phone (OnePlus) case → business. */
function scopeOf(info: AmazonOrderInfo | undefined): Scope {
    if (!info) return 'private';
    const business =
        info.categories.some((c) => c.toLowerCase() === 'computer & zubehör') ||
        info.titles.some((t) => /oneplus/i.test(t));
    return business ? 'business' : 'private';
}

async function resolveCorrespondentId(name: string): Promise<number> {
    const list = await listCorrespondents({ page_size: 500 });
    const found = list.results.find((c) => c.name.toLowerCase() === name.toLowerCase());
    return found ? found.id : (await createCorrespondent({ name })).id;
}

/** original_file_name → document id for every document already filed under this correspondent. */
async function fetchExistingByFilename(correspondentId: number): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (let page = 1; ; page++) {
        const res = await listDocuments({ correspondent_id: correspondentId, page_size: 100, page });
        for (const d of res.results) {
            if (d.original_file_name) map.set(d.original_file_name, d.id);
        }
        if (!res.next || res.results.length === 0) break;
    }
    return map;
}

interface ClassifiedReceipt {
    file: string;
    orderId: string;
    created?: string;
    scope: Scope;
}

export interface ImportAmazonReceiptsResult {
    dryRun: boolean;
    total: number;
    business: number;
    private: number;
    uploaded?: number;
    skipped?: number;
    scoped?: number;
    failed?: Array<{ file: string; error: string }>;
    sample?: Array<{ file: string; scope: Scope; orderId: string }>;
}

export async function importAmazonReceipts(opts: {
    docDir: string;
    csvPath: string;
    dryRun?: boolean;
    /** POST new files without waiting for OCR (fast); a later default run sets their scope. */
    uploadOnly?: boolean;
}): Promise<ImportAmazonReceiptsResult> {
    const orders = parseAmazonOrderInfo(opts.csvPath);
    const receipts: ClassifiedReceipt[] = readdirSync(opts.docDir)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .sort()
        .map((file) => {
            const orderId = ORDER_RE.exec(file)?.[1] ?? '';
            const dm = DATE_RE.exec(file);
            const created = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : undefined;
            return { file, orderId, created, scope: scopeOf(orders.get(orderId)) };
        });
    const business = receipts.filter((r) => r.scope === 'business').length;

    if (opts.dryRun) {
        return {
            dryRun: true,
            total: receipts.length,
            business,
            private: receipts.length - business,
            sample: receipts.map((r) => ({ file: r.file, scope: r.scope, orderId: r.orderId })),
        };
    }

    const config = loadPaperlessConfig();
    const correspondentId = await resolveCorrespondentId('Amazon');
    const documentType = config.document_type_ids.incoming_invoice || undefined;
    const scopeFieldId = config.custom_field_ids.data_scope;
    const invoiceFieldId = config.custom_field_ids.invoice_number;
    const scopeOptions = config.select_field_options['data_scope'] ?? {};
    const existing = await fetchExistingByFilename(correspondentId);

    let uploaded = 0;
    let skipped = 0;
    const failed: Array<{ file: string; error: string }> = [];
    // Collect document ids per scope so data_scope can be set in ONE bulk call per scope
    // (Paperless' bulk_edit takes an id list) instead of a slow per-document round-trip.
    const idsByScope: Record<Scope, number[]> = { business: [], private: [] };

    for (const r of receipts) {
        try {
            let documentId = existing.get(r.file);
            if (documentId == null) {
                const buffer = readFileSync(join(opts.docDir, r.file));
                // invoice_number is a plain text field — safe to set at upload time, so the
                // only post-upload write left is the batched data_scope.
                const customFields = invoiceFieldId && r.orderId ? { [invoiceFieldId]: r.orderId } : undefined;
                const taskId = await postDocument(buffer, r.file, {
                    title: `Amazon ${r.orderId}`,
                    created: r.created,
                    correspondent: correspondentId,
                    document_type: documentType,
                    custom_fields: customFields,
                });
                uploaded++;
                // Decoupled mode: don't block on Paperless OCR. The file consumes in the
                // background; a later default run skips it (now present) and batches its scope.
                if (opts.uploadOnly) continue;
                documentId = (await waitForTaskResult(taskId, { timeoutMs: 180_000 })).documentId;
            } else {
                skipped++;
            }
            idsByScope[r.scope].push(documentId);
        } catch (err) {
            failed.push({ file: r.file, error: err instanceof Error ? err.message : String(err) });
        }
    }

    // Batched data_scope: one bulk_edit per scope value (not per document).
    let scoped = 0;
    if (!opts.uploadOnly && scopeFieldId) {
        for (const scope of ['business', 'private'] as Scope[]) {
            const ids = idsByScope[scope];
            const optionId = scopeOptions[scope === 'business' ? 'geschäftlich' : 'privat'];
            if (ids.length > 0 && optionId) {
                await bulkEditDocuments(ids, 'modify_custom_fields', {
                    add_custom_fields: { [scopeFieldId]: optionId },
                    remove_custom_fields: [],
                });
                scoped += ids.length;
            }
        }
    }

    return {
        dryRun: false,
        total: receipts.length,
        business,
        private: receipts.length - business,
        uploaded,
        skipped,
        scoped,
        failed,
    };
}
