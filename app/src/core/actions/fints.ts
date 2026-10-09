/**
 * FinTS action wrappers for CLI commands.
 */

import { loadFinTSConfig, getAccountConfig } from '../config/index.ts';
import { synchronize, getAccounts, getTanMethods, getBalance, getStatements } from '../clients/fints/index.ts';

export async function fintsSync(accountName?: string) {
    const config = loadFinTSConfig();
    const account = getAccountConfig(config, accountName);
    return synchronize(account);
}

export function fintsAccounts(accountName?: string) {
    const config = loadFinTSConfig();
    const account = getAccountConfig(config, accountName);
    return getAccounts(account);
}

export function fintsTanMethods(accountName?: string) {
    const config = loadFinTSConfig();
    const account = getAccountConfig(config, accountName);
    return getTanMethods(account);
}

export async function fintsBalance(accountNumber: string, accountName?: string) {
    const config = loadFinTSConfig();
    const account = getAccountConfig(config, accountName);
    return getBalance(account, accountNumber);
}

export async function fintsTransactions(accountNumber: string, accountName?: string, from?: string, to?: string) {
    const config = loadFinTSConfig();
    const account = getAccountConfig(config, accountName);
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return getStatements(account, accountNumber, fromDate, toDate);
}
