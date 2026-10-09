/**
 * FinTS client wrapper.
 * Manages session lifecycle, TAN handling, and banking information persistence.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { FinTSClient, FinTSConfig as LibFinTSConfig } from 'lib-fints';
import type {
    BankingInformation,
    BankAccount,
    AccountBalance,
    Statement,
    ClientResponse,
    SynchronizeResponse,
    StatementResponse,
    AccountBalanceResponse,
} from 'lib-fints';
import type { TanMethod } from './types.ts';
import type { FinTSAccountConfig } from '../../config/index.ts';
import { getPin, getDataFilePath } from '../../config/index.ts';
import { finTSInteraction } from './interaction.ts';

// ── Persistence ──────────────────────────────────────────────────────

function loadBankingInfo(accountName: string): BankingInformation | undefined {
    const path = getDataFilePath(accountName);
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as BankingInformation;
    } catch (e) {
        // Corrupt saved file → re-sync from scratch, but say so instead of failing silently.
        console.error(
            `[fints] Ignoring unreadable saved banking info for ${accountName}: ${e instanceof Error ? e.message : e}`,
        );
        return undefined;
    }
}

function saveBankingInfo(accountName: string, info: BankingInformation): void {
    const path = getDataFilePath(accountName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(info, null, 2), 'utf-8');
}

// ── Interactive prompts ──────────────────────────────────────────────
//
// The bank's questions go through the registered {@link FinTSInteraction} rather than to stdin, so
// the same session code serves a terminal and a window. See `interaction.ts` for why.

async function resolvePin(account: FinTSAccountConfig): Promise<string> {
    const envPin = getPin(account);
    if (envPin) return envPin;
    return finTSInteraction().requestPin({ accountName: account.name, blz: account.blz });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TAN handling ─────────────────────────────────────────────────────

async function handleTanChallenge<T extends ClientResponse>(
    client: FinTSClient,
    accountName: string,
    response: T,
    continueFn: (tanReference: string, tan?: string) => Promise<T>,
): Promise<T> {
    if (!response.requiresTan || !response.tanReference) return response;

    const tanMethod = client.config.selectedTanMethod;

    if (tanMethod?.isDecoupled && tanMethod.decoupled) {
        return pollDecoupledTan(response, continueFn, tanMethod);
    }

    const tan = await finTSInteraction().requestTan({
        accountName,
        challenge: response.tanChallenge ?? undefined,
        method: tanMethod?.name,
    });
    return continueFn(response.tanReference, tan);
}

async function pollDecoupledTan<T extends ClientResponse>(
    response: T,
    continueFn: (tanReference: string, tan?: string) => Promise<T>,
    tanMethod: TanMethod,
): Promise<T> {
    const decoupled = tanMethod.decoupled!;
    const ui = finTSInteraction();
    ui.notify('Bitte Transaktion in der Banking-App bestätigen …');
    await sleep(decoupled.waitingSecondsBeforeFirstStatusRequest * 1000);

    const maxAttempts = decoupled.maxStatusRequests || 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await continueFn(response.tanReference!, undefined);
        if (!result.requiresTan) return result;
        // Progress, not noise: this loop can run for minutes and a silent UI looks frozen.
        ui.notify(`Warte auf TAN-Freigabe … (${attempt}/${maxAttempts})`);
        await sleep(decoupled.waitingSecondsBetweenStatusRequests * 1000);
    }

    throw new Error('TAN-Freigabe Timeout — keine Bestätigung erhalten.');
}

// ── Client creation ──────────────────────────────────────────────────

async function createClient(account: FinTSAccountConfig): Promise<FinTSClient> {
    const pin = await resolvePin(account);
    const savedInfo = loadBankingInfo(account.name);

    let config: LibFinTSConfig;
    if (savedInfo) {
        config = LibFinTSConfig.fromBankingInformation(
            account.product_id,
            account.product_version,
            savedInfo,
            account.user_id,
            pin,
            account.tan_method_id,
            account.tan_media_name,
            account.customer_id,
        );
    } else {
        config = LibFinTSConfig.forFirstTimeUse(
            account.product_id,
            account.product_version,
            account.url,
            account.blz,
            account.user_id,
            pin,
            account.customer_id,
        );
    }

    return new FinTSClient(config);
}

// ── Public API ───────────────────────────────────────────────────────

export interface SyncResult {
    bankName: string | undefined;
    accounts: BankAccount[];
    tanMethods: TanMethod[];
    messages: Array<{ subject: string; text: string }>;
}

/**
 * Two-phase synchronization with the bank.
 * 1. First sync: get BPD (bank parameters) including TAN methods
 * 2. Select TAN method
 * 3. Second sync: get UPD (user parameters) with accounts
 * 4. Persist banking information
 */
export async function synchronize(account: FinTSAccountConfig): Promise<SyncResult> {
    const client = await createClient(account);

    // Phase 1: get BPD
    let response: SynchronizeResponse = await client.synchronize();

    if (response.requiresTan) {
        response = await handleTanChallenge(client, account.name, response, (ref, tan) =>
            client.synchronizeWithTan(ref, tan),
        );
    }

    // Select TAN method
    const tanMethods = client.config.availableTanMethods;
    if (tanMethods.length > 0) {
        const targetId = account.tan_method_id ?? tanMethods[0].id;
        client.selectTanMethod(targetId);

        if (account.tan_media_name) {
            client.selectTanMedia(account.tan_media_name);
        }

        // Phase 2: get UPD with selected TAN method
        response = await client.synchronize();

        if (response.requiresTan) {
            response = await handleTanChallenge(client, account.name, response, (ref, tan) =>
                client.synchronizeWithTan(ref, tan),
            );
        }
    }

    // Persist banking information
    saveBankingInfo(account.name, client.config.bankingInformation);

    const accounts = client.config.bankingInformation.upd?.bankAccounts ?? [];
    const messages = client.config.bankingInformation.bankMessages ?? [];
    const bankName = client.config.bankingInformation.bpd?.bankName;

    return { bankName, accounts, tanMethods, messages };
}

/**
 * Get bank accounts from persisted banking information (no network call).
 */
export function getAccounts(account: FinTSAccountConfig): BankAccount[] {
    const info = loadBankingInfo(account.name);
    if (!info?.upd?.bankAccounts) {
        throw new Error(`No saved banking data for "${account.name}". Run "fints sync" first.`);
    }
    return info.upd.bankAccounts;
}

/**
 * Get available TAN methods from persisted banking information (no network call).
 */
export function getTanMethods(account: FinTSAccountConfig): TanMethod[] {
    const info = loadBankingInfo(account.name);
    if (!info?.bpd) {
        throw new Error(`No saved banking data for "${account.name}". Run "fints sync" first.`);
    }
    const availableIds = info.bpd.availableTanMethodIds ?? [];
    return (info.bpd.supportedTanMethods ?? []).filter((m) => availableIds.includes(m.id));
}

/**
 * Fetch current account balance from the bank.
 */
export async function getBalance(account: FinTSAccountConfig, accountNumber: string): Promise<AccountBalance> {
    const client = await createClient(account);

    let response: AccountBalanceResponse = await client.getAccountBalance(accountNumber);

    if (response.requiresTan) {
        response = await handleTanChallenge(client, account.name, response, (ref, tan) =>
            client.getAccountBalanceWithTan(ref, tan),
        );
    }

    saveBankingInfo(account.name, client.config.bankingInformation);

    if (!response.balance) {
        throw new Error('No balance data received from bank.');
    }
    return response.balance;
}

/**
 * Fetch account statements/transactions from the bank.
 */
export async function getStatements(
    account: FinTSAccountConfig,
    accountNumber: string,
    from?: Date,
    to?: Date,
): Promise<Statement[]> {
    const client = await createClient(account);

    let response: StatementResponse = await client.getAccountStatements(accountNumber, from, to);

    if (response.requiresTan) {
        response = await handleTanChallenge(client, account.name, response, (ref, tan) =>
            client.getAccountStatementsWithTan(ref, tan),
        );
    }

    saveBankingInfo(account.name, client.config.bankingInformation);

    return response.statements ?? [];
}
