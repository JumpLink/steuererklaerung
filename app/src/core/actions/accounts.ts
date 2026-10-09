/**
 * Account-connection management for the web UI — the first WRITE path. Listing + file
 * import + disconnect are pure filesystem/SQLite (no outbound fetch), so they run safely
 * inside the request handler; live sync (Qonto/FinTS, network) goes through the
 * setTimeout(0) job in routes.ts instead.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    type AccountSummary,
    type ImportReport,
    enrichStoreFromAmazon,
    enrichStoreFromQontoExport,
    importCamt,
    importPaypal,
    transactionsSummary,
} from './transactions.ts';
import { ledgerImportFromStore, ledgerRemoveAccount } from './ledger.ts';
import { accountFileName, getStoreDir, readCursors, withImportBatch, writeCursors } from '@steuererklaerung/store';
import { newImportBatchId } from './imports.ts';
import { type FinTSAccountConfig, loadFinTSConfig, upsertFinTSAccount } from '../config/index.ts';

/** A stored account plus its entity + sync state, for the connections list. */
export interface ConnectionInfo extends AccountSummary {
    /** Account id without the source prefix (IBAN for camt, accountNumber for fints, …). */
    ref: string;
    entityId?: string;
    entityName?: string;
    /** Sync-able live source (qonto/fints) vs file-only (camt/paypal). */
    live: boolean;
    lastSyncedAt?: string;
}

export interface ConnectorStatus {
    qonto: { configured: boolean; env: string };
    fints: { accounts: string[] };
}

export interface AccountsResponse {
    accounts: ConnectionInfo[];
    connectors: ConnectorStatus;
}

/** Minimal entity view the list needs (resolved account keys per firm). */
export interface EntityAccounts {
    id: string;
    name: string;
    accountKeys: string[];
}

const LIVE_SOURCES = new Set(['qonto', 'fints']);

/** List every stored account with its entity + sync state, plus which live connectors exist. */
export function listConnections(entities: EntityAccounts[]): AccountsResponse {
    const cursors = readCursors();
    const accounts: ConnectionInfo[] = transactionsSummary().accounts.map((a) => {
        const entity = entities.find((e) => e.accountKeys.includes(a.accountKey));
        return {
            ...a,
            ref: a.accountKey.slice(a.accountKey.indexOf(':') + 1),
            entityId: entity?.id,
            entityName: entity?.name,
            live: LIVE_SOURCES.has(a.source),
            lastSyncedAt: cursors[a.accountKey]?.lastSyncedAt,
        };
    });

    const qontoEnv = (process.env.QONTO_ENV ?? 'production').trim();
    const qontoConfigured = !!(
        process.env[`QONTO_${qontoEnv.toUpperCase()}_SIGN_IN`] ?? process.env.QONTO_STAGING_TOKEN
    );
    let fintsAccounts: string[] = [];
    try {
        fintsAccounts = loadFinTSConfig().accounts.map((a) => a.name);
    } catch {
        /* no fints-config.json → none configured */
    }

    return {
        accounts,
        connectors: { qonto: { configured: qontoConfigured, env: qontoEnv }, fints: { accounts: fintsAccounts } },
    };
}

export type ImportFormat = 'camt' | 'paypal' | 'qonto-xls' | 'amazon';
const EXT_FORMAT: Record<string, ImportFormat> = { xml: 'camt', xls: 'qonto-xls', xlsx: 'qonto-xls' };

/** Best-effort format guess from the filename (CSV stays ambiguous → user picks). */
export function detectFormat(filename: string): ImportFormat | null {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    return EXT_FORMAT[ext] ?? null;
}

export interface ImportResult {
    format: ImportFormat;
    /** CAMT/PayPal return per-account reports; the enrich formats return match counts. */
    reports?: ImportReport[];
    enrich?: { matched: number; updated: number; accounts: number };
    /**
     * The batch every transaction this import ADDED is stamped with, so it can be taken back with
     * `transactions undo-import`. Absent for the enrich formats: those only annotate rows that are
     * already there, so there is nothing an undo could remove.
     */
    batchId?: string;
}

/**
 * Import an uploaded export file. Writes it to a temp path, runs the matching importer
 * (parse → store), then folds the store into the ledger. No network.
 */
export async function runImport(
    format: ImportFormat,
    filename: string,
    bytes: Buffer,
    opts: { full?: boolean } = {},
): Promise<ImportResult> {
    const dir = join(getStoreDir(), '.uploads');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmp = join(dir, `${safe}`);
    writeFileSync(tmp, bytes);
    try {
        // Everything this import ADDS is stamped with one batch id, so a wrong file or a
        // double-import can be taken back afterwards without touching anything else in the store.
        // Only the two formats that actually store transactions get a batch; the enrich formats
        // annotate existing rows, where an undo would have nothing to remove.
        const batchId = newImportBatchId(filename);
        let result: ImportResult;
        if (format === 'camt')
            result = withImportBatch(batchId, () => ({
                format,
                batchId,
                reports: importCamt(tmp, { full: opts.full }).reports,
            }));
        else if (format === 'paypal')
            result = withImportBatch(batchId, () => ({ format, batchId, reports: importPaypal(tmp).reports }));
        else if (format === 'qonto-xls') result = { format, enrich: enrichStoreFromQontoExport(tmp) };
        else result = { format, enrich: enrichStoreFromAmazon(tmp) };
        // Keep the ledger (system of record) in step with the NDJSON store. Awaited so a
        // failure surfaces (and can't silently leave the ledger stale).
        await ledgerImportFromStore();
        return result;
    } finally {
        try {
            unlinkSync(tmp);
        } catch {
            /* best-effort cleanup */
        }
    }
}

export type RemoveMode = 'delete-all' | 'stop-sync';

function dropCursor(accountKey: string): void {
    const cursors = readCursors();
    if (cursors[accountKey]) {
        delete cursors[accountKey];
        writeCursors(cursors);
    }
}

/** Disconnect an account: either stop syncing it (keep data) or delete it entirely. */
export async function removeConnection(
    accountKey: string,
    mode: RemoveMode,
): Promise<{ mode: RemoveMode; transactions: number }> {
    if (mode === 'delete-all') {
        // Ledger first: it guards locked (festgeschriebene) periods and throws BEFORE any
        // store file is touched, so a refused delete leaves everything intact.
        const { transactions } = await ledgerRemoveAccount(accountKey);
        const file = join(getStoreDir(), accountFileName(accountKey));
        if (existsSync(file)) unlinkSync(file);
        dropCursor(accountKey);
        return { mode, transactions };
    }
    dropCursor(accountKey);
    return { mode, transactions: 0 };
}

// ── Live connections: write credentials to .env / fints-config.json (localhost-only) ──────

function envPath(): string {
    return process.env.DOTENV_CONFIG_PATH ?? join(process.cwd(), '.env');
}

/** Upsert KEY=VALUE pairs in .env (preserving other lines) and the live process.env. */
export function upsertEnv(updates: Record<string, string>): void {
    for (const [k, v] of Object.entries(updates))
        if (/[\n\r]/.test(v))
            throw new Error(`Wert für ${k} enthält Zeilenumbrüche und kann nicht gespeichert werden.`);
    const p = envPath();
    const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n') : [];
    for (const [k, v] of Object.entries(updates)) {
        process.env[k] = v; // take effect immediately (the next sync uses it, no restart)
        const i = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${k}=`));
        if (i >= 0) lines[i] = `${k}=${v}`;
        else lines.push(`${k}=${v}`);
    }
    writeFileSync(p, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

/**
 * The account-key pattern a new live connection will produce, so it can be routed to an entity
 * before its first sync has created a single key. Mirrors the keys `syncTransactions` writes:
 * `qonto:<bankAccountId>` and `fints:<configName>:<accountNumber>`.
 */
export function connectionAccountPattern(source: 'qonto' | 'fints', fintsName = ''): string {
    return source === 'qonto' ? 'qonto:*' : `fints:${fintsName.trim()}:*`;
}

/** The account keys an import created, for routing them to an entity. Enrich formats create none. */
export function importedAccountKeys(result: ImportResult): string[] {
    return [...new Set((result.reports ?? []).map((r) => r.accountKey).filter(Boolean))];
}

export interface QontoConnect {
    login: string;
    secretKey: string;
    env?: string;
    bankAccountId?: string;
}

/** Save Qonto API credentials to .env under the chosen environment. */
export function connectQonto(c: QontoConnect): { env: string } {
    const env = (c.env ?? 'production').trim().toLowerCase() === 'staging' ? 'STAGING' : 'PRODUCTION';
    const updates: Record<string, string> = {
        QONTO_ENV: env.toLowerCase(),
        [`QONTO_${env}_SIGN_IN`]: c.login.trim(),
        [`QONTO_${env}_SECRET_KEY`]: c.secretKey.trim(),
    };
    if (c.bankAccountId?.trim()) updates[`QONTO_${env}_DEFAULT_BANK_ACCOUNT_ID`] = c.bankAccountId.trim();
    upsertEnv(updates);
    return { env: env.toLowerCase() };
}

export interface FintsConnect {
    name: string;
    url: string;
    blz: string;
    user_id: string;
    product_id: string;
    product_version?: string;
    pin: string;
}

/** Add/update a FinTS account in the manifest's `fints` section and store its PIN in .env. */
export function connectFints(c: FintsConnect): { name: string } {
    const name = c.name.trim();
    const entry: FinTSAccountConfig = {
        name,
        url: c.url.trim(),
        blz: c.blz.trim(),
        user_id: c.user_id.trim(),
        product_id: c.product_id.trim(),
        product_version: c.product_version?.trim() || '1.0',
    };
    upsertFinTSAccount(entry);

    upsertEnv({ [`FINTS_PIN_${name.replace(/[-\s]/g, '_').toLowerCase()}`]: c.pin });
    return { name };
}
