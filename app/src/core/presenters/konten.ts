/**
 * Konten presenter — the accounts read/derive shared by the desktop Konten view and the web account
 * routes. It owns:
 *   - {@link toEntityAccounts}: the entity → EntityAccounts shaping, used by BOTH the web server (to
 *     pass `deps.entities` into the account routes) and the desktop connection list;
 *   - {@link loadConnections}: the desktop's global connection list — resolve every entity fresh from
 *     the store (transactionsSummary + resolveWorkspaceEntities), then listConnections;
 *   - {@link accountSyncScope}: map a connection to the syncTransactions `account` scope (the FinTS
 *     config name vs "qonto") — the pure derive the desktop's per-card Synchronisieren used.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on GJS
 * in every frontend.
 */

import { listConnections, type ConnectionInfo, type EntityAccounts } from '../actions/accounts.ts';
import { resolveWorkspaceEntities } from '../config/index.ts';
import { transactionsSummary } from '../actions/transactions.ts';

export type { ConnectionInfo, EntityAccounts, RemoveMode } from '../actions/accounts.ts';
export type { AccountSyncReport } from '../actions/transactions.ts';

/** Reduce workspace entities to the {id,name,accountKeys} triples listConnections labels accounts by. */
export function toEntityAccounts(entities: { id: string; name: string; accountKeys: string[] }[]): EntityAccounts[] {
    return entities.map((e) => ({ id: e.id, name: e.name, accountKeys: e.accountKeys }));
}

/**
 * Every connected account across all entities (synchronous, store-only), each labelled with its
 * entity. The connection list is global (not entity-scoped), so we resolve the full workspace fresh
 * from the store here — the same resolver the entity switcher uses — and label each account with it.
 */
export function loadConnections(): ConnectionInfo[] {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const entities = toEntityAccounts(resolveWorkspaceEntities(storeKeys));
    return listConnections(entities).accounts;
}

/**
 * The syncTransactions `account` scope for one connection: the literal "qonto" for Qonto, else the
 * FinTS *config name* — the accountKey's second segment (e.g. `fints:musterbank-privat:DE…` →
 * `musterbank-privat`). A FinTS login can hold several bank accounts, so syncing one FinTS card pulls
 * that whole login (the finest granularity the sync action offers).
 */
export function accountSyncScope(a: ConnectionInfo): string {
    return a.source === 'fints' ? a.accountKey.split(':')[1] : 'qonto';
}
