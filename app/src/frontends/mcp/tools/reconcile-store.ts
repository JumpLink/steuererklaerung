/**
 * Store-based reconciliation MCP tools.
 *
 * Counterpart to the live-Qonto tools in cross-system.ts, for *closed* accounts
 * whose history lives only in the local unified store (camt:/fints:/qonto:).
 * Links Paperless invoice documents to store transactions and reports the gap
 * (transaction without receipt / receipt without payment) for a period.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import { reconcileDocumentToStore, storeReconciliationStatus } from '../../../core/actions/reconcile-store.ts';
import {
    suggestDocumentLinksForTransaction,
    suggestTransactionLinksForDocument,
} from '../../../core/actions/link-candidates.ts';
import { listOpenItems } from '../../../core/actions/fristen.ts';
import { listSteuertermine } from '../../../core/actions/steuertermine.ts';
import { listOffeneSteuerzahlungen } from '../../../core/actions/steuerzahlungen.ts';
import {
    attachFilingDocument,
    detachFilingDocument,
    listFilingDocuments,
    listFilings,
    recordFiling,
    removeFiling,
} from '../../../core/actions/filings.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerReconcileStoreTools(server: McpServer, ctx: AppContext): void {
    const config = ctx.config;

    // ── match_document_to_store_transaction ─────────────────────────────

    server.registerTool(
        'match_document_to_store_transaction',
        {
            title: 'Match Paperless Document to Local Store Transaction',
            description:
                'Link a Paperless invoice document to a bank transaction in the LOCAL unified store (camt:/fints:/qonto:), for closed accounts not reachable via the Qonto API. Auto-matches on amount + direction + date (or pass store_transaction_id). Writes qonto_* bank-match fields so USt-VA/EÜR aggregation works unchanged.',
            inputSchema: {
                paperless_document_id: z.number().describe('Paperless document ID'),
                store_transaction_id: z
                    .string()
                    .optional()
                    .describe('Exact unified-store transaction id to link (skips auto-match)'),
                account_key: z
                    .string()
                    .optional()
                    .describe('Restrict the store search to one accountKey (from transactions_summary)'),
                max_day_gap: z
                    .number()
                    .optional()
                    .describe('Max |days| between booking and document date (default 60)'),
                amount_tolerance: z
                    .number()
                    .optional()
                    .describe('Max absolute amount difference in EUR (default 0.01)'),
                force: z
                    .boolean()
                    .default(false)
                    .describe('Re-match even if the document already has a qonto_transaction_id'),
                dry_run: z.boolean().default(false).describe('Report the chosen match without writing'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({
            paperless_document_id,
            store_transaction_id,
            account_key,
            max_day_gap,
            amount_tolerance,
            force,
            dry_run,
        }) => {
            try {
                const result = await reconcileDocumentToStore(config, paperless_document_id, {
                    storeTransactionId: store_transaction_id,
                    accountKey: account_key,
                    maxDayGap: max_day_gap,
                    amountTolerance: amount_tolerance,
                    force,
                    dryRun: dry_run,
                });
                return mcpSuccess(result);
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── get_store_reconciliation_status ─────────────────────────────────

    server.registerTool(
        'get_store_reconciliation_status',
        {
            title: 'Store Reconciliation Status (gap report)',
            description:
                'Reconciliation overview for a period from the LOCAL store + Paperless: matched/unmatched bank transactions and invoice documents, plus transactions that legitimately need no receipt (transfers, fees, owner draws). Use for closed accounts (camt import).',
            inputSchema: {
                year: z.number().describe('Tax year, e.g. 2025'),
                month: z.number().optional().describe('Optional month 1–12 to narrow to a single month'),
                account_key: z.string().optional().describe('Restrict to one accountKey (from transactions_summary)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ year, month, account_key }) => {
            try {
                const from = month ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`;
                const to = month
                    ? `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
                    : `${year}-12-31`;
                const result = await storeReconciliationStatus(config, { from, to }, { accountKey: account_key });
                return mcpSuccess(result);
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── suggest_link_candidates (Beleg ⇄ Buchung, read-only) ─────────────

    server.registerTool(
        'suggest_link_candidates',
        {
            title: 'Suggest Beleg ⇄ Buchung Link Candidates',
            description:
                'Read-only, deterministic heuristic ranking of the OTHER side of a document↔transaction link, scoped to a workspace entity. Pass transaction_id to rank invoice DOCUMENTS that could be its receipt (the "Offene Belege → Verknüpfen" engine), or document_id to rank store TRANSACTIONS that could be its payment. Each candidate: score (0..1), German reasons (Betrag/Datum/Korrespondent/Rechnungsnr.), amount, date, counterparty. To WRITE the chosen link use match_document_to_store_transaction (store_transaction_id).',
            inputSchema: {
                entity: z.string().describe('Workspace entity id (gbr|jumplink|privat)'),
                transaction_id: z
                    .string()
                    .optional()
                    .describe('Store transaction id → suggest matching receipt documents'),
                document_id: z.string().optional().describe('Document id → suggest matching payment transactions'),
                limit: z.number().optional().describe('Max candidates (default 8)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ entity, transaction_id, document_id, limit }) => {
            try {
                if (!transaction_id && !document_id) {
                    return mcpErrorFrom(new Error('Pass transaction_id or document_id.'));
                }
                const candidates = transaction_id
                    ? await suggestDocumentLinksForTransaction(entity, transaction_id, { limit })
                    : await suggestTransactionLinksForDocument(entity, document_id as string, { limit });
                return mcpSuccess({ candidates });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_open_items (Fristen & offene Posten) ───────────────────────

    server.registerTool(
        'list_open_items',
        {
            title: 'List Open Items (Fristen & offene Posten)',
            description:
                'List all Paperless documents currently marked payment_status=offen, ranked by urgency (overdue first, then soonest due_date, undated last). Each item: id, title, correspondent, amount (amount_to_pay), due_date, days until due, overdue flag, data_scope. The "damit ich sowas nicht vergesse" overview — reads the fields the document-workflow skill records.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            try {
                return mcpSuccess(await listOpenItems());
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_upcoming_deadlines (proaktive Steuertermine) ────────────────

    server.registerTool(
        'list_upcoming_deadlines',
        {
            title: 'List Upcoming Tax Deadlines (Regelfrist-Steuertermine)',
            description:
                "Derive the RECURRING statutory tax deadlines (USt-Voranmeldung per quarter/month + annual USt-Jahreserklärung, Feststellung/Anlage EÜR, Gewerbesteuer) from each entity's ELSTER config — the PROACTIVE layer that surfaces a deadline before any reminder letter arrives. Every date is a Regelfrist-SCHÄTZUNG (estimated=true): the USt-VA base deadline (10th of the following month) unless a Dauerfristverlängerung is configured, and the §149 AO annual base (31 July of the following year, no advisor extension). Verify against the actual Bescheid. Complements list_open_items (the reactive, document-based layer).",
            inputSchema: {
                today: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Reference date YYYY-MM-DD (default: today) — for deterministic output'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                return mcpSuccess(listSteuertermine({ today: params.today }));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_open_tax_payments (offene Steuerzahlungen) ──────────────────

    server.registerTool(
        'list_open_tax_payments',
        {
            title: 'List Open Tax Payments (Offene Steuerzahlungen)',
            description:
                'Every filed-but-unpaid tax amount from the filing register, with an ESTIMATED payment due date: a USt-VA Zahllast is due on the statutory filing deadline itself (§18 Abs. 1 UStG, no Bescheid needed; late filing = already overdue), a USt-Jahreserklärung Abschlusszahlung one month after the return reached the Finanzamt (§18 Abs. 4 UStG); GewSt/ESt fall due per Bescheid → due date null, amount still listed. Weekend deadlines shift to Monday (§108 Abs. 3 AO); holidays are not modelled. Complements list_upcoming_deadlines (declarations) and list_open_items (documents). Mark a payment done via record_filing with paid_at.',
            inputSchema: {
                today: z
                    .string()
                    .regex(DATE_RE)
                    .optional()
                    .describe('Reference date YYYY-MM-DD (default: today) — for deterministic output'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                return mcpSuccess(listOffeneSteuerzahlungen({ today: params.today }));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── record_filing (Einreichungs-Register: als erledigt markieren) ─────

    server.registerTool(
        'record_filing',
        {
            title: 'Record a Filing (Steuertermin als erledigt markieren)',
            description:
                'Record that a statutory declaration/payment has been submitted and/or paid — the "erledigt" side of the Fristen system. Keyed by (entity, kind, period); an existing entry is MERGE-updated (omitted fields preserved). Once recorded, list_upcoming_deadlines marks that Steuertermin eingereicht/bezahlt instead of nagging. entity = workspace id (gbr|jumplink|privat); kind matches the Steuertermin (ustva|ust-jahr|euer|feststellung|gewst|est|dauerfrist|sonstige); period = "2026-Q2" | "2026-03" | "2025". A USt-VA Zahllast is three distinct numbers: `declared_amount` = Anmeldungssoll (declared Zahllast, Kz 83) drives the annual Vorauszahlungssoll (Z119); `amount` = the amount actually paid (may include a Säumniszuschlag; paid/legacy value); `surcharge` = Säumniszuschlag / steuerliche Nebenleistung (§240 AO) — NOT USt, never in Z119.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id (gbr|jumplink|privat)'),
                kind: z
                    .string()
                    .describe('ustva | ust-jahr | euer | feststellung | gewst | est | dauerfrist | sonstige'),
                period: z.string().describe('"2026-Q2" | "2026-03" | "2025"'),
                filed_at: z.string().regex(DATE_RE).optional().describe('Submission date YYYY-MM-DD'),
                paid_at: z.string().regex(DATE_RE).optional().describe('Payment date YYYY-MM-DD'),
                declared_amount: z
                    .number()
                    .optional()
                    .describe('Anmeldungssoll (declared Zahllast, Kz 83) in EUR (signed) — drives Z119'),
                amount: z.number().optional().describe('Amount actually paid in EUR (signed; paid/legacy value)'),
                surcharge: z
                    .number()
                    .optional()
                    .describe('Säumniszuschlag / Nebenleistung (§240 AO) in EUR (signed) — not USt'),
                note: z.string().optional().describe('Free-text note'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (params) => {
            try {
                return mcpSuccess(
                    recordFiling({
                        entityId: params.entity,
                        kind: params.kind,
                        period: params.period,
                        filedAt: params.filed_at,
                        paidAt: params.paid_at,
                        amount: params.amount,
                        declaredAmount: params.declared_amount,
                        surcharge: params.surcharge,
                        note: params.note,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_filings (Register lesen) ────────────────────────────────────

    server.registerTool(
        'list_filings',
        {
            title: 'List Filings (Einreichungs-Register)',
            description:
                'List the filing register — which statutory declarations/payments are recorded as filed/paid — optionally scoped to one entity and/or year. Counterpart to record_filing; the year filter matches the period prefix (2025 → 2025, 2025-Q2, 2025-03).',
            inputSchema: {
                entity: z.string().optional().describe('Workspace entity id (gbr|jumplink|privat)'),
                year: z.number().optional().describe('Filter to periods of this year'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                return mcpSuccess(listFilings({ entityId: params.entity, year: params.year }));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── remove_filing ────────────────────────────────────────────────────

    server.registerTool(
        'remove_filing',
        {
            title: 'Remove a Filing',
            description: 'Delete a filing register entry (entity, kind, period). Use to undo a mistaken record_filing.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id'),
                kind: z
                    .string()
                    .describe('ustva | ust-jahr | euer | feststellung | gewst | est | dauerfrist | sonstige'),
                period: z.string().describe('"2026-Q2" | "2026-03" | "2025"'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (params) => {
            try {
                const removed = removeFiling(params.entity, params.kind, params.period);
                return mcpSuccess({ removed });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── attach_filing_document (Bescheid/Schreiben einer Einreichung zuordnen) ──

    server.registerTool(
        'attach_filing_document',
        {
            title: 'Attach a Document to a Filing (Bescheid/Antwortschreiben zuordnen)',
            description:
                'Link a DMS document to a filing-register entry — the Finanzamt response (Bescheid, Mahnung, Schreiben) or supporting proof (Übertragungsprotokoll, Zahlungsbeleg) for a submitted declaration. document_ref is DMS-agnostic: "paperless:<id>" for a Paperless-ngx document, a plain store document id for the built-in DMS. The filing must already exist (record_filing first); re-attaching the same document_ref merge-updates role/note.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id (gbr|jumplink|privat)'),
                kind: z
                    .string()
                    .describe('ustva | ust-jahr | euer | feststellung | gewst | est | dauerfrist | sonstige'),
                period: z.string().describe('"2026-Q2" | "2026-03" | "2025"'),
                document_ref: z.string().describe('Document reference, e.g. "paperless:2777"'),
                role: z
                    .enum(['bescheid', 'mahnung', 'uebertragungsprotokoll', 'zahlungsbeleg', 'schreiben', 'sonstiges'])
                    .optional()
                    .describe('Role of the document (default: sonstiges)'),
                note: z.string().optional().describe('Free-text note'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (params) => {
            try {
                return mcpSuccess(
                    attachFilingDocument({
                        entityId: params.entity,
                        kind: params.kind,
                        period: params.period,
                        documentRef: params.document_ref,
                        role: params.role,
                        note: params.note,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_filing_documents ────────────────────────────────────────────

    server.registerTool(
        'list_filing_documents',
        {
            title: 'List Filing Documents (zugeordnete Bescheide/Schreiben)',
            description:
                'List the documents attached to filing-register entries, optionally scoped by entity, kind, period and/or document_ref (all filters AND together). Counterpart to attach_filing_document.',
            inputSchema: {
                entity: z.string().optional().describe('Workspace entity id'),
                kind: z.string().optional().describe('Filing kind'),
                period: z.string().optional().describe('Period label'),
                document_ref: z.string().optional().describe('Find the filings a document is attached to'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                return mcpSuccess(
                    listFilingDocuments({
                        entityId: params.entity,
                        kind: params.kind,
                        period: params.period,
                        documentRef: params.document_ref,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── detach_filing_document ───────────────────────────────────────────

    server.registerTool(
        'detach_filing_document',
        {
            title: 'Detach a Filing Document',
            description:
                'Remove one document↔filing link (entity, kind, period, document_ref). The document itself is untouched.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id'),
                kind: z.string().describe('Filing kind'),
                period: z.string().describe('Period label'),
                document_ref: z.string().describe('Document reference to detach'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (params) => {
            try {
                const removed = detachFilingDocument(params.entity, params.kind, params.period, params.document_ref);
                return mcpSuccess({ removed });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
