/**
 * Backups of everything this app keeps locally — so a broken disk, a bad migration or a slip in a
 * terminal costs one restore instead of a tax year.
 *
 * What is copied:
 *
 *   - the manifest (whatever name it was resolved under — `buchhaltung.json` on an installation
 *     from before the rename), the pre-v1 config files beside it and their `*.bak-*` copies;
 *   - `invoices/` beside the manifest (downloaded supplier invoices);
 *   - the transaction store (`transactions-data/`) — NDJSON files as they are, every SQLite
 *     database through SQLite itself.
 *
 * Not copied: `.env` (secrets belong in a password manager, not in a second plain-text copy), ERiC
 * and its generated XML, `fints-data/`.
 *
 * The ledger is the reason this is not a plain recursive copy. It runs in WAL mode and may be open
 * in the app, the CLI and the MCP server at the same time; a file copy can catch `ledger.db` and its
 * `-wal` in two different states and produce a database that opens but is missing the last hour of
 * work. `VACUUM INTO` writes a consistent snapshot through SQLite's own read transaction instead,
 * and the copy is then checked with `PRAGMA integrity_check` before the backup counts as done.
 * (`node:sqlite`'s `backup()` would be the other way; gjsify's `@gjsify/sqlite` does not offer it.)
 *
 * Each backup is a folder `<root>/<timestamp>/` with a `backup.json` describing it, written under a
 * `.partial` name and renamed only once complete, so an interrupted run never looks like a backup.
 * Folders are 0700 and files 0600: a backup holds the same Steuernummern and bank data as the
 * original. Retention deletes only folders that carry our `backup.json`, never anything else the
 * person keeps in that directory.
 *
 * Restoring is deliberately manual (see `docs/app/backup.md`): copying a backup over live data is
 * the one operation where a wrong click loses the newer state, so the app does not offer it.
 */

import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getStoreDir, ledgerDbPath } from '@steuererklaerung/store';
import { getManifestPath, LEGACY_MANIFEST_FILENAME, MANIFEST_FILENAME } from '../config/manifest.ts';
import { setBeforeMigrationWrite } from '../config/migrate-forward.ts';
import { defaultBackupRoot, loadUserSettings, updateUserSettings, type UserSettings } from '../config/user-settings.ts';

/** Marks a folder as one of ours — retention never touches a folder without it. */
export const BACKUP_KIND = 'steuererklaerung-backup';
export const BACKUP_META_FILE = 'backup.json';
const PARTIAL_SUFFIX = '.partial';

/** Config files that may sit beside the manifest — the pre-v1 split configs. */
const LEGACY_CONFIG_PATTERNS: readonly RegExp[] = [
    /^sync-config\.json$/,
    /^fints-config\.json$/,
    /^recurring-invoices\.json$/,
    /^elster-config.*\.json$/,
    /^est-config.*\.json$/,
];

/** SQLite's sidecar files — never copied; the database itself goes through VACUUM INTO. */
const SQLITE_SIDECAR = /\.db-(wal|shm|journal)$/;

export interface BackupSources {
    /** The resolved manifest path; it need not exist (a fresh installation). */
    manifestPath: string;
    /** The transaction store directory. */
    storeDir: string;
    /** The ledger database. */
    ledgerPath: string;
}

/** Where the data lives right now, resolved the same way every other command resolves it. */
export function currentBackupSources(): BackupSources {
    return { manifestPath: getManifestPath(), storeDir: getStoreDir(), ledgerPath: ledgerDbPath() };
}

export interface CreateBackupOptions {
    /** Folder that receives `<timestamp>/`. */
    root: string;
    /** Keep the newest N backups in `root` afterwards; unset = keep all. */
    keep?: number;
    /** Injected clock, for deterministic tests. */
    now?: Date;
    /** Why — `manual`, `before-migration`, …; recorded in `backup.json`. */
    reason?: string;
    sources?: BackupSources;
}

export interface BackupMeta {
    kind: typeof BACKUP_KIND;
    version: 1;
    createdAt: string;
    reason: string;
    sources: BackupSources & { invoicesDir: string | null };
    /** Paths inside the backup, relative to its folder. */
    files: string[];
    /** SQLite databases copied via VACUUM INTO, each verified with integrity_check. */
    databases: string[];
    bytes: number;
}

export interface BackupResult {
    path: string;
    meta: BackupMeta;
    /** Older backups deleted by retention. */
    removed: string[];
}

export interface BackupInfo {
    path: string;
    name: string;
    createdAt: string;
    reason: string;
    files: number;
    bytes: number;
}

/** Filename-safe, lexicographically sortable timestamp: 2026-10-09T12-30-00-000Z. */
export function backupStamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

function isInside(child: string, parent: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

function ensurePrivateDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
}

function copyPrivateFile(src: string, dest: string): number {
    copyFileSync(src, dest);
    chmodSync(dest, 0o600);
    return statSync(dest).size;
}

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Snapshot one SQLite database into `dest` and verify the copy. Opens the source read-only, so a
 * backup can never create or alter a database.
 */
export function snapshotDatabase(src: string, dest: string): void {
    const source = new DatabaseSync(src, { readOnly: true, timeout: 5000 });
    try {
        source.exec(`VACUUM INTO ${sqlString(dest)}`);
    } finally {
        source.close();
    }
    chmodSync(dest, 0o600);
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
        const rows = copy.prepare('PRAGMA integrity_check').all() as { integrity_check?: unknown }[];
        const verdict = rows.map((r) => String(r.integrity_check)).join('; ');
        if (verdict !== 'ok') throw new Error(`Integritätsprüfung der Kopie ${dest} fehlgeschlagen: ${verdict}`);
    } finally {
        copy.close();
    }
}

interface Collector {
    files: string[];
    databases: string[];
    bytes: number;
}

/** Copy `srcDir` into `destDir`; regular files as they are, `*.db` via {@link snapshotDatabase}. */
function copyTree(srcDir: string, destDir: string, backupDir: string, out: Collector): void {
    ensurePrivateDir(destDir);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        const src = join(srcDir, entry.name);
        const dest = join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyTree(src, dest, backupDir, out);
        } else if (entry.isFile()) {
            if (SQLITE_SIDECAR.test(entry.name)) continue;
            if (entry.name.endsWith('.db')) {
                snapshotDatabase(src, dest);
                out.databases.push(relative(backupDir, dest));
                out.bytes += statSync(dest).size;
            } else {
                out.bytes += copyPrivateFile(src, dest);
            }
            out.files.push(relative(backupDir, dest));
        }
        // Symlinks and special files are skipped: following a link out of the data directory would
        // copy something the person never put there.
    }
}

/** Write a complete backup into `<root>/<timestamp>/`, then apply retention. */
export function createBackup(opts: CreateBackupOptions): BackupResult {
    const now = opts.now ?? new Date();
    const sources = opts.sources ?? currentBackupSources();
    const root = resolve(opts.root);
    const manifestDir = dirname(sources.manifestPath);
    const invoicesDir = join(manifestDir, 'invoices');
    const hasInvoices = existsSync(invoicesDir) && statSync(invoicesDir).isDirectory();

    // A backup folder inside a copied tree would copy itself into the next backup, forever.
    for (const tree of [sources.storeDir, hasInvoices ? invoicesDir : null]) {
        if (tree && isInside(root, tree)) {
            throw new Error(`Der Sicherungsordner ${root} liegt innerhalb von ${tree} — bitte einen anderen wählen.`);
        }
    }

    ensurePrivateDir(root);
    let name = backupStamp(now);
    for (let n = 2; existsSync(join(root, name)) || existsSync(join(root, name + PARTIAL_SUFFIX)); n++) {
        name = `${backupStamp(now)}-${n}`;
    }
    const finalDir = join(root, name);
    const work = finalDir + PARTIAL_SUFFIX;
    ensurePrivateDir(work);

    const out: Collector = { files: [], databases: [], bytes: 0 };
    try {
        // 1. Manifest + legacy configs + their migration copies.
        const configDir = join(work, 'config');
        const configNames = new Set<string>();
        if (existsSync(sources.manifestPath)) configNames.add(basename(sources.manifestPath));
        if (existsSync(manifestDir)) {
            for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                const n = entry.name;
                const isManifestName = n === MANIFEST_FILENAME || n === LEGACY_MANIFEST_FILENAME;
                const isMigrationCopy = /\.json\.bak-/.test(n);
                if (isManifestName || isMigrationCopy || LEGACY_CONFIG_PATTERNS.some((re) => re.test(n))) {
                    configNames.add(n);
                }
            }
        }
        if (configNames.size > 0) {
            ensurePrivateDir(configDir);
            for (const n of [...configNames].sort()) {
                out.bytes += copyPrivateFile(join(manifestDir, n), join(configDir, n));
                out.files.push(join('config', n));
            }
        }

        // 2. Downloaded invoices.
        if (hasInvoices) copyTree(invoicesDir, join(work, 'invoices'), work, out);

        // 3. The store, with every database snapshotted.
        if (existsSync(sources.storeDir)) copyTree(sources.storeDir, join(work, 'transactions-data'), work, out);

        // 4. A ledger kept OUTSIDE the store (LEDGER_DB_PATH) is not covered by step 3.
        if (existsSync(sources.ledgerPath) && !isInside(sources.ledgerPath, sources.storeDir)) {
            const dest = join(work, 'ledger.db');
            snapshotDatabase(sources.ledgerPath, dest);
            out.files.push('ledger.db');
            out.databases.push('ledger.db');
            out.bytes += statSync(dest).size;
        }

        const meta: BackupMeta = {
            kind: BACKUP_KIND,
            version: 1,
            createdAt: now.toISOString(),
            reason: opts.reason ?? 'manual',
            sources: { ...sources, invoicesDir: hasInvoices ? invoicesDir : null },
            files: out.files,
            databases: out.databases,
            bytes: out.bytes,
        };
        writeFileSync(join(work, BACKUP_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
        chmodSync(join(work, BACKUP_META_FILE), 0o600);
        renameSync(work, finalDir);

        const removed = opts.keep ? pruneBackups(root, opts.keep) : [];
        return { path: finalDir, meta, removed };
    } catch (err) {
        // Only the folder this call created — and only while it still carries the partial name.
        rmSync(work, { recursive: true, force: true });
        throw err;
    }
}

function readMeta(dir: string): BackupMeta | null {
    try {
        const meta = JSON.parse(readFileSync(join(dir, BACKUP_META_FILE), 'utf-8')) as BackupMeta;
        return meta?.kind === BACKUP_KIND ? meta : null;
    } catch {
        return null;
    }
}

/** Our backups in `root`, newest first. Anything without our `backup.json` is ignored. */
export function listBackups(root: string): BackupInfo[] {
    if (!existsSync(root)) return [];
    const result: BackupInfo[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.endsWith(PARTIAL_SUFFIX)) continue;
        const path = join(root, entry.name);
        const meta = readMeta(path);
        if (!meta) continue;
        result.push({
            path,
            name: entry.name,
            createdAt: meta.createdAt,
            reason: meta.reason,
            files: meta.files.length,
            bytes: meta.bytes,
        });
    }
    return result.sort((a, b) =>
        a.createdAt === b.createdAt ? b.name.localeCompare(a.name) : b.createdAt.localeCompare(a.createdAt),
    );
}

/** Delete all but the newest `keep` backups in `root`. Returns the deleted paths. */
export function pruneBackups(root: string, keep: number): string[] {
    if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep muss eine ganze Zahl ≥ 1 sein (war ${keep}).`);
    const removed: string[] = [];
    for (const old of listBackups(root).slice(keep)) {
        rmSync(old.path, { recursive: true, force: true });
        removed.push(old.path);
    }
    return removed;
}

/** The backup folder from the person's settings, or the default. */
export function configuredBackupRoot(settings: UserSettings = loadUserSettings()): string {
    return settings.backup.dir ?? defaultBackupRoot();
}

/**
 * "Back up now", as the app and `steuer backup create` mean it: the configured folder and
 * retention, and the result recorded in the settings for the Settings page to show.
 */
export function runConfiguredBackup(
    opts: { reason?: string; now?: Date; root?: string; keep?: number } = {},
): BackupResult {
    const settings = loadUserSettings();
    const result = createBackup({
        root: opts.root ?? configuredBackupRoot(settings),
        keep: opts.keep ?? settings.backup.keep,
        now: opts.now,
        reason: opts.reason,
    });
    updateUserSettings((s) => {
        s.backup.lastAt = result.meta.createdAt;
        s.backup.lastPath = result.path;
    });
    return result;
}

/**
 * Take a full backup before any migration rewrites the manifest. Installed once at process entry
 * by the CLI and the desktop app; a failed backup aborts the migration, because migrating without
 * the safety net the person was promised is worse than not migrating.
 */
export function installMigrationBackup(): void {
    setBeforeMigrationWrite((path) => {
        const r = runConfiguredBackup({ reason: 'before-migration' });
        console.error(`[backup] Vor der Migration von ${basename(path)} gesichert: ${r.path}`);
    });
}
