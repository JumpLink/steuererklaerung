import type { ApiCheckResult } from '../../types/index.ts';
import { config } from './request.ts';
import { getOrganization } from './organization.ts';

export { config, getQontoEnv, getDefaultBankAccountId } from './request.ts';
export type { QontoEnv, QontoConfig, ConfigResult } from './request.ts';

/** Check connectivity to Qonto API (organization endpoint). */
export async function check(): Promise<ApiCheckResult> {
    const result = config();
    if (result.error) return { name: 'Qonto', ok: false, message: result.error };
    const env = result.config?.env ?? 'production';
    try {
        const data = await getOrganization();
        const slug = data?.organization?.slug ?? '—';
        return { name: 'Qonto', ok: true, message: `OK (org: ${slug}, env: ${env})` };
    } catch (err) {
        return {
            name: 'Qonto',
            ok: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export { getOrganization } from './organization.ts';
export type { GetOrganizationOptions, OrganizationResponse } from './organization.ts';

export { listBankAccounts, getBankAccount } from './bank-accounts.ts';

export { listTransactions, getTransaction } from './transactions.ts';
export type { ListTransactionsParams, GetTransactionOptions } from './transactions.ts';

export {
    getAttachment,
    downloadAttachmentContent,
    uploadAttachment,
    listTransactionAttachments,
    uploadAttachmentToTransaction,
    removeAttachmentFromTransaction,
} from './attachments.ts';

export { listStatements, getStatement } from './statements.ts';
export type { ListStatementsParams } from './statements.ts';

export { listClients, getClient, findClientByName, findOrCreateClient, clientDisplayName } from './clients.ts';
export type { ListClientsParams } from './clients.ts';

export {
    listClientInvoices,
    createClientInvoice,
    updateClientInvoice,
    sendClientInvoice,
    buildClientInvoiceBody,
    buildInvoiceItem,
    buildSendInvoiceBody,
    normalizeVatRate,
    normalizeAmount,
    addDays,
} from './client-invoices.ts';
export type { ListClientInvoicesParams, InvoiceSpec, InvoiceItemSpec, SendInvoiceSpec } from './client-invoices.ts';

export type {
    Organization,
    BankAccount,
    Transaction,
    Attachment,
    Statement,
    QontoListMeta,
    QontoListResponse,
    Client,
    CreateClientBody,
    QontoAddress,
    ClientInvoice,
    ClientInvoiceItem,
    CreateClientInvoiceBody,
    SendClientInvoiceBody,
} from './types.ts';
