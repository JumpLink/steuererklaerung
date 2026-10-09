/**
 * `backup` — create and list local backups (manifest, legacy configs, invoices, transaction store,
 * ledger via a consistent SQLite snapshot). Restoring is manual on purpose: see `docs/app/backup.md`.
 */

import type { CommandModule } from 'yargs';
import {
    configuredBackupRoot,
    listBackups,
    runConfiguredBackup,
    type BackupInfo,
    type BackupResult,
} from '../../core/actions/backup.ts';
import { pickArgv, runAndExit } from './output.ts';

function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function printCreated(r: BackupResult): void {
    console.log(`Sicherung angelegt: ${r.path}`);
    console.log(
        `  ${r.meta.files.length} Dateien, ${size(r.meta.bytes)}; Datenbanken geprüft: ${r.meta.databases.length}`,
    );
    for (const p of r.removed) console.log(`  ältere Sicherung entfernt: ${p}`);
}

function printList(root: string, list: BackupInfo[]): void {
    if (list.length === 0) {
        console.log(`Keine Sicherungen in ${root}.`);
        return;
    }
    console.log(`Sicherungen in ${root} (neueste zuerst):`);
    for (const b of list) console.log(`  ${b.name}  ${b.reason}  ${b.files} Dateien, ${size(b.bytes)}`);
}

export const backupCommand: CommandModule = {
    command: 'backup',
    describe: 'Lokale Sicherungen anlegen und auflisten (Wiederherstellen: siehe docs/app/backup.md)',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Unterkommando wählen: create, list')
            .command({
                command: 'create',
                describe: 'Jetzt sichern: Manifest, Alt-Configs, Rechnungen, Buchungsdaten, Ledger',
                builder: (y) =>
                    y
                        .option('dir', {
                            type: 'string',
                            describe: 'Zielordner (Standard: aus den Einstellungen bzw. XDG_DATA_HOME)',
                        })
                        .option('keep', { type: 'number', describe: 'Nur die neuesten N Sicherungen behalten' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const root = pickArgv<string>(raw, 'dir');
                    const keep = pickArgv<number>(raw, 'keep');
                    const json = !!pickArgv<boolean>(raw, 'json');
                    runAndExit(async () => runConfiguredBackup({ root, keep }), json ? {} : { print: printCreated });
                },
            })
            .command({
                command: 'list',
                describe: 'Vorhandene Sicherungen auflisten',
                builder: (y) =>
                    y
                        .option('dir', { type: 'string', describe: 'Ordner (Standard: aus den Einstellungen)' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const root = pickArgv<string>(raw, 'dir') ?? configuredBackupRoot();
                    const json = !!pickArgv<boolean>(raw, 'json');
                    runAndExit(async () => listBackups(root), json ? {} : { print: (l) => printList(root, l) });
                },
            }),
};
