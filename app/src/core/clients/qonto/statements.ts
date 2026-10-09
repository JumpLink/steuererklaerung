/**
 * Qonto API – Statements.
 * GET /v2/statements, GET /v2/statements/:id
 */

import { get, listAll } from './request.ts';
import type { Statement } from './types.ts';

export interface ListStatementsParams {
    bank_account_ids?: string[];
    ibans?: string[];
    period_from?: string;
    period_to?: string;
    sort_by?: string;
}

function buildQuery(params: ListStatementsParams): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (params.bank_account_ids?.length) q.bank_account_ids = params.bank_account_ids;
    if (params.ibans?.length) q.ibans = params.ibans;
    if (params.period_from) q.period_from = params.period_from;
    if (params.period_to) q.period_to = params.period_to;
    if (params.sort_by) q.sort_by = params.sort_by;
    return q;
}

/**
 * List statements (all pages) with optional filters.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listStatements(params: ListStatementsParams = {}): Promise<Statement[]> {
    const query = buildQuery(params);
    return listAll<Statement>('statements', query);
}

/**
 * Get a single statement by id.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getStatement(statementId: string): Promise<Statement> {
    const res = await get<{ statement: Statement }>(`statements/${statementId}`);
    return res.statement;
}
