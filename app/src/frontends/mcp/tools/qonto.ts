/**
 * Qonto MCP tools.
 * Search transactions, get transaction details, account summary.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import {
    getOrganization,
    listTransactions,
    getTransaction,
    listTransactionAttachments,
    getDefaultBankAccountId,
} from '../../../core/clients/qonto/index.ts';
import type { CreateClientBody, InvoiceSpec } from '../../../core/clients/qonto/index.ts';
import { createOutgoingInvoiceDraft } from '../../../core/actions/outgoing-invoices.ts';
import { mcpError, mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerQontoTools(server: McpServer, _ctx: AppContext): void {
    // ── qonto_search_transactions ───────────────────────────────────────

    server.registerTool(
        'qonto_search_transactions',
        {
            title: 'Search Qonto Transactions',
            description: 'Search Qonto bank transactions by date range, side (credit/debit), and attachment status.',
            inputSchema: {
                settled_at_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
                settled_at_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
                side: z.enum(['credit', 'debit']).optional().describe('Filter by credit or debit'),
                with_attachments: z.boolean().optional().describe('Filter by whether attachments are present'),
                bank_account_id: z.string().optional().describe('Bank account ID (uses default if omitted)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                const bankAccountId = params.bank_account_id || getDefaultBankAccountId() || undefined;
                if (!bankAccountId)
                    return mcpError('No bank_account_id provided and QONTO_DEFAULT_BANK_ACCOUNT_ID not set');

                const transactions = await listTransactions({
                    bankAccountId,
                    settled_at_from: params.settled_at_from,
                    settled_at_to: params.settled_at_to,
                    side: params.side,
                    with_attachments: params.with_attachments,
                });

                return mcpSuccess({
                    count: transactions.length,
                    transactions: transactions.map((t) => ({
                        id: t.id,
                        amount: t.amount_cents / 100,
                        currency: t.currency,
                        side: t.side,
                        label: t.label,
                        reference: t.reference,
                        settled_at: t.settled_at,
                        emitted_at: t.emitted_at,
                        status: t.status,
                        category: t.category,
                        vat_rate: t.vat_rate,
                        has_attachments: (t.attachment_ids?.length ?? 0) > 0,
                        attachment_count: t.attachment_ids?.length ?? 0,
                    })),
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── qonto_get_transaction ───────────────────────────────────────────

    server.registerTool(
        'qonto_get_transaction',
        {
            title: 'Get Qonto Transaction',
            description: 'Get a single Qonto transaction with full details and attachment metadata.',
            inputSchema: {
                transaction_id: z.string().describe('Qonto transaction ID'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ transaction_id }) => {
            try {
                const t = await getTransaction(transaction_id);

                let attachments: unknown[] = [];
                if (t.attachment_ids?.length) {
                    try {
                        attachments = await listTransactionAttachments(transaction_id);
                    } catch {
                        // Attachment listing may fail — return transaction anyway
                    }
                }

                return mcpSuccess({
                    id: t.id,
                    amount: t.amount_cents / 100,
                    currency: t.currency,
                    side: t.side,
                    operation_type: t.operation_type,
                    label: t.label,
                    note: t.note,
                    reference: t.reference,
                    settled_at: t.settled_at,
                    emitted_at: t.emitted_at,
                    updated_at: t.updated_at,
                    status: t.status,
                    category: t.category,
                    vat_amount: t.vat_amount,
                    vat_rate: t.vat_rate,
                    attachment_ids: t.attachment_ids ?? [],
                    attachments,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── qonto_get_account_summary ───────────────────────────────────────

    server.registerTool(
        'qonto_get_account_summary',
        {
            title: 'Qonto Account Summary',
            description: 'Get organization info and bank account balances.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                const orgData = await getOrganization();
                const org = orgData.organization;
                return mcpSuccess({
                    slug: org.slug,
                    legal_name: org.legal_name,
                    bank_accounts: (org.bank_accounts ?? []).map((a) => ({
                        id: a.id,
                        name: a.name,
                        iban: a.iban,
                        balance: a.balance_cents != null ? a.balance_cents / 100 : null,
                        currency: a.balance_currency,
                        status: a.status,
                    })),
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── create_outgoing_invoice_draft (write — gated by mcp.allowWrite) ──

    server.registerTool(
        'create_outgoing_invoice_draft',
        {
            title: 'Create Outgoing Invoice Draft',
            description:
                "Create a DRAFT outgoing (customer) invoice via the entity's configured invoicing back-end (Qonto today). Never sends — a human reviews and sends it. The Qonto back-end finds-or-creates the customer by name. Use dry_run to preview the resolved payload and any validation problems without creating anything.",
            inputSchema: {
                entity: z
                    .string()
                    .optional()
                    .describe('Entity id whose invoicing back-end applies (default: the workspace Qonto config)'),
                client: z
                    .object({
                        kind: z
                            .enum(['company', 'individual', 'freelancer'])
                            .optional()
                            .describe('Customer kind (default: company)'),
                        name: z.string().optional().describe('Company name (or use first_name + last_name)'),
                        first_name: z.string().optional(),
                        last_name: z.string().optional(),
                        email: z.string().optional(),
                        currency: z.string().optional().describe('Customer currency (e.g. EUR)'),
                        locale: z.string().optional().describe('Customer locale (e.g. de)'),
                    })
                    .describe('Customer to bill — matched or created by name (Qonto back-end)'),
                invoice: z
                    .object({
                        issue_date: z.string().describe('Issue date (YYYY-MM-DD)'),
                        due_date: z
                            .string()
                            .optional()
                            .describe('Due date (YYYY-MM-DD); else issue_date + payment_terms_days'),
                        payment_terms_days: z
                            .number()
                            .int()
                            .positive()
                            .optional()
                            .describe('Payment term in days (default 15)'),
                        currency: z.string().optional().describe('Invoice currency (default EUR)'),
                        iban: z.string().optional().describe('Own IBAN the customer pays to (default from entity/env)'),
                        status: z.enum(['draft', 'unpaid']).optional().describe('Lifecycle (default draft)'),
                        number: z.string().optional().describe('Explicit number (only if auto-numbering is off)'),
                        header: z.string().optional(),
                        footer: z.string().optional(),
                        performance_start_date: z.string().optional().describe('Leistungszeitraum start (YYYY-MM-DD)'),
                        performance_end_date: z.string().optional().describe('Leistungszeitraum end (YYYY-MM-DD)'),
                        items: z
                            .array(
                                z.object({
                                    title: z.string().describe('Line-item title (Qonto: ≤ 40 chars)'),
                                    description: z.string().optional(),
                                    quantity: z.union([z.string(), z.number()]).describe('Quantity, e.g. 3 or "0.5"'),
                                    unit: z.string().optional().describe('Unit, e.g. "Std"'),
                                    unit_price: z
                                        .union([z.string(), z.number()])
                                        .describe('Net unit price, e.g. 100 or "100.00"'),
                                    vat_rate: z
                                        .union([z.string(), z.number()])
                                        .describe('VAT: percent (19) or decimal ("0.19")'),
                                }),
                            )
                            .min(1)
                            .describe('At least one line item'),
                    })
                    .describe('Invoice content'),
                dry_run: z
                    .boolean()
                    .optional()
                    .describe('Preview the resolved payload + validation problems without creating anything'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async (params) => {
            try {
                const client = { ...params.client, kind: params.client.kind ?? 'company' } as CreateClientBody;
                const result = await createOutgoingInvoiceDraft({
                    entityId: params.entity,
                    client,
                    invoice: params.invoice as InvoiceSpec,
                    dryRun: params.dry_run ?? false,
                });
                return mcpSuccess({
                    dryRun: result.dryRun,
                    provider: result.provider,
                    providerType: result.providerType,
                    client: result.client ?? null,
                    problems: result.problems,
                    draft: result.draft
                        ? {
                              id: result.draft.id,
                              number: result.draft.number,
                              status: result.draft.status,
                              url: result.draft.url,
                          }
                        : null,
                    preview: result.dryRun ? result.input : undefined,
                });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
