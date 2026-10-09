/**
 * Qonto API – Bank accounts.
 * GET /v2/bank_accounts, GET /v2/bank_accounts/:id
 */

import { get, listAll } from './request.ts';
import type { BankAccount } from './types.ts';

/**
 * List all bank accounts (all pages).
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listBankAccounts(): Promise<BankAccount[]> {
    return listAll<BankAccount>('bank_accounts');
}

/**
 * Get a single bank account by id.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getBankAccount(accountId: string): Promise<BankAccount> {
    const res = await get<{ bank_account: BankAccount }>(`bank_accounts/${accountId}`);
    return res.bank_account;
}
