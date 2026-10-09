/**
 * Local NDJSON transaction store + per-account sync cursors.
 *
 * One newline-delimited JSON file per account under the store dir, plus a
 * cursors.json tracking how far each account has been synced. The store keeps
 * history beyond a bank's live window (e.g. FinTS only serves ~90 days), so
 * regular incremental syncs never need to re-fetch everything.
 *
 * The store holds private + business financial data — the directory is gitignored.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TxSource, UnifiedTransaction } from './unified.ts';
import { dedupeKey } from './unified.ts';

const CURSORS_FILE = 'cursors.json';

/**
 * The package root that owns `transactions-data/`.
 *
 * Found by WALKING UP from this module to the first ancestor that actually holds the store,
 * with `process.cwd()` as the fallback. Deliberately existence-driven: the previous version
 * counted directory levels (`dist/<bundle>` → up 1, source → up 3), which is only ever right
 * for the layouts that existed when it was written. It broke the moment a second bundle sat one
 * directory deeper — the desktop app builds to `dist/app/steuer-app.gjs.mjs`, so the up-1 hop
 * landed in `dist/` and the store resolved to `dist/transactions-data`, which does not exist.
 * libgda then refused the connection with "Der DB_DIR-Teil der Verbindungszeichenkette muss auf
 * einen gültigen Ordner verweisen" and the app's whole Steuererklärung view failed to load,
 * while the CLI — one level shallower, so accidentally correct — kept working. The source-form
 * up-3 had rotted the same way when this file moved from `cli/src/lib/` to `packages/store/src/`.
 *
 * Walking up also beats a plain cwd anchor, which was the ORIGINAL bug this arithmetic replaced:
 * the MCP server runs with cwd at the monorepo root, where no store lives.
 *
 * `TRANSACTIONS_DATA_DIR` still overrides everything.
 */
let cachedRoot: string | undefined;

function packageRoot(): string {
  // Memoised: `getStoreDir()` sits under `ledgerDbPath()`, so it runs on EVERY `openLedger()` —
  // at least once per MCP tool call, plus every loadAll/loadAccount/readCursors. The walk costs a
  // stat per ancestor (about a dozen from the source tree), which the arithmetic it replaced did
  // not. A store cannot move mid-process; `TRANSACTIONS_DATA_DIR` is read in `getStoreDir` and
  // stays uncached, so an override still wins without a restart.
  if (cachedRoot !== undefined) return cachedRoot;
  // Falls through to cwd when nothing exists yet — a fresh installation, where the first sync
  // creates the store right there.
  cachedRoot =
    findStoreAncestor(dirname(fileURLToPath(import.meta.url))) ?? findStoreAncestor(process.cwd()) ?? process.cwd();
  return cachedRoot;
}

/** Nearest ancestor of `start` (inclusive) that contains a `transactions-data` directory. Exported for the unit test. */
export function findStoreAncestor(start: string): string | null {
  for (let dir = start, prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    if (existsSync(join(dir, 'transactions-data'))) return dir;
  }
  return null;
}

/** Store directory. Override with TRANSACTIONS_DATA_DIR; default <cli>/transactions-data. */
export function getStoreDir(): string {
  return process.env.TRANSACTIONS_DATA_DIR ?? join(packageRoot(), 'transactions-data');
}

function ensureDir(): string {
  const dir = getStoreDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe NDJSON filename for an account key. */
export function accountFileName(accountKey: string): string {
  return `${accountKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.ndjson`;
}

/**
 * mtime-keyed parse cache. The store is re-read on every searchTransactions / loadAll call
 * (the web cache build, the EÜR aggregation, the MCP tools), so parsing each NDJSON file once
 * per (file, mtime) avoids re-parsing megabytes of JSON repeatedly. Self-invalidating: a write
 * bumps the file mtime; the cached array is never mutated by callers (loadAccount/loadAll copy).
 */
const ndjsonCache = new Map<string, { mtimeMs: number; txs: UnifiedTransaction[] }>();

function readNdjson(file: string): UnifiedTransaction[] {
  if (!existsSync(file)) return [];
  const mtimeMs = statSync(file).mtimeMs;
  const hit = ndjsonCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.txs;
  const out: UnifiedTransaction[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as UnifiedTransaction);
    } catch {
      /* skip malformed line */
    }
  }
  ndjsonCache.set(file, { mtimeMs, txs: out });
  return out;
}

/** Load one account's transactions as a map keyed by dedupeKey. */
export function loadAccount(accountKey: string): Map<string, UnifiedTransaction> {
  const map = new Map<string, UnifiedTransaction>();
  for (const t of readNdjson(join(getStoreDir(), accountFileName(accountKey)))) {
    map.set(dedupeKey(t), t);
  }
  return map;
}

export interface UpsertResult {
  added: number;
  updated: number;
  total: number;
}

/**
 * The import batch currently being written, or null outside one. Set only through
 * {@link withImportBatch}, which always restores the previous value.
 *
 * Ambient rather than a parameter on purpose: an import runs synchronously through six layers of
 * format-specific parsers (CAMT → FinTS statements → normalise → upsert) that have nothing to do
 * with batching, and threading an option through all of them would spread the concept across code
 * that does not own it. The scope function keeps it from leaking.
 */
let currentBatch: string | null = null;

/**
 * Run `fn` with every NEWLY stored transaction stamped as belonging to `batchId`, so a wrong or
 * duplicated import can be taken back afterwards. Restores the previous batch on the way out, even
 * when `fn` throws — a failed import must not leave later writes labelled as part of it.
 */
export function withImportBatch<T>(batchId: string, fn: () => T): T {
  const previous = currentBatch;
  currentBatch = batchId;
  try {
    return fn();
  } finally {
    currentBatch = previous;
  }
}

/** Async counterpart of {@link withImportBatch} — the import path awaits the ledger fold. */
export async function withImportBatchAsync<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  const previous = currentBatch;
  currentBatch = batchId;
  try {
    return await fn();
  } finally {
    currentBatch = previous;
  }
}

/** The batch being written right now, for callers that want to report it. */
export function activeImportBatch(): string | null {
  return currentBatch;
}

/**
 * Merge transactions into an account file (upsert by dedupeKey), sorted oldest→newest.
 *
 * Inside a {@link withImportBatch} scope, only transactions this call genuinely ADDS are stamped
 * with the batch id. An UPDATE to a row an earlier import brought in keeps its original batch —
 * otherwise undoing the newer batch would delete a transaction that existed before it and that
 * nobody asked to remove.
 */
export function upsertAccount(accountKey: string, incoming: UnifiedTransaction[]): UpsertResult {
  ensureDir();
  const map = loadAccount(accountKey);
  let added = 0;
  let updated = 0;
  for (const t of incoming) {
    const k = dedupeKey(t);
    const existing = map.get(k);
    if (existing) {
      updated++;
      // Carry the original batch across the update; the incoming copy has none.
      map.set(k, existing.importBatch ? { ...t, importBatch: existing.importBatch } : t);
      continue;
    }
    added++;
    map.set(k, currentBatch ? { ...t, importBatch: currentBatch } : t);
  }
  const all = [...map.values()].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );
  const file = join(getStoreDir(), accountFileName(accountKey));
  writeFileSync(file, all.map((t) => JSON.stringify(t)).join('\n') + (all.length ? '\n' : ''));
  // Refresh the parse cache with what we just wrote (covers coarse mtime granularity).
  ndjsonCache.set(file, { mtimeMs: statSync(file).mtimeMs, txs: all });
  return { added, updated, total: all.length };
}

/** What one import brought in, for a "was war das?" list before taking it back. */
export interface ImportBatchSummary {
  id: string;
  /** Transactions this import ADDED and that are still stored. */
  count: number;
  /** Account keys it touched. */
  accounts: string[];
  /** Earliest / latest booking date among them (YYYY-MM-DD). */
  firstDate?: string;
  lastDate?: string;
}

/** Every import batch still represented in the store, newest id first. */
export function listImportBatches(): ImportBatchSummary[] {
  const byId = new Map<string, { accounts: Set<string>; dates: string[] }>();
  for (const t of loadAll()) {
    if (!t.importBatch) continue;
    const entry = byId.get(t.importBatch) ?? { accounts: new Set<string>(), dates: [] };
    entry.accounts.add(t.accountKey);
    entry.dates.push(t.bookingDate);
    byId.set(t.importBatch, entry);
  }
  return [...byId.entries()]
    .map(([id, e]) => {
      const dates = e.dates.slice().sort();
      return {
        id,
        count: e.dates.length,
        accounts: [...e.accounts].sort(),
        firstDate: dates[0],
        lastDate: dates.at(-1),
      };
    })
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** What an {@link undoImport} removed, so the caller can clean up derived stores (the ledger). */
export interface UndoImportResult {
  batchId: string;
  /** Unified transaction ids that were removed. */
  ids: string[];
  accounts: string[];
}

/**
 * Remove exactly the transactions a given import ADDED.
 *
 * Rows that the import merely UPDATED are untouched and stay: they existed beforehand, they were
 * never stamped with this batch, and deleting them would destroy data nobody asked to remove. That
 * is the whole reason {@link upsertAccount} stamps adds only.
 *
 * Purely a store operation — it does not touch the SQLite ledger, whose rows are derived. The
 * caller is handed the removed ids so it can clean those up under the GoBD guard, which this layer
 * must not reach for.
 */
export function undoImport(batchId: string): UndoImportResult {
  const dir = getStoreDir();
  const ids: string[] = [];
  const accounts: string[] = [];
  if (!existsSync(dir)) return { batchId, ids, accounts };

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue;
    const file = join(dir, f);
    const all = readNdjson(file);
    const keep = all.filter((t) => t.importBatch !== batchId);
    if (keep.length === all.length) continue; // nothing from this batch in here

    for (const t of all) if (t.importBatch === batchId) ids.push(t.id);
    accounts.push(...new Set(all.filter((t) => t.importBatch === batchId).map((t) => t.accountKey)));
    writeFileSync(file, keep.map((t) => JSON.stringify(t)).join('\n') + (keep.length ? '\n' : ''));
    ndjsonCache.set(file, { mtimeMs: statSync(file).mtimeMs, txs: keep });
  }
  return { batchId, ids, accounts: [...new Set(accounts)].sort() };
}

/** Load every stored transaction across all accounts. */
export function loadAll(): UnifiedTransaction[] {
  const dir = getStoreDir();
  if (!existsSync(dir)) return [];
  const out: UnifiedTransaction[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue;
    out.push(...readNdjson(join(dir, f)));
  }
  return out;
}

/** Per-account sync state. */
export interface AccountCursor {
  accountKey: string;
  source: TxSource;
  /** Latest bookingDate seen so far (YYYY-MM-DD); next sync starts shortly before this. */
  lastBookingDate?: string;
  /** ISO timestamp of the last successful sync. */
  lastSyncedAt?: string;
  /** Stored transaction count after the last sync. */
  count?: number;
}

export function readCursors(): Record<string, AccountCursor> {
  const p = join(getStoreDir(), CURSORS_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, AccountCursor>;
  } catch {
    return {};
  }
}

export function writeCursors(cursors: Record<string, AccountCursor>): void {
  ensureDir();
  writeFileSync(join(getStoreDir(), CURSORS_FILE), `${JSON.stringify(cursors, null, 2)}\n`);
}
