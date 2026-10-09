/**
 * Read-only Qonto API actions for CLI commands.
 * Each function calls the client and returns the result (command layer handles output).
 */

import {
    getOrganization,
    listBankAccounts,
    getBankAccount,
    listTransactions,
    getTransaction,
    listStatements,
    getStatement,
    listClients,
    findClientByName,
    listClientInvoices,
    updateClientInvoice,
    sendClientInvoice,
    buildClientInvoiceBody,
    buildSendInvoiceBody,
} from '../clients/qonto/index.ts';
import type {
    ListTransactionsParams,
    ListStatementsParams,
    ListClientInvoicesParams,
    CreateClientBody,
    InvoiceSpec,
    SendInvoiceSpec,
} from '../clients/qonto/index.ts';

export async function qontoOrg(includeExternalAccounts = false) {
    return getOrganization({ includeExternalAccounts });
}

export async function qontoBankAccounts() {
    return listBankAccounts();
}

export async function qontoBankAccount(accountId: string) {
    return getBankAccount(accountId);
}

export async function qontoTransactions(params: ListTransactionsParams) {
    return listTransactions(params);
}

export async function qontoTransaction(transactionId: string) {
    return getTransaction(transactionId);
}

export async function qontoStatements(params: ListStatementsParams = {}) {
    return listStatements(params);
}

export async function qontoStatement(statementId: string) {
    return getStatement(statementId);
}

export async function qontoClients() {
    return listClients();
}

export async function qontoClientInvoices(params: ListClientInvoicesParams = {}) {
    return listClientInvoices(params);
}

export interface CreateInvoiceInput {
    /** Client data for find-or-create (matched by name). */
    client: CreateClientBody;
    /** Invoice spec (without client_id; resolved here). */
    invoice: InvoiceSpec;
    /** If true, resolve the client read-only and print the payload without creating anything. */
    dryRun?: boolean;
}

/**
 * Update an existing DRAFT invoice in place from the same { client, invoice } spec.
 * Resolves the client by name (reuse), rebuilds the body, then PATCHes the draft.
 */
export async function qontoUpdateInvoice(invoiceId: string, input: CreateInvoiceInput) {
    const { client: clientBody, invoice, dryRun } = input;
    const name = clientBody.name ?? [clientBody.first_name, clientBody.last_name].filter(Boolean).join(' ');
    const existing = name ? await findClientByName(name) : undefined;
    const clientId = existing?.id ?? '<<resolved-on-update>>';
    const body = buildClientInvoiceBody(clientId, invoice);

    if (dryRun) {
        return { dryRun: true, invoiceId, client: { id: clientId, name }, invoice: body };
    }
    const result = await updateClientInvoice(invoiceId, body);
    return { dryRun: false, invoiceId, client: { id: clientId, name }, invoice: result };
}

/**
 * Send a finalized invoice by email. Outward-facing: only sends when opts.confirm is true,
 * otherwise returns a preview of the exact payload so a human can approve it first.
 */
export async function qontoSendInvoice(invoiceId: string, spec: SendInvoiceSpec, opts: { confirm?: boolean } = {}) {
    const body = buildSendInvoiceBody(spec);
    if (!opts.confirm) {
        return {
            sent: false,
            note: 'Preview only — re-run with --confirm to actually send this email.',
            invoiceId,
            body,
        };
    }
    const result = await sendClientInvoice(invoiceId, body);
    return { sent: true, invoiceId, body, result };
}
