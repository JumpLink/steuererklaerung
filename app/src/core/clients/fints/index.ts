export { synchronize, getAccounts, getTanMethods, getBalance, getStatements } from './client.ts';
export type { SyncResult } from './client.ts';
export type { BankingInformation, BankAccount, AccountBalance, Statement, Transaction, TanMethod } from './types.ts';

import { loadFinTSConfig } from '../../config/index.ts';

/**
 * Check FinTS configuration (config file exists and is valid).
 * Does not connect to the bank (requires PIN/TAN).
 */
export async function check(): Promise<{ name: string; ok: boolean; message: string }> {
    try {
        const config = loadFinTSConfig();
        const names = config.accounts.map((a) => a.name).join(', ');
        return { name: 'FinTS', ok: true, message: `OK (${config.accounts.length} account(s): ${names})` };
    } catch (err) {
        return { name: 'FinTS', ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
