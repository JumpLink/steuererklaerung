/**
 * Backups: the copied ledger is a working, consistent database; everything is private; retention
 * deletes only our own, oldest folders. All in temp directories — never the real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    BACKUP_META_FILE,
    type BackupSources,
    createBackup,
    listBackups,
    pruneBackups,
    runConfiguredBackup,
} from '../../../src/core/actions/backup.ts';
import { loadUserSettings, updateUserSettings } from '../../../src/core/config/user-settings.ts';

export default async () => {
    await describe('backup', async () => {
        let dir = '';
        let sources: BackupSources;

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
            const ws = join(dir, 'ws');
            const store = join(ws, 'transactions-data');
            mkdirSync(join(ws, 'invoices', 'qonto'), { recursive: true });
            mkdirSync(store, { recursive: true });
            writeFileSync(join(ws, 'steuererklaerung.json'), '{"version":1,"entities":[]}');
            writeFileSync(join(ws, 'sync-config.json'), '{}');
            writeFileSync(join(ws, 'steuererklaerung.json.bak-2026-01-01T00-00-00-000Z'), '{}');
            writeFileSync(join(ws, '.env'), 'SECRET=1');
            writeFileSync(join(ws, 'unrelated.txt'), 'x');
            writeFileSync(join(ws, 'invoices', 'qonto', 'r1.pdf'), '%PDF-1.4');
            writeFileSync(join(store, 'qonto_muster.ndjson'), '{"id":"t1"}\n');
            // A WAL-mode ledger with rows still in the -wal file: a plain file copy would miss them.
            const db = new DatabaseSync(join(store, 'ledger.db'));
            db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(x INTEGER);');
            db.exec('INSERT INTO t VALUES (1),(2),(3);');
            db.close();
            sources = {
                manifestPath: join(ws, 'steuererklaerung.json'),
                storeDir: store,
                ledgerPath: join(store, 'ledger.db'),
            };
            vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg-config'));
            vi.stubEnv('XDG_DATA_HOME', join(dir, 'xdg-data'));
        });
        afterEach(() => {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('copies manifest, legacy configs, invoices and store — not .env or unrelated files', async () => {
            const { path, meta } = createBackup({
                root: join(dir, 'b'),
                sources,
                now: new Date('2026-10-09T10:00:00Z'),
            });
            expect(path).toBe(join(dir, 'b', '2026-10-09T10-00-00-000Z'));
            for (const f of [
                'config/steuererklaerung.json',
                'config/sync-config.json',
                'config/steuererklaerung.json.bak-2026-01-01T00-00-00-000Z',
                'invoices/qonto/r1.pdf',
                'transactions-data/qonto_muster.ndjson',
                'transactions-data/ledger.db',
                BACKUP_META_FILE,
            ]) {
                expect(existsSync(join(path, f))).toBe(true);
            }
            expect(existsSync(join(path, 'config', '.env'))).toBe(false);
            expect(existsSync(join(path, 'config', 'unrelated.txt'))).toBe(false);
            expect(existsSync(join(path, 'transactions-data', 'ledger.db-wal'))).toBe(false);
            expect(meta.databases).toContain('transactions-data/ledger.db');
        });

        await it('the copied ledger is consistent and complete', async () => {
            const { path } = createBackup({ root: join(dir, 'b'), sources });
            const copy = new DatabaseSync(join(path, 'transactions-data', 'ledger.db'), { readOnly: true });
            const check = copy.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
            const count = copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number };
            copy.close();
            expect(check[0].integrity_check).toBe('ok');
            expect(Number(count.n)).toBe(3);
        });

        await it('directories are 0700 and files 0600', async () => {
            const root = join(dir, 'b');
            const { path } = createBackup({ root, sources });
            expect(statSync(root).mode & 0o777).toBe(0o700);
            expect(statSync(path).mode & 0o777).toBe(0o700);
            expect(statSync(join(path, 'invoices', 'qonto')).mode & 0o777).toBe(0o700);
            expect(statSync(join(path, 'config', 'steuererklaerung.json')).mode & 0o777).toBe(0o600);
            expect(statSync(join(path, 'transactions-data', 'ledger.db')).mode & 0o777).toBe(0o600);
            expect(statSync(join(path, BACKUP_META_FILE)).mode & 0o777).toBe(0o600);
        });

        await it('retention keeps the newest N and never touches foreign folders', async () => {
            const root = join(dir, 'b');
            mkdirSync(join(root, 'meine-fotos'), { recursive: true });
            for (let i = 1; i <= 4; i++) {
                createBackup({ root, sources, keep: 2, now: new Date(`2026-10-0${i}T10:00:00Z`) });
            }
            const names = listBackups(root).map((b) => b.name);
            expect(names.join(',')).toBe('2026-10-04T10-00-00-000Z,2026-10-03T10-00-00-000Z');
            expect(existsSync(join(root, 'meine-fotos'))).toBe(true);
            expect(pruneBackups(root, 1).length).toBe(1);
            expect(listBackups(root).length).toBe(1);
        });

        await it('two backups in the same instant do not collide', async () => {
            const now = new Date('2026-10-09T10:00:00Z');
            const a = createBackup({ root: join(dir, 'b'), sources, now });
            const b = createBackup({ root: join(dir, 'b'), sources, now });
            expect(a.path === b.path).toBe(false);
            expect(listBackups(join(dir, 'b')).length).toBe(2);
        });

        await it('refuses a target inside the copied store', async () => {
            expect(() => createBackup({ root: join(sources.storeDir, 'backups'), sources })).toThrow();
            expect(existsSync(join(sources.storeDir, 'backups'))).toBe(false);
        });

        await it('a fresh installation (nothing there yet) still produces a valid, empty backup', async () => {
            const empty: BackupSources = {
                manifestPath: join(dir, 'nothing', 'steuererklaerung.json'),
                storeDir: join(dir, 'nothing', 'transactions-data'),
                ledgerPath: join(dir, 'nothing', 'transactions-data', 'ledger.db'),
            };
            const { meta } = createBackup({ root: join(dir, 'b'), sources: empty });
            expect(meta.files.length).toBe(0);
            expect(existsSync(join(dir, 'nothing'))).toBe(false);
        });

        await it('runConfiguredBackup uses the settings and records the result', async () => {
            const root = join(dir, 'chosen');
            updateUserSettings((s) => {
                s.backup.dir = root;
                s.backup.keep = 1;
            });
            const prev = {
                ws: process.env.STEUER_WORKSPACE,
                td: process.env.TRANSACTIONS_DATA_DIR,
                lp: process.env.LEDGER_DB_PATH,
            };
            vi.stubEnv('STEUER_WORKSPACE', sources.manifestPath);
            vi.stubEnv('TRANSACTIONS_DATA_DIR', sources.storeDir);
            vi.stubEnv('LEDGER_DB_PATH', sources.ledgerPath);
            try {
                runConfiguredBackup({ now: new Date('2026-10-01T00:00:00Z') });
                const r = runConfiguredBackup({ now: new Date('2026-10-02T00:00:00Z') });
                const s = loadUserSettings();
                expect(s.backup.lastPath).toBe(r.path);
                expect(s.backup.lastAt).toBe('2026-10-02T00:00:00.000Z');
                expect(listBackups(root).length).toBe(1);
                expect(JSON.parse(readFileSync(join(r.path, BACKUP_META_FILE), 'utf-8')).reason).toBe('manual');
            } finally {
                vi.stubEnv('STEUER_WORKSPACE', prev.ws);
                vi.stubEnv('TRANSACTIONS_DATA_DIR', prev.td);
                vi.stubEnv('LEDGER_DB_PATH', prev.lp);
            }
        });
    });
};
