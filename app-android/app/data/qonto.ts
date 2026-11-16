/** Slim Qonto v2 read client: bank accounts and balances. */
import { requestJson } from './http.ts';

export interface BankAccount {
    id: string;
    name: string;
    iban?: string;
    balance_cents?: number;
    balance_currency?: string;
    status?: string;
}
export interface QontoCreds { signIn: string; secretKey: string; baseUrl?: string }

export const QONTO_BASE_URL = 'https://thirdparty.qonto.com';

export function createQontoClient(c: QontoCreds) {
    const base = (c.baseUrl ?? QONTO_BASE_URL).replace(/\/$/, '');
    return {
        async listBankAccounts(): Promise<BankAccount[]> {
            const res = await requestJson<{ bank_accounts?: BankAccount[] }>(
                `${base}/v2/bank_accounts`,
                { method: 'GET', headers: { Authorization: `${c.signIn}:${c.secretKey}`, 'Content-Type': 'application/json' } },
                30_000,
                'Qonto',
            );
            return res?.bank_accounts ?? [];
        },
    };
}
