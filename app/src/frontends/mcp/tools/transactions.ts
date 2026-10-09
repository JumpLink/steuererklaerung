/**
 * Unified transactions MCP tools.
 *
 * Read-only search/summary over the LOCAL transaction store (no bank calls, no
 * TAN) — so one query spans Qonto + all FinTS accounts at once. Keep the store
 * fresh via the CLI `transactions sync`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import { searchTransactions, transactionsSummary } from '../../../core/actions/transactions.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerTransactionsTools(server: McpServer, _ctx: AppContext): void {
    // ── transactions_search ─────────────────────────────────────────────
    server.registerTool(
        'transactions_search',
        {
            title: 'Search Unified Transactions',
            description:
                'Search the local unified transaction store across ALL accounts (Qonto + FinTS/Volksbank) at once. Read-only; reflects the last `transactions sync`. Amounts are signed EUR (expense negative).',
            inputSchema: {
                query: z.string().optional().describe('Text search over counterparty, purpose, reference, IBAN'),
                from: z.string().optional().describe('From booking date (YYYY-MM-DD, inclusive)'),
                to: z.string().optional().describe('To booking date (YYYY-MM-DD, inclusive)'),
                min_amount: z.number().optional().describe('Minimum absolute amount in EUR'),
                max_amount: z.number().optional().describe('Maximum absolute amount in EUR'),
                side: z.enum(['income', 'expense']).optional().describe('income = credit, expense = debit'),
                source: z.enum(['qonto', 'fints', 'camt']).optional().describe('Filter by source'),
                account_key: z.string().optional().describe('Exact accountKey (from transactions_summary)'),
                limit: z.number().optional().describe('Max results (default 50)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                const result = searchTransactions({
                    query: params.query,
                    from: params.from,
                    to: params.to,
                    minAmount: params.min_amount,
                    maxAmount: params.max_amount,
                    side: params.side,
                    source: params.source,
                    accountKey: params.account_key,
                    limit: params.limit ?? 50,
                });
                return mcpSuccess(result);
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── transactions_summary ────────────────────────────────────────────
    server.registerTool(
        'transactions_summary',
        {
            title: 'Unified Transactions Summary',
            description:
                'Per-account totals, transaction counts and date ranges across the whole local store. Use the returned accountKey values to scope transactions_search.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return mcpSuccess(transactionsSummary());
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
