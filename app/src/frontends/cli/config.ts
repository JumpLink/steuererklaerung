/**
 * `config` CLI: manage the consolidated `steuererklaerung.json` v1 manifest.
 *
 *   config init --name <name>                 Create the FIRST manifest (id derived from the name).
 *   config add-entity --name <name>           Add another entity to an existing manifest.
 *   config rename-entity <id> [--new-id …]    Change an entity's id / name / kind / accounts.
 *   config remove-entity <id>                 Un-list an entity (GoBD-guarded; data is kept).
 *   config migrate [--dry-run] [--now <ts>]   Assemble the manifest from the 7 legacy config files.
 *   config validate                           Schema-validate the manifest, report problems.
 *   config show [--entity <id>]               Print the resolved config (secrets redacted).
 *
 * `migrate` NEVER modifies/deletes any source config file — it only READS them and writes the new
 * manifest under the SAME filename + a timestamped `.bak` of the previous registry. Run `config migrate --dry-run`
 * first to preview the assembled manifest + mapping without writing anything.
 */

import { basename, dirname } from 'node:path';
import type { CommandModule } from 'yargs';

import {
    getManifestPath,
    loadManifest,
    migrateConfig,
    type MigrateResult,
    readApp,
    readFints,
    readPaperless,
    redactSecrets,
    resolveEntities,
    resolveEntity,
    slugFromName,
} from '../../core/config/index.ts';
import { addEntity, initWorkspace, removeEntity, updateEntity } from '../../core/actions/entities.ts';
import { pickArgv, printJson, runAndExit } from './output.ts';

/** Summary printed after any registry change: which file, and who is in it now. */
function printRegistry(manifest: { entities: Array<{ id: string; name: string; kind: string }> }): void {
    console.log(`Manifest: ${getManifestPath()}`);
    for (const e of manifest.entities) console.log(`  ${e.id}  ${e.name}  (${e.kind})`);
}

/** `--accounts "camt:*,qonto:123*"` → the glob list; absent/blank yields undefined (schema default). */
function parseAccounts(raw: string | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    const list = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return list.length ? list : [];
}

/** Filename-safe timestamp for the backup file (2026-07-15T12-30-00-000Z → …T12-30-00-000Z). */
function formatNow(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

function printMigrateResult(result: MigrateResult): void {
    if (result.alreadyV1) {
        console.log(`${result.manifestPath} ist bereits ein v1-Manifest — nichts zu tun.`);
        for (const w of result.warnings) console.log(`  Hinweis: ${w}`);
        return;
    }
    const m = result.mapping;
    console.log(
        result.dryRun ? '── Testlauf (--dry-run): Manifest-Zusammenführung ──' : '── Konfiguration zusammengeführt ──',
    );
    if (m) {
        console.log(`  paperless   ← ${m.paperless ?? '(keine sync-config.json)'}`);
        console.log(`  fints       ← ${m.fints ?? '(keine fints-config.json)'}`);
        console.log(`  app         ← ${m.app ? 'assistant + mcp' : '(keine assistant/mcp-Einstellungen)'}`);
        for (const e of m.entities) {
            const parts = [
                e.elster ? `elster ← ${e.elster}` : null,
                e.est ? `est ← ${e.est}` : null,
                e.recurring ? `recurring ← ${e.recurring} Eintrag/Einträge` : null,
            ].filter(Boolean);
            console.log(`  entity ${e.id}: ${parts.length ? parts.join(', ') : '(keine Alt-Configs)'}`);
        }
        console.log(`  recurring gesamt: ${m.recurringTotal}`);
    }
    for (const w of result.warnings) console.log(`  Hinweis: ${w}`);

    if (result.dryRun) {
        console.log('\n── Zusammengeführtes Manifest (Vorschau) ──');
        console.log(JSON.stringify(result.manifest, null, 2));
        console.log('\nTestlauf: es wurde NICHTS geschrieben.');
        return;
    }
    console.log(`\nNeues Manifest geschrieben: ${result.manifestPath}`);
    if (result.backupPath) console.log(`Backup der alten Registry: ${result.backupPath}`);
    console.log('Die alten Config-Dateien wurden NICHT gelöscht (bleiben als Backup liegen).');
}

export const configCommand: CommandModule = {
    command: 'config',
    describe: 'Konsolidiertes steuererklaerung.json v1 Manifest: migrate, validate, show',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(
                1,
                'Unterkommando wählen: init, add-entity, rename-entity, remove-entity, migrate, validate, show',
            )
            .command({
                command: 'init',
                describe: 'Die erste Konfiguration anlegen (bricht ab, wenn schon eine existiert)',
                builder: (y) =>
                    y
                        .option('name', { type: 'string', demandOption: true, describe: 'Anzeigename der Entität' })
                        .option('id', {
                            type: 'string',
                            describe:
                                'Kurz-Id (Kleinbuchstaben/Ziffern/Bindestrich). Standard: aus dem Namen abgeleitet, z. B. „Muster GbR" → „muster-gbr"',
                        })
                        .option('kind', {
                            type: 'string',
                            default: 'einzelunternehmen',
                            describe: 'Art: gbr · einzelunternehmen · privat · …',
                        })
                        .option('accounts', {
                            type: 'string',
                            describe: 'Kontoschlüssel-Globs, kommagetrennt (z. B. „camt:*,qonto:012345*")',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const name = String(pickArgv<string>(raw, 'name'));
                    const input = {
                        // Same derivation the setup assistant uses — one rule, so a firm created
                        // here and one created there get the same id.
                        id: pickArgv<string>(raw, 'id') ?? slugFromName(name),
                        name,
                        kind: pickArgv<string>(raw, 'kind'),
                        accounts: parseAccounts(pickArgv<string>(raw, 'accounts')),
                    };
                    runAndExit(async () => initWorkspace(input), {
                        print: (m) => {
                            console.log('Konfiguration angelegt.');
                            printRegistry(m);
                        },
                    });
                },
            })
            .command({
                command: 'add-entity',
                describe: 'Eine weitere Entität in das bestehende Manifest aufnehmen',
                builder: (y) =>
                    y
                        .option('name', { type: 'string', demandOption: true, describe: 'Anzeigename' })
                        .option('id', { type: 'string', describe: 'Kurz-Id (Standard: aus dem Namen abgeleitet)' })
                        .option('kind', { type: 'string', default: 'einzelunternehmen', describe: 'Art' })
                        .option('accounts', { type: 'string', describe: 'Kontoschlüssel-Globs, kommagetrennt' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const name = String(pickArgv<string>(raw, 'name'));
                    const input = {
                        id: pickArgv<string>(raw, 'id') ?? slugFromName(name),
                        name,
                        kind: pickArgv<string>(raw, 'kind'),
                        accounts: parseAccounts(pickArgv<string>(raw, 'accounts')),
                    };
                    runAndExit(async () => addEntity(input), {
                        print: (m) => {
                            console.log(`Entität „${input.id}" angelegt.`);
                            printRegistry(m);
                        },
                    });
                },
            })
            .command({
                command: 'rename-entity <id>',
                describe: 'Id, Name, Art oder Kontozuordnung einer Entität ändern',
                builder: (y) =>
                    y
                        .positional('id', { type: 'string', describe: 'Bisherige Id der Entität' })
                        .option('new-id', { type: 'string', describe: 'Neue Id (nur bei noch ungenutzter Entität)' })
                        .option('name', { type: 'string', describe: 'Neuer Anzeigename' })
                        .option('kind', { type: 'string', describe: 'Neue Art' })
                        .option('accounts', { type: 'string', describe: 'Neue Kontoschlüssel-Globs, kommagetrennt' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const id = String(pickArgv<string>(raw, 'id'));
                    const patch = {
                        id: pickArgv<string>(raw, 'newId', 'new-id'),
                        name: pickArgv<string>(raw, 'name'),
                        kind: pickArgv<string>(raw, 'kind'),
                        accounts: parseAccounts(pickArgv<string>(raw, 'accounts')),
                    };
                    runAndExit(async () => updateEntity(id, patch), {
                        print: (m) => {
                            console.log(`Entität „${id}" geändert.`);
                            printRegistry(m);
                        },
                    });
                },
            })
            .command({
                command: 'remove-entity <id>',
                describe: 'Eine Entität aus der Registry nehmen (Daten bleiben erhalten; GoBD-geschützt)',
                builder: (y) => y.positional('id', { type: 'string', describe: 'Id der Entität' }),
                handler: (argv) => {
                    const id = String(pickArgv<string>(argv as Record<string, unknown>, 'id'));
                    runAndExit(async () => removeEntity(id), {
                        print: (m) => {
                            console.log(`Entität „${id}" entfernt. Buchungen, Belege und Abgaben bleiben erhalten.`);
                            printRegistry(m);
                        },
                    });
                },
            })
            .command({
                command: 'migrate',
                describe:
                    'Die 7 Alt-Config-Dateien zu einem steuererklaerung.json v1 zusammenführen (Quelldateien bleiben unangetastet)',
                builder: (y) =>
                    y
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Nur Vorschau (Manifest + Zuordnung) ausgeben, NICHTS schreiben',
                        })
                        .option('now', {
                            type: 'string',
                            describe:
                                'Zeitstempel für den Backup-Dateinamen (Standard: aktuelle Zeit) — für reproduzierbare Läufe',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const dryRun = !!pickArgv<boolean>(raw, 'dryRun', 'dry-run');
                    const now = pickArgv<string>(raw, 'now') ?? formatNow(new Date());
                    // Migrate the file the resolver actually found — under the rename fallback that
                    // is still `buchhaltung.json`, and migrating must not fork a second registry.
                    const manifestPath = getManifestPath();
                    const dir = dirname(manifestPath);
                    const registryFile = basename(manifestPath);
                    runAndExit(async () => migrateConfig({ dir, now, dryRun, registryFile }), {
                        print: printMigrateResult,
                    });
                },
            })
            .command({
                command: 'validate',
                describe: 'Das steuererklaerung.json v1 Manifest laden + schema-validieren, Probleme melden',
                handler: () => {
                    runAndExit(
                        async () => {
                            const manifest = loadManifest();
                            return {
                                valid: true,
                                path: getManifestPath(),
                                version: manifest.version,
                                entities: manifest.entities.map((e) => ({
                                    id: e.id,
                                    kind: e.kind,
                                    elster: !!e.elster,
                                    est: !!e.est,
                                    recurring: e.recurring?.length ?? 0,
                                })),
                                sections: {
                                    app: !!manifest.app,
                                    paperless: !!manifest.paperless,
                                    fints: !!manifest.fints,
                                },
                            };
                        },
                        { print: printJson },
                    );
                },
            })
            .command({
                command: 'show',
                describe: 'Die aufgelöste Konfiguration ausgeben (Secrets redigiert)',
                builder: (y) =>
                    y.option('entity', {
                        type: 'string',
                        describe: 'Nur diese Entität auflösen (Standard: gesamtes Manifest)',
                    }),
                handler: (argv) => {
                    const entityId = pickArgv<string>(argv as Record<string, unknown>, 'entity');
                    runAndExit(
                        async () => {
                            const manifest = loadManifest();
                            if (entityId) return redactSecrets(resolveEntity(manifest, entityId));
                            return redactSecrets({
                                version: manifest.version,
                                app: readApp(manifest),
                                paperless: readPaperless(manifest),
                                fints: readFints(manifest),
                                entities: resolveEntities(manifest),
                            });
                        },
                        { print: printJson },
                    );
                },
            }),
};
