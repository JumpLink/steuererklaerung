/**
 * Cross-system MCP tools.
 * Match transactions to documents, push documents between systems, reconciliation.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import {
    getDocument,
    updateDocument,
    downloadDocument,
    listDocuments,
    type Document,
    getCustomFieldValue,
    hasSyncField,
    mergeCustomFields,
} from '@steuererklaerung/paperless';
import {
    getTransaction as getQontoTransaction,
    listTransactions as listQontoTransactions,
    getDefaultBankAccountId,
    uploadAttachmentToTransaction,
} from '../../../core/clients/qonto/index.ts';
import { fetchPagesUntil } from '@steuererklaerung/paperless';
import { parseDocumentCustomFields, mcpError, mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerCrossSystemTools(server: McpServer, ctx: AppContext): void {
    const config = ctx.config;
    const cf = config.custom_field_ids;

    // ── match_transaction_to_document ───────────────────────────────────

    server.registerTool(
        'match_transaction_to_document',
        {
            title: 'Match Qonto Transaction to Paperless Document',
            description:
                'Link a Qonto bank transaction to a Paperless document. Sets Qonto metadata (transaction_id, amount, currency, settled_at, label, reference) as custom fields on the Paperless document.',
            inputSchema: {
                qonto_transaction_id: z.string().describe('Qonto transaction ID'),
                paperless_document_id: z.number().describe('Paperless document ID'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ qonto_transaction_id, paperless_document_id }) => {
            try {
                const [transaction, doc] = await Promise.all([
                    getQontoTransaction(qonto_transaction_id),
                    getDocument(paperless_document_id),
                ]);

                // Build custom field updates from Qonto transaction data
                const updates: Record<number, unknown> = {};
                if (cf.qonto_transaction_id > 0) updates[cf.qonto_transaction_id] = transaction.id;
                if (cf.qonto_transaction_amount > 0) {
                    // Field is float type — send as number, not monetary string
                    updates[cf.qonto_transaction_amount] = transaction.amount_cents / 100;
                }
                if (cf.qonto_currency > 0) updates[cf.qonto_currency] = transaction.currency;
                if (cf.qonto_settled_at > 0 && transaction.settled_at) {
                    updates[cf.qonto_settled_at] = transaction.settled_at.slice(0, 10);
                }
                if (cf.qonto_label > 0 && transaction.label) updates[cf.qonto_label] = transaction.label;
                if (cf.qonto_reference > 0 && transaction.reference)
                    updates[cf.qonto_reference] = transaction.reference;
                if (cf.qonto_vat_amount > 0 && transaction.vat_amount != null) {
                    updates[cf.qonto_vat_amount] = `${transaction.currency}${transaction.vat_amount.toFixed(2)}`;
                }
                if (cf.qonto_category > 0 && transaction.category) updates[cf.qonto_category] = transaction.category;

                // Merge with existing custom fields
                const updateEntries = Object.entries(updates).map(([k, v]) => ({ field: Number(k), value: v }));
                const merged = mergeCustomFields(doc.custom_fields ?? [], updateEntries);

                const updated = await updateDocument(paperless_document_id, { custom_fields: merged });
                const parsed = parseDocumentCustomFields(updated, config);

                return mcpSuccess({
                    message: `Matched Qonto transaction ${transaction.id} to Paperless document ${doc.id}`,
                    transaction: {
                        id: transaction.id,
                        amount: transaction.amount_cents / 100,
                        currency: transaction.currency,
                        label: transaction.label,
                    },
                    document: {
                        id: updated.id,
                        title: updated.title,
                        custom_fields: parsed,
                    },
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── push_document_to_qonto ──────────────────────────────────────────

    server.registerTool(
        'push_document_to_qonto',
        {
            title: 'Push Document to Qonto',
            description:
                'Download a Paperless document and upload it as a receipt/attachment to the linked Qonto transaction. Sets qonto_attachment_id in Paperless.',
            inputSchema: {
                paperless_document_id: z.number().describe('Paperless document ID'),
                qonto_transaction_id: z
                    .string()
                    .optional()
                    .describe(
                        'Qonto transaction ID. If omitted, uses the qonto_transaction_id custom field from the document.',
                    ),
                dry_run: z.boolean().default(false).describe('If true, only check what would happen'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async ({ paperless_document_id, qonto_transaction_id, dry_run }) => {
            try {
                const doc = await getDocument(paperless_document_id);

                // Check if already uploaded
                if (hasSyncField(doc, cf.qonto_attachment_id)) {
                    const existingId = getCustomFieldValue(doc, cf.qonto_attachment_id);
                    return mcpSuccess({
                        message: `Document ${doc.id} already has Qonto attachment (${existingId})`,
                        skipped: true,
                    });
                }

                // Resolve Qonto transaction ID
                const txId =
                    qonto_transaction_id || (getCustomFieldValue(doc, cf.qonto_transaction_id) as string | undefined);
                if (!txId) {
                    return mcpError(
                        `Document ${doc.id} has no qonto_transaction_id. Provide qonto_transaction_id manually or match the transaction first.`,
                    );
                }

                if (dry_run) {
                    return mcpSuccess({
                        message: `Would upload document ${doc.id} to Qonto transaction ${txId}`,
                        dry_run: true,
                    });
                }

                // Download from Paperless
                const fileBuffer = await downloadDocument(paperless_document_id);
                const filename = doc.original_file_name ?? `document-${doc.id}.pdf`;
                const mimeType = doc.mime_type ?? 'application/pdf';

                // Upload to Qonto (returns unknown — Qonto API may return empty body on success)
                const result = await uploadAttachmentToTransaction(txId, fileBuffer, filename, mimeType);
                const attachmentId =
                    result && typeof result === 'object' && 'id' in result
                        ? (result as Record<string, unknown>).id
                        : null;

                // Update Paperless with qonto_attachment_id (use transaction ID as fallback reference)
                if (cf.qonto_attachment_id > 0) {
                    const refId = attachmentId ?? txId;
                    const merged = mergeCustomFields(doc.custom_fields ?? [], [
                        { field: cf.qonto_attachment_id, value: refId },
                    ]);
                    await updateDocument(paperless_document_id, { custom_fields: merged });
                }

                return mcpSuccess({
                    message: `Uploaded document ${doc.id} to Qonto transaction ${txId}`,
                    qonto_attachment_id: attachmentId ?? txId,
                    qonto_transaction_id: txId,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── get_reconciliation_status ───────────────────────────────────────

    server.registerTool(
        'get_reconciliation_status',
        {
            title: 'Reconciliation Status',
            description:
                'Cross-system reconciliation overview for a given month: matched/unmatched transactions across Qonto and Paperless.',
            inputSchema: {
                month: z.string().describe('Month in YYYY-MM format'),
                bank_account_id: z.string().optional().describe('Qonto bank account ID (uses default if omitted)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ month, bank_account_id }) => {
            try {
                // Compute date range for the month
                const [year, mon] = month.split('-').map(Number);
                const dateFrom = `${year}-${String(mon).padStart(2, '0')}-01`;
                const lastDay = new Date(year, mon, 0).getDate();
                const dateTo = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

                const bankAccountId = bank_account_id || getDefaultBankAccountId() || undefined;

                const qontoTxs = bankAccountId
                    ? await listQontoTransactions({
                          bankAccountId,
                          settled_at_from: dateFrom,
                          settled_at_to: `${dateTo}T23:59:59Z`,
                      })
                    : [];

                // Fetch Paperless documents with invoice types, filtering by date in-memory
                // Use fetchPagesUntil to avoid loading the entire document history
                const typeIds = [
                    config.document_type_ids.incoming_invoice,
                    config.document_type_ids.outgoing_invoice,
                ].filter((id) => id > 0);
                const isInMonth = (doc: Document): boolean => {
                    const settledAt = getCustomFieldValue(doc, cf.qonto_settled_at) as string | undefined;
                    const date = settledAt?.slice(0, 10) ?? doc.created?.slice(0, 10);
                    if (!date) return false;
                    return date >= dateFrom && date <= dateTo;
                };
                let paperlessDocs: Document[] = [];
                for (const typeId of typeIds) {
                    const docs = await fetchPagesUntil(
                        (page, pageSize) =>
                            listDocuments({
                                document_type_id: typeId,
                                page,
                                page_size: pageSize,
                                ordering: '-created',
                            }),
                        isInMonth,
                        500,
                    );
                    paperlessDocs.push(...docs);
                }

                // Cross-reference
                const paperlessWithQonto = paperlessDocs.filter((d) => hasSyncField(d, cf.qonto_transaction_id));

                const qontoTxIds = new Set(qontoTxs.map((t) => t.id));
                const paperlessQontoIds = new Set(
                    paperlessWithQonto
                        .map((d) => {
                            // Support comma-separated IDs (Sammelrechnungen)
                            const raw = getCustomFieldValue(d, cf.qonto_transaction_id) as string;
                            return raw ? raw.split(',').map((s) => s.trim()) : [];
                        })
                        .flat()
                        .filter(Boolean),
                );
                const qontoMatchedCount = [...qontoTxIds].filter((id) => paperlessQontoIds.has(id)).length;

                // Identify Qonto transactions that don't need a receipt
                const noReceiptLabels = ['Qonto', 'OLINDA SAS'];
                const noReceiptCategories = ['fees'];
                const noReceiptReferences = [
                    'Privatentnahme',
                    'Rueckueberweisung',
                    'Restguthaben',
                    'Uebertrag',
                    'Qonto Aufladung',
                ];
                const qontoNoReceipt = qontoTxs.filter((t) => {
                    if (paperlessQontoIds.has(t.id)) return false; // already matched
                    if (t.category && noReceiptCategories.includes(t.category)) return true;
                    if (t.label && noReceiptLabels.some((l) => t.label?.startsWith(l))) return true;
                    if (t.reference && noReceiptReferences.some((r) => t.reference?.includes(r))) return true;
                    return false;
                }).length;

                return mcpSuccess({
                    month,
                    qonto: {
                        total: qontoTxs.length,
                        matched_to_paperless: qontoMatchedCount,
                        no_receipt_needed: qontoNoReceipt,
                        receipt_missing: qontoTxs.length - qontoMatchedCount - qontoNoReceipt,
                    },
                    paperless: {
                        total: paperlessDocs.length,
                        with_qonto_match: paperlessWithQonto.length,
                        without_qonto_match: paperlessDocs.length - paperlessWithQonto.length,
                    },
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
