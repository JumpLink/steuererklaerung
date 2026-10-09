/**
 * Read/query surface over the unified NDJSON store — the entity-scoping primitives the DMS,
 * the web cache and the MCP tools build on. Pure reads (memoized via store.ts); the sync /
 * import / normalize side stays in the CLI.
 */

import { loadAll } from './store.ts';
import { matchesFilter, type TxFilter, type TxSource, type UnifiedTransaction } from './unified.ts';

export interface SearchOptions extends TxFilter {
    limit?: number;
}

/** Search the unified store across all accounts (newest first). */
export function searchTransactions(opts: SearchOptions = {}): {
    count: number;
    transactions: UnifiedTransaction[];
} {
    const matched = loadAll()
        .filter((t) => matchesFilter(t, opts))
        .sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : a.bookingDate > b.bookingDate ? -1 : 0));
    const transactions = typeof opts.limit === 'number' ? matched.slice(0, opts.limit) : matched;
    return { count: matched.length, transactions };
}

/**
 * Fetch every transaction across an explicit set of account keys (optionally within a
 * date range) — the entity-scoping primitive: an entity owns several accounts, and
 * `searchTransactions`' `accountKey` filter takes one exact key at a time.
 */
export function searchAccountKeys(
    accountKeys: string[],
    range: { from?: string; to?: string } = {},
): UnifiedTransaction[] {
    return accountKeys.flatMap((k) => searchTransactions({ accountKey: k, ...range }).transactions);
}

export interface AccountSummary {
    accountKey: string;
    source: TxSource;
    count: number;
    firstDate?: string;
    lastDate?: string;
    totalIn: number;
    totalOut: number;
    net: number;
}

/** Per-account totals + date ranges across the whole store. */
export function transactionsSummary(): { accounts: AccountSummary[]; totalCount: number } {
    const byAccount = new Map<string, UnifiedTransaction[]>();
    for (const t of loadAll()) {
        const list = byAccount.get(t.accountKey) ?? [];
        list.push(t);
        byAccount.set(t.accountKey, list);
    }
    const accounts: AccountSummary[] = [];
    for (const [accountKey, list] of byAccount) {
        const dates = list
            .map((t) => t.bookingDate)
            .filter(Boolean)
            .sort();
        const totalIn = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
        const totalOut = list.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
        accounts.push({
            accountKey,
            source: list[0]?.source ?? 'qonto',
            count: list.length,
            firstDate: dates[0],
            lastDate: dates[dates.length - 1],
            totalIn: Math.round(totalIn * 100) / 100,
            totalOut: Math.round(totalOut * 100) / 100,
            net: Math.round((totalIn + totalOut) * 100) / 100,
        });
    }
    accounts.sort((a, b) => a.accountKey.localeCompare(b.accountKey));
    return { accounts, totalCount: accounts.reduce((s, a) => s + a.count, 0) };
}
