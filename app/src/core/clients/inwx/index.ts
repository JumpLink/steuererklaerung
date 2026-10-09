/** INWX client - public API. */

import type { ApiCheckResult } from '../../types/index.ts';
import { getInwxConfig, callApi } from './request.ts';

export { getInwxConfig } from './request.ts';
export type { InwxConfig, ConfigResult, InwxEnv } from './request.ts';
export { listInwxInvoices, getInwxInvoice } from './invoices.ts';
export type { InwxRawInvoice, InwxListInvoicesResponse, InwxGetInvoiceResponse } from './types.ts';

/** Check INWX API connectivity. */
export async function check(): Promise<ApiCheckResult> {
    const result = getInwxConfig();
    if (result.error) {
        return { name: 'INWX', ok: false, message: result.error };
    }
    try {
        const data = await callApi<{ count: number }>('accounting.listInvoices', {});
        return { name: 'INWX', ok: true, message: `OK (${data.count} invoice(s))` };
    } catch (err) {
        return { name: 'INWX', ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
