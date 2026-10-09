/**
 * Unified transactions: incremental sync across Qonto + FinTS into the local
 * NDJSON store, plus cross-account search and summary.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadFinTSConfig, getAccountConfig } from '../config/index.ts';
import { getAccounts, getStatements, synchronize } from '../clients/fints/index.ts';
import { getDefaultBankAccountId, listTransactions } from '../clients/qonto/index.ts';
import { parseCamt } from '../clients/camt/parser.ts';
import type { CamtStatementInfo } from '../clients/camt/types.ts';
import { parsePaypalCsv } from '../clients/paypal/parser.ts';
import { parseQontoExport } from '../clients/qonto-export/index.ts';
import { enrichCamtFromMerchants, type MerchantRow } from '../lib/transactions/qonto-export-enrich.ts';
import { parseAmazonOrders } from '../clients/amazon/parser.ts';
import { enrichCamtFromAmazon } from '../lib/transactions/amazon-enrich.ts';
import {
    normalizeCamt,
    normalizeFints,
    loadAll,
    readCursors,
    upsertAccount,
    upsertStatements,
    writeCursors,
    type StatementMeta,
    type FintsRawTx,
    type UnifiedTransaction,
    type AccountCursor,
} from '@steuererklaerung/store';
import { normalizeQonto } from '../lib/transactions/normalize-qonto.ts';
import { shiftDate } from '@steuererklaerung/shared';

/** Re-fetch this many days before the last cursor to catch late-booked items. */
const OVERLAP_DAYS = 5;
/** FinTS typically serves only ~90 days of history live without re-authorization. */
const FINTS_LIVE_DAYS = 89;

function isoNow(): string {
    return new Date().toISOString();
}

function isoDateDaysAgo(days: number): string {
    return shiftDate(new Date().toISOString().slice(0, 10), -days);
}

function maxBookingDate(txs: UnifiedTransaction[], fallback?: string): string | undefined {
    return txs.reduce((m, t) => (t.bookingDate > (m ?? '') ? t.bookingDate : m), fallback);
}

export interface SyncOptions {
    /** Force start date (YYYY-MM-DD); overrides the cursor. */
    from?: string;
    /** Ignore the cursor and pull the full available history. */
    full?: boolean;
    /** Limit to one account: "qonto" or a FinTS config name (e.g. "musterbank-privat"). */
    account?: string;
}

export interface AccountSyncReport {
    accountKey: string;
    source: 'qonto' | 'fints';
    from?: string;
    fetched: number;
    added: number;
    updated: number;
    total: number;
    error?: string;
}

async function syncQonto(opts: SyncOptions, cursors: Record<string, AccountCursor>): Promise<AccountSyncReport | null> {
    const bankAccountId = getDefaultBankAccountId();
    if (!bankAccountId) return null;
    const accountKey = `qonto:${bankAccountId}`;
    const cur = cursors[accountKey];
    const from = opts.full
        ? undefined
        : (opts.from ?? (cur?.lastBookingDate ? shiftDate(cur.lastBookingDate, -OVERLAP_DAYS) : undefined));
    try {
        const raw = await listTransactions({ bankAccountId, settled_at_from: from });
        const norm = raw.map((t) => normalizeQonto(accountKey, undefined, t));
        const res = upsertAccount(accountKey, norm);
        cursors[accountKey] = {
            accountKey,
            source: 'qonto',
            lastBookingDate: maxBookingDate(norm, cur?.lastBookingDate),
            lastSyncedAt: isoNow(),
            count: res.total,
        };
        return { accountKey, source: 'qonto', from, fetched: norm.length, ...res };
    } catch (err) {
        return {
            accountKey,
            source: 'qonto',
            from,
            fetched: 0,
            added: 0,
            updated: 0,
            total: cur?.count ?? 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

async function syncFints(opts: SyncOptions, cursors: Record<string, AccountCursor>): Promise<AccountSyncReport[]> {
    let config: ReturnType<typeof loadFinTSConfig>;
    try {
        config = loadFinTSConfig();
    } catch {
        return []; // FinTS not configured — silently skip
    }
    const reports: AccountSyncReport[] = [];
    const liveFrom = isoDateDaysAgo(FINTS_LIVE_DAYS);

    for (const acctCfg of config.accounts) {
        if (opts.account && opts.account !== acctCfg.name) continue;
        // A bank the user just added has no saved banking data yet: the FinTS handshake that
        // discovers the accounts has not run. It used to end here with "run fints sync --account …",
        // which is a command line — unreachable from the app, where the account was just added and
        // this very sync is the button the user pressed. Since the TAN conversation now goes through
        // a registered provider (core/clients/fints/interaction.ts), the handshake works in every
        // surface, so the sync just DOES it and carries on.
        const accountConfig = getAccountConfig(config, acctCfg.name);
        let bankAccounts: ReturnType<typeof getAccounts>;
        try {
            bankAccounts = getAccounts(accountConfig);
        } catch {
            try {
                await synchronize(accountConfig);
                bankAccounts = getAccounts(accountConfig);
            } catch (err) {
                reports.push({
                    accountKey: `fints:${acctCfg.name}`,
                    source: 'fints',
                    fetched: 0,
                    added: 0,
                    updated: 0,
                    total: 0,
                    error: `Erstanmeldung bei „${acctCfg.name}" fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
                });
                continue;
            }
        }

        for (const ba of bankAccounts) {
            const accountKey = `fints:${acctCfg.name}:${ba.accountNumber}`;
            const cur = cursors[accountKey];
            let from = opts.from ?? (cur?.lastBookingDate ? shiftDate(cur.lastBookingDate, -OVERLAP_DAYS) : liveFrom);
            // Without an explicit --from/--full, don't ask earlier than the live window allows.
            if (!opts.full && !opts.from && from < liveFrom) from = liveFrom;

            try {
                const statements = await getStatements(acctCfg, ba.accountNumber, new Date(from), undefined);
                const norm: UnifiedTransaction[] = [];
                const metas: StatementMeta[] = [];
                for (const stmt of statements) {
                    const txs = (stmt as unknown as { transactions?: FintsRawTx[] }).transactions ?? [];
                    const own = txs.map((tx) => normalizeFints(accountKey, ba.iban, tx));
                    norm.push(...own);
                    const raw = stmt as unknown as {
                        openingBalance?: { date?: Date; value?: number };
                        closingBalance?: { date?: Date; value?: number };
                    };
                    const meta = toStatementMeta(
                        { opening: fintsBalance(raw.openingBalance), closing: fintsBalance(raw.closingBalance) },
                        own,
                        'fints',
                    );
                    if (meta && meta.opening != null && meta.closing != null) metas.push(meta);
                }
                const res = upsertAccount(accountKey, norm);
                upsertStatements(accountKey, metas);
                cursors[accountKey] = {
                    accountKey,
                    source: 'fints',
                    lastBookingDate: maxBookingDate(norm, cur?.lastBookingDate),
                    lastSyncedAt: isoNow(),
                    count: res.total,
                };
                reports.push({ accountKey, source: 'fints', from, fetched: norm.length, ...res });
            } catch (err) {
                reports.push({
                    accountKey,
                    source: 'fints',
                    from,
                    fetched: 0,
                    added: 0,
                    updated: 0,
                    total: cur?.count ?? 0,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return reports;
}

/**
 * Sync new transactions from all configured sources into the store (incremental).
 * Qonto runs unattended; FinTS may trigger a SecureGo/TAN approval.
 */
export async function syncTransactions(opts: SyncOptions = {}): Promise<{ reports: AccountSyncReport[] }> {
    const cursors = readCursors();
    const reports: AccountSyncReport[] = [];

    if (!opts.account || opts.account === 'qonto') {
        const q = await syncQonto(opts, cursors);
        if (q) reports.push(q);
    }
    if (opts.account !== 'qonto') {
        reports.push(...(await syncFints(opts, cursors)));
    }

    writeCursors(cursors);
    return { reports };
}

/**
 * A statement's metadata for the Kontoauszug check. The period comes from the file when it states one,
 * else from the balance dates, else from its own entries; a statement with no date at all is dropped.
 */
export function toStatementMeta(
    info: CamtStatementInfo,
    entries: { bookingDate: string; amount: number }[],
    source: StatementMeta['source'],
): StatementMeta | null {
    const dates = entries
        .map((e) => e.bookingDate)
        .filter(Boolean)
        .sort();
    const from = info.from ?? info.opening?.date ?? dates[0];
    const to = info.to ?? info.closing?.date ?? dates[dates.length - 1];
    if (!from || !to) return null;
    const sum = Math.round(entries.reduce((a, e) => a + e.amount, 0) * 100) / 100;
    return {
        from,
        to,
        ...(info.opening ? { opening: info.opening.value } : {}),
        ...(info.closing ? { closing: info.closing.value } : {}),
        ...(info.seq != null ? { seq: info.seq } : {}),
        sum,
        count: entries.length,
        source,
    };
}

/** lib-fints balance → statement info balance; a zero epoch date means "not carried". */
function fintsBalance(b: { date?: Date | string; value?: number } | undefined): CamtStatementInfo['opening'] {
    if (!b || typeof b.value !== 'number') return undefined;
    const d = b.date instanceof Date ? b.date : b.date ? new Date(b.date) : null;
    if (!d || Number.isNaN(d.getTime()) || d.getTime() === 0) return undefined;
    return { date: d.toISOString().slice(0, 10), value: b.value };
}

function normalizeIban(s: string): string {
    return s.replace(/\s+/g, '').toUpperCase();
}

/** Split a path into one-account CAMT groups (a file, or per-account subdirs). */
function resolveCamtGroups(inputPath: string): string[] {
    if (!existsSync(inputPath)) throw new Error(`Path not found: ${inputPath}`);
    if (statSync(inputPath).isFile()) return [inputPath];
    const entries = readdirSync(inputPath, { withFileTypes: true });
    const groups = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(inputPath, e.name))
        .filter((d) => readdirSync(d).some((f) => f.toLowerCase().endsWith('.xml')));
    if (entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml'))) groups.push(inputPath);
    return groups.length ? groups : [inputPath];
}

export interface ImportReport {
    accountKey: string;
    iban: string;
    files: number;
    parsed: number;
    imported: number;
    added: number;
    updated: number;
    total: number;
    skippedInWindow: number;
    range?: { from?: string; to?: string };
    note?: string;
}

/**
 * Import CAMT.052/053 XML exports into the store. Two cases, decided per group by
 * matching the export's IBAN against the existing store:
 *
 * 1. **Backfill an existing account** (matched IBAN, e.g. a year of Volksbank
 *    statements before the FinTS ~90-day live window). By default only
 *    transactions OLDER than what the account already has are imported, so the
 *    overlap is not duplicated; `full=true` imports everything.
 * 2. **Import a standalone / closed account** (unmatched IBAN, e.g. a dissolved
 *    company's Qonto account no longer reachable via API). It is stored under its
 *    own `camt:<iban>` account key with its full history — the export is the
 *    canonical source, so re-running is idempotent (stable content ids dedupe).
 *
 * Note: a folder with several XML files is treated as ONE account (a single
 * account's statements split across files). For several DISTINCT accounts that
 * share a flat folder, import each file individually so each keeps its own IBAN.
 */
export function importCamt(inputPath: string, opts: { full?: boolean } = {}): { reports: ImportReport[] } {
    const existing = loadAll();
    const ibanToKey = new Map<string, string>();
    const minDate = new Map<string, string>();
    for (const t of existing) {
        if (t.iban) ibanToKey.set(normalizeIban(t.iban), t.accountKey);
        const cur = minDate.get(t.accountKey);
        if (t.bookingDate && (!cur || t.bookingDate < cur)) minDate.set(t.accountKey, t.bookingDate);
    }

    const reports: ImportReport[] = [];
    for (const group of resolveCamtGroups(inputPath)) {
        const { files, account, statements, infos } = parseCamt(group);
        const iban = normalizeIban(account.iban);
        if (!iban) {
            reports.push({
                accountKey: '(unmatched)',
                iban: account.iban,
                files: files.length,
                parsed: 0,
                imported: 0,
                added: 0,
                updated: 0,
                total: 0,
                skippedInWindow: 0,
                note: 'Export carries no account IBAN — cannot attribute its transactions.',
            });
            continue;
        }
        const matchedKey = ibanToKey.get(iban);
        // Unmatched, or a previously file-imported account → standalone: store under
        // its own camt: key and import the full history (the file is the source of truth).
        const isStandalone = !matchedKey || matchedKey.startsWith('camt:');
        const accountKey = matchedKey ?? `camt:${iban}`;
        const cutoff = opts.full || isStandalone ? undefined : minDate.get(accountKey);
        const norm: UnifiedTransaction[] = [];
        const dates: string[] = [];
        let parsed = 0;
        let skipped = 0;
        const metas: StatementMeta[] = [];
        for (const [i, stmt] of statements.entries()) {
            const txs = (stmt as unknown as { transactions?: FintsRawTx[] }).transactions ?? [];
            const own: UnifiedTransaction[] = [];
            for (const tx of txs) {
                // seq = the entry's position in the export, folded into the camt id so
                // content-identical-but-distinct bookings (no unique bank reference) survive.
                const u = isStandalone
                    ? normalizeCamt(accountKey, account.iban, tx, parsed)
                    : normalizeFints(accountKey, account.iban, tx);
                parsed++;
                own.push(u);
                if (u.bookingDate) dates.push(u.bookingDate);
                if (cutoff && u.bookingDate >= cutoff) {
                    skipped++;
                    continue;
                }
                norm.push(u);
            }
            const meta = toStatementMeta(infos[i] ?? {}, own, 'camt');
            if (meta) metas.push(meta);
        }
        const res = upsertAccount(accountKey, norm);
        upsertStatements(accountKey, metas);
        dates.sort();
        reports.push({
            accountKey,
            iban: account.iban,
            files: files.length,
            parsed,
            imported: norm.length,
            added: res.added,
            updated: res.updated,
            total: res.total,
            skippedInWindow: skipped,
            range: { from: dates[0], to: dates[dates.length - 1] },
            note: !matchedKey ? 'New standalone account (not API-synced) imported from CAMT export.' : undefined,
        });
    }
    return { reports };
}

/**
 * Restore card merchants onto the CAMT-imported `camt:` transactions from a Qonto
 * XLS "Vollständiger Datenexport". CAMT53 drops the card merchant (only
 * "NONREF … <card-no>" survives); the Qonto export carries `counterpartyName`. Match on
 * (IBAN, booking date, signed amount) and fold the merchant into the stored
 * transaction (same id → in-place update). Data repair, not classification.
 */
export function enrichStoreFromQontoExport(xlsPath: string): { matched: number; updated: number; accounts: number } {
    // Qonto's "Vollständiger Datenexport" dates are "DD-MM-YYYY HH:MM:SS".
    const dmyToIso = (s: string | undefined): string | undefined => {
        const m = /^(\d{2})-(\d{2})-(\d{4})/.exec((s ?? '').trim());
        return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
    };
    const merchants: MerchantRow[] = parseQontoExport(xlsPath)
        .filter((e) => e.counterpartyName)
        .map((e) => ({
            iban: e.accountIban,
            dates: [dmyToIso(e.settledAtLocal), dmyToIso(e.operationDateLocal)].filter((d): d is string => !!d),
            amount: e.totalAmount,
            merchant: e.counterpartyName,
            method: e.paymentMethod,
        }));
    const camtTxs = loadAll().filter((t) => t.source === 'camt');
    const { enriched, matched } = enrichCamtFromMerchants(camtTxs, merchants);
    const byKey = new Map<string, UnifiedTransaction[]>();
    for (const t of enriched) {
        const arr = byKey.get(t.accountKey);
        if (arr) arr.push(t);
        else byKey.set(t.accountKey, [t]);
    }
    let updated = 0;
    for (const [k, txs] of byKey) updated += upsertAccount(k, txs).updated;
    return { matched, updated, accounts: byKey.size };
}

/**
 * Fold Amazon article details (title + category) onto the matching Amazon `camt:`
 * card charges from an Amazon "Bestellungen" CSV, matched on amount + a small date
 * window. Lets the EÜR classify by item (home-improvement → private, computer gear
 * → business). Data repair, not classification; idempotent (a ⟦…⟧ tag marks it).
 */
export function enrichStoreFromAmazon(csvPath: string): { matched: number; updated: number; accounts: number } {
    const payments = parseAmazonOrders(csvPath);
    const camtTxs = loadAll().filter((t) => t.source === 'camt');
    const { enriched, matched } = enrichCamtFromAmazon(camtTxs, payments);
    const byKey = new Map<string, UnifiedTransaction[]>();
    for (const t of enriched) {
        const arr = byKey.get(t.accountKey);
        if (arr) arr.push(t);
        else byKey.set(t.accountKey, [t]);
    }
    let updated = 0;
    for (const [k, txs] of byKey) updated += upsertAccount(k, txs).updated;
    return { matched, updated, accounts: byKey.size };
}

/**
 * Import a PayPal "Aktivitätsbericht" CSV as a searchable `paypal:` source. PayPal
 * is an enrichment source, NOT summed into the EÜR (the bank's PP.1555.PP debit
 * already counts the spend); each payment carries the bank reference so an opaque
 * bank "PP.1555.PP/<ref>" can be resolved to its real merchant.
 */
export function importPaypal(inputPath: string): { reports: ImportReport[] } {
    const accountKey = 'paypal:hauptkonto';
    const txs = parsePaypalCsv(inputPath, accountKey);
    const res = upsertAccount(accountKey, txs);
    const dates = txs
        .map((t) => t.bookingDate)
        .filter(Boolean)
        .sort();
    return {
        reports: [
            {
                accountKey,
                iban: '',
                files: 1,
                parsed: txs.length,
                imported: txs.length,
                added: res.added,
                updated: res.updated,
                total: res.total,
                skippedInWindow: 0,
                range: { from: dates[0], to: dates[dates.length - 1] },
                note: 'PayPal payments — enrichment only; NOT counted in the EÜR (the bank PP.1555.PP debits are).',
            },
        ],
    };
}

// The read/query surface moved to @steuererklaerung/store; re-exported here so existing callers
// (web, mcp, elster, dms) keep importing it from this module unchanged.
export {
    searchTransactions,
    searchAccountKeys,
    transactionsSummary,
    type SearchOptions,
    type AccountSummary,
} from '@steuererklaerung/store';
