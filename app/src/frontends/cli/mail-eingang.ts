/**
 * `belege mail-*` — Belege aus einem Mail-Ordner holen (Idee 15), eingebautes DMS.
 *
 * `mail-konfig anzeigen|setzen|entfernen` pflegt das Postfach; das Passwort geht nur in den
 * Schlüsselbund (`mail-passwort speichern` liest es von stdin, nie als Argument). `mail-abruf` holt
 * neue Nachrichten und legt PDF- und E-Rechnungs-Anhänge in den Beleg-Eingang; es liest nur und
 * verändert nichts auf dem Server. `mail-status` zeigt Einrichtung und letztes Ergebnis.
 */

import { readFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';
import { belegeAusMailAbrufenFuer, mailEingangStatus, PAPERLESS_HINWEIS } from '../../core/actions/mail-eingang.ts';
import { gioMailConnector } from '../../core/clients/imap/index.ts';
import { loadMailEingang, saveMailEingang } from '../../core/config/index.ts';
import {
    clearMailEingangPassword,
    hasStoredMailEingangPassword,
    storeMailEingangPassword,
} from '../../core/mail/mail-eingang-secret.ts';
import { createPresenterSession } from '../../core/presenters/session.ts';
import { ensureDemoSeeded } from './demo.ts';
import { runAndExit } from './output.ts';

const entityOption = {
    entity: { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' },
} as const;
const jsonOption = { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' } as const;

async function entityId(wanted: unknown): Promise<string> {
    await ensureDemoSeeded();
    const entities = createPresenterSession().workspace.entities;
    const e = wanted ? entities.find((x) => x.id === wanted) : (entities.find((x) => !!x.elster) ?? entities[0]);
    if (!e) throw new Error(wanted ? `Unbekannte Entität '${wanted}'.` : 'Keine Entität in steuererklaerung.json.');
    return e.id;
}

export const mailKonfigModule: CommandModule = {
    command: 'mail-konfig',
    describe: 'Das Postfach für „Belege aus Mail“ einrichten (Passwort: mail-passwort)',
    builder: (y) =>
        y
            .command({
                command: ['anzeigen', '$0'],
                describe: 'Die Einrichtung zeigen (ohne Passwort)',
                builder: (yy) => yy.options(entityOption).option('json', jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const id = await entityId(argv.entity);
                            return mailEingangStatus(id, hasStoredMailEingangPassword(id));
                        },
                        {
                            print: (v) => (argv.json ? console.log(JSON.stringify(v, null, 2)) : printStatus(v)),
                        },
                    ),
            })
            .command({
                command: 'setzen',
                describe: 'Server, Ordner und Filter speichern (nur Angegebenes ändert sich)',
                builder: (yy) =>
                    yy
                        .options(entityOption)
                        .option('server', { type: 'string', describe: 'IMAP-Server' })
                        .option('port', { type: 'number', describe: 'Port (Standard 993)' })
                        .option('sicherheit', {
                            type: 'string',
                            choices: ['tls', 'none'],
                            describe: 'tls · none (nur lokal)',
                        })
                        .option('benutzer', { type: 'string', describe: 'Anmeldename' })
                        .option('ordner', { type: 'string', describe: 'Postfachordner (Standard INBOX)' })
                        .option('absender', {
                            type: 'string',
                            describe: 'Nur Nachrichten, deren Absender das enthält; leer = alle',
                        })
                        .option('beim-start', { type: 'boolean', describe: 'Beim Start der App abrufen' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const id = await entityId(argv.entity);
                            const old = loadMailEingang(id);
                            const host = (argv.server as string | undefined) ?? old?.host;
                            const username = (argv.benutzer as string | undefined) ?? old?.username;
                            if (!host || !username)
                                throw new Error('Server und Benutzer sind nötig: --server … --benutzer …');
                            const next = {
                                host,
                                username,
                                port: (argv.port as number | undefined) ?? old?.port ?? 993,
                                security: ((argv.sicherheit as 'tls' | 'none' | undefined) ??
                                    old?.security ??
                                    'tls') as 'tls' | 'none',
                                folder: (argv.ordner as string | undefined) ?? old?.folder ?? 'INBOX',
                                ...(argv.absender !== undefined
                                    ? (argv.absender as string).trim()
                                        ? { sender: (argv.absender as string).trim() }
                                        : {}
                                    : old?.sender
                                      ? { sender: old.sender }
                                      : {}),
                                ...(argv['beim-start'] !== undefined
                                    ? argv['beim-start']
                                        ? { onStart: true }
                                        : {}
                                    : old?.onStart
                                      ? { onStart: true }
                                      : {}),
                            };
                            saveMailEingang(id, next);
                            return mailEingangStatus(id, hasStoredMailEingangPassword(id));
                        },
                        { print: printStatus },
                    ),
            })
            .command({
                command: 'entfernen',
                describe:
                    'Die Einrichtung löschen (das Passwort bleibt, bis es mit mail-passwort loeschen entfernt wird)',
                builder: (yy) => yy.options(entityOption),
                handler: (argv) =>
                    runAndExit(async () => {
                        saveMailEingang(await entityId(argv.entity), null);
                        return { entfernt: true };
                    }),
            }),
    handler: () => {},
};

export const mailPasswortModule: CommandModule = {
    command: 'mail-passwort',
    describe: 'Das Postfach-Passwort im Schlüsselbund ablegen oder löschen',
    builder: (y) =>
        y
            .command({
                command: 'speichern',
                describe: 'Passwort von stdin lesen und im Schlüsselbund speichern (nie als Argument)',
                builder: (yy) => yy.options(entityOption),
                handler: (argv) =>
                    runAndExit(async () => {
                        const id = await entityId(argv.entity);
                        const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
                        if (!password)
                            throw new Error(
                                'Kein Passwort auf stdin. Beispiel: read -rs p; echo "$p" | steuer belege mail-passwort speichern',
                            );
                        if (!storeMailEingangPassword(id, password)) {
                            throw new Error('Der Schlüsselbund ließ sich nicht erreichen (secret-tool, entsperrt?).');
                        }
                        return { gespeichert: true };
                    }),
            })
            .command({
                command: 'loeschen',
                describe: 'Das gespeicherte Passwort löschen',
                builder: (yy) => yy.options(entityOption),
                handler: (argv) =>
                    runAndExit(async () => {
                        clearMailEingangPassword(await entityId(argv.entity));
                        return { geloescht: true };
                    }),
            }),
    handler: () => {},
};

export const mailAbrufModule: CommandModule = {
    command: 'mail-abruf',
    describe: 'Neue Belege aus dem Mail-Ordner holen (nur lesen; mit Paperless: dort einrichten)',
    builder: (y) =>
        y
            .options(entityOption)
            .option('dry-run', { type: 'boolean', default: false, describe: 'Nur zählen, nichts speichern' })
            .option('json', jsonOption),
    handler: (argv) =>
        runAndExit(
            async () => {
                const id = await entityId(argv.entity);
                return belegeAusMailAbrufenFuer(id, gioMailConnector, { dryRun: argv['dry-run'] === true });
            },
            {
                print: (r) => {
                    if (argv.json) return console.log(JSON.stringify(r, null, 2));
                    if (!r.ok) return console.log(r.meldung);
                    console.log(r.zusammenfassung);
                    for (const b of r.belege)
                        console.log(`  ${b.status === 'neu' ? '+' : '='} ${b.filename}  (${b.sender}, ${b.date})`);
                    for (const f of r.fehler) console.log(`  ! ${f}`);
                },
            },
        ),
};

function printStatus(v: ReturnType<typeof mailEingangStatus>): void {
    if (v.dms === 'paperless') return console.log(PAPERLESS_HINWEIS);
    if (!v.konfiguriert)
        return console.log('Kein Postfach eingerichtet. Einrichten: belege mail-konfig setzen --server … --benutzer …');
    console.log(`Postfach: ${v.host} · Ordner ${v.folder}${v.sender ? ` · Absender „${v.sender}“` : ''}`);
    console.log(`Passwort: ${v.passwortGespeichert ? 'im Schlüsselbund' : 'fehlt (belege mail-passwort speichern)'}`);
    console.log(`Beim Start abrufen: ${v.beimStart ? 'ja' : 'nein'}`);
    console.log(
        v.letzterAbruf
            ? `Letzter Abruf: ${v.letzterAbruf.at ?? '—'} · ${v.letzterAbruf.ergebnis ?? '—'}`
            : 'Noch nie abgerufen.',
    );
}
