/**
 * `time` — time tracking for customer projects.
 *
 *   time start --project Nordwerk --description "Cookie-Banner"  # start the timer
 *     (--project: a project of `projects list` by id or name, or a free label)
 *   time stop                                                    # stop the running timer
 *   time status                                                  # is anything running?
 *   time add --project Nordwerk --from "2026-08-12 14:00" --to "2026-08-12 16:30"
 *   time list [--from 2026-08-01] [--unbilled] [--json]
 *   time report [--from …] [--to …] [--unbilled]                 # totals per project
 *   time import --file ~/Dokumente/TimeTracker/time-tracker.csv  # the old tracker
 *
 * An entry counts as billed once it sits on an invoice (`--unbilled` filters on that) —
 * there is no separate "billed" checkbox that somebody would have to maintain.
 */

import type { CommandModule } from 'yargs';
import type { TimeEntry } from '@steuererklaerung/store';
import {
    addTimeEntry,
    contactNames,
    currentTracking,
    customerContacts,
    findTimeEntry,
    formatDuration,
    importTimeRows,
    listTime,
    matchProjectToContact,
    parseLegacyTimeCsv,
    removeTimeEntry,
    resolveTimeProject,
    startTracking,
    stopTracking,
    timeSummary,
    toHours,
    updateTimeEntry,
} from '../../core/actions/time.ts';
import { listProjects, matchProjectByName } from '../../core/actions/projects.ts';
import { createInvoiceFromTime } from '../../core/actions/time-invoice.ts';
import { defaultEntityFor, requireEntity } from '../../core/config/entities.ts';
import { loadManifest } from '../../core/config/index.ts';

/** `--entity` omitted falls back to the manifest's default business entity. */
function resolveEntityId(entityArg: string | undefined): string {
    const manifest = loadManifest();
    const entity = entityArg ? requireEntity(manifest, entityArg) : defaultEntityFor(manifest);
    return entity.id;
}

/**
 * Accept both a plain local timestamp ("2026-08-12 14:00") and a full ISO string.
 *
 * A bare local string is parsed in the machine's timezone — that is what somebody typing "14:00"
 * means. We store the resulting instant as ISO/UTC.
 */
function parseWhen(value: string, label: string): string {
    const ms = Date.parse(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') : value);
    if (Number.isNaN(ms)) throw new Error(`${label} ist kein gültiger Zeitpunkt: ${value}`);
    return new Date(ms).toISOString();
}

function localDateTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function printEntry(e: TimeEntry, names: Map<string, string>): void {
    const dur = e.durationSeconds === null ? 'läuft…' : formatDuration(e.durationSeconds);
    const who = e.contactId ? (names.get(e.contactId) ?? e.contactId) : '—';
    const flags = [e.invoiceId ? `abgerechnet:${e.invoiceId}` : null, e.billable ? null : 'nicht abrechenbar']
        .filter(Boolean)
        .join(', ');
    console.log(`  ${localDateTime(e.startedAt)}  ${dur.padStart(9)}  ${e.project}${flags ? `  (${flags})` : ''}`);
    if (e.description) console.log(`        ${e.description}`);
    console.log(`        ${who}   ${e.id}`);
}

export const timeCommand: CommandModule = {
    command: 'time',
    describe: 'Zeiterfassung: Timer starten/stoppen, Zeiten erfassen, auswerten, importieren',
    builder: (yargs) =>
        yargs
            .option('entity', { type: 'string', describe: 'Entity-Id (Vorgabe: erste Geschäfts-Entity)' })
            .command({
                command: 'start',
                describe: 'Timer starten',
                builder: (y) =>
                    y
                        .option('project', { type: 'string', demandOption: true, describe: 'Projekt/Engagement' })
                        .option('description', { type: 'string', describe: 'Woran wird gearbeitet?' })
                        .option('contact', { type: 'string', describe: 'Kontakt-Id des Kunden' })
                        .option('at', { type: 'string', describe: 'Startzeit, falls nachgetragen' })
                        .option('billable', {
                            type: 'boolean',
                            default: true,
                            describe: 'Abrechenbar; --no-billable fuer interne Arbeit',
                        }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const target = resolveTimeProject(
                        entityId,
                        argv.project as string,
                        argv.contact as string | undefined,
                    );
                    const entry = startTracking({
                        entityId,
                        ...target,
                        description: (argv.description as string | undefined) ?? null,
                        startedAt: argv.at ? parseWhen(argv.at as string, '--at') : undefined,
                        billable: argv.billable !== false,
                    });
                    console.log(`Timer läuft: ${entry.project} seit ${localDateTime(entry.startedAt)}  (${entry.id})`);
                },
            })
            .command({
                command: 'stop',
                describe: 'Laufenden Timer beenden',
                builder: (y) => y.option('at', { type: 'string', describe: 'Endzeit, falls nachgetragen' }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const entry = stopTracking(
                        entityId,
                        undefined,
                        argv.at ? parseWhen(argv.at as string, '--at') : undefined,
                    );
                    console.log(
                        `Gestoppt: ${entry.project}  ${formatDuration(entry.durationSeconds ?? 0)}  (${toHours(entry.durationSeconds ?? 0)} h)`,
                    );
                },
            })
            .command({
                command: 'status',
                describe: 'Läuft gerade ein Timer?',
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const entry = currentTracking(entityId);
                    if (!entry) {
                        console.log('Kein Timer aktiv.');
                        return;
                    }
                    const running = Math.round((Date.now() - Date.parse(entry.startedAt)) / 1000);
                    console.log(`${entry.project} — ${formatDuration(running)} seit ${localDateTime(entry.startedAt)}`);
                    if (entry.description) console.log(`  ${entry.description}`);
                },
            })
            .command({
                command: 'add',
                describe: 'Abgeschlossene Zeit nachtragen',
                builder: (y) =>
                    y
                        .option('project', { type: 'string', demandOption: true })
                        .option('from', { type: 'string', demandOption: true, describe: 'Beginn' })
                        .option('to', { type: 'string', demandOption: true, describe: 'Ende' })
                        .option('description', { type: 'string' })
                        .option('contact', { type: 'string', describe: 'Kontakt-Id des Kunden' })
                        .option('source', {
                            type: 'string',
                            choices: ['manual', 'reconstructed'],
                            default: 'manual',
                            describe: '„reconstructed" kennzeichnet eine Schätzung, keine Messung',
                        })
                        .option('note', { type: 'string' })
                        .option('billable', {
                            type: 'boolean',
                            default: true,
                            describe: 'Abrechenbar; --no-billable fuer interne Arbeit',
                        }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const target = resolveTimeProject(
                        entityId,
                        argv.project as string,
                        argv.contact as string | undefined,
                    );
                    const entry = addTimeEntry({
                        entityId,
                        ...target,
                        description: (argv.description as string | undefined) ?? null,
                        startedAt: parseWhen(argv.from as string, '--from'),
                        endedAt: parseWhen(argv.to as string, '--to'),
                        billable: argv.billable !== false,
                        source: argv.source as 'manual' | 'reconstructed',
                        note: (argv.note as string | undefined) ?? null,
                    });
                    console.log(
                        `Erfasst: ${entry.project}  ${formatDuration(entry.durationSeconds ?? 0)}  (${entry.id})`,
                    );
                },
            })
            .command({
                command: 'remove',
                describe: 'Zeiteintrag loeschen',
                builder: (y) => y.option('id', { type: 'string', demandOption: true }),
                handler: (argv) => {
                    const id = argv.id as string;
                    const entry = findTimeEntry(id);
                    if (!entry) throw new Error(`Kein Zeiteintrag mit der Id ${id}`);
                    // Auf einer Rechnung darf nichts stillschweigend verschwinden - sonst weicht
                    // die Rechnungssumme von den erfassten Zeiten ab, ohne dass es auffaellt.
                    if (entry.invoiceId) {
                        throw new Error(
                            `Eintrag ${id} steht auf Rechnung ${entry.invoiceId} und wird nicht geloescht.`,
                        );
                    }
                    removeTimeEntry(id);
                    console.log(`Geloescht: ${entry.project}  ${formatDuration(entry.durationSeconds ?? 0)}  (${id})`);
                },
            })
            .command({
                command: 'list',
                describe: 'Zeiteinträge auflisten',
                builder: (y) =>
                    y
                        .option('from', { type: 'string', describe: 'ab Datum (YYYY-MM-DD)' })
                        .option('to', { type: 'string', describe: 'bis Datum (YYYY-MM-DD)' })
                        .option('project', { type: 'string' })
                        .option('contact', { type: 'string' })
                        .option('unbilled', { type: 'boolean', describe: 'Nur noch nicht abgerechnete' })
                        .option('json', { type: 'boolean' }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const entries = listTime({
                        entityId,
                        from: argv.from as string | undefined,
                        to: argv.to as string | undefined,
                        project: argv.project as string | undefined,
                        contactId: argv.contact as string | undefined,
                        unbilled: argv.unbilled ? true : undefined,
                    });
                    if (argv.json) {
                        console.log(JSON.stringify(entries, null, 2));
                        return;
                    }
                    if (entries.length === 0) {
                        console.log('Keine Zeiteinträge.');
                        return;
                    }
                    const names = contactNames(entityId);
                    for (const e of entries) printEntry(e, names);
                    const total = entries.reduce((sum, e) => sum + (e.durationSeconds ?? 0), 0);
                    console.log(
                        `\n  ${entries.length} Einträge, gesamt ${formatDuration(total)} (${toHours(total)} h)`,
                    );
                },
            })
            .command({
                command: 'report',
                describe: 'Summen je Projekt',
                builder: (y) =>
                    y
                        .option('from', { type: 'string' })
                        .option('to', { type: 'string' })
                        .option('unbilled', { type: 'boolean', describe: 'Nur noch nicht abgerechnete' })
                        .option('json', { type: 'boolean' }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const rows = timeSummary({
                        entityId,
                        from: argv.from as string | undefined,
                        to: argv.to as string | undefined,
                        unbilled: argv.unbilled ? true : undefined,
                    });
                    if (argv.json) {
                        console.log(JSON.stringify(rows, null, 2));
                        return;
                    }
                    if (rows.length === 0) {
                        console.log('Keine Zeiteinträge im Zeitraum.');
                        return;
                    }
                    const names = contactNames(entityId);
                    let total = 0;
                    for (const r of rows) {
                        total += r.seconds;
                        const who = r.contactId ? (names.get(r.contactId) ?? r.contactId) : 'ohne Kunde';
                        console.log(
                            `  ${formatDuration(r.seconds).padStart(9)}  ${String(toHours(r.seconds)).padStart(6)} h  ${r.project}  (${r.entries} Einträge, ${who})`,
                        );
                    }
                    console.log(`\n  Gesamt: ${formatDuration(total)}  (${toHours(total)} h)`);
                },
            })
            .command({
                command: 'assign',
                describe: 'Kunden für ein Projekt nachtragen (alle Einträge oder einen einzelnen)',
                builder: (y) =>
                    y
                        .option('contact', { type: 'string', demandOption: true, describe: 'Kontakt-Id' })
                        .option('project', { type: 'string', describe: 'Alle Einträge dieses Projekts' })
                        .option('id', { type: 'string', describe: 'Nur dieser eine Eintrag' })
                        .check((a) => {
                            if (!a.project && !a.id) throw new Error('Entweder --project oder --id angeben.');
                            return true;
                        }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const contactId = argv.contact as string;
                    const targets = argv.id
                        ? listTime({ entityId }).filter((e) => e.id === argv.id)
                        : listTime({ entityId, project: argv.project as string });
                    if (targets.length === 0) {
                        console.log('Keine passenden Einträge.');
                        return;
                    }
                    for (const e of targets) updateTimeEntry({ ...e, contactId });
                    console.log(`${targets.length} Einträge auf Kontakt ${contactId} gesetzt.`);
                },
            })
            .command({
                command: 'bill',
                describe: 'Rechnungsentwurf aus offenen Zeiten eines Kunden erzeugen',
                builder: (y) =>
                    y
                        .option('contact', { type: 'string', demandOption: true, describe: 'Kontakt-Id des Kunden' })
                        .option('rate', { type: 'number', demandOption: true, describe: 'Stundensatz netto' })
                        .option('project', { type: 'string', describe: 'Nur dieses Projekt' })
                        .option('from', { type: 'string' })
                        .option('to', { type: 'string' })
                        .option('vat', { type: 'number', default: 0.19, describe: 'USt-Satz als Bruch' })
                        .option('round', {
                            type: 'number',
                            default: 0,
                            describe: 'Je Projekt auf volle N Minuten aufrunden (0 = exakt)',
                        }),
                handler: (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const result = createInvoiceFromTime({
                        entityId,
                        contactId: argv.contact as string,
                        project: argv.project as string | undefined,
                        from: argv.from as string | undefined,
                        to: argv.to as string | undefined,
                        hourlyRate: argv.rate as number,
                        vatRate: argv.vat as number,
                        roundToMinutes: argv.round as number,
                    });
                    console.log(`Entwurf ${result.invoice.id} angelegt (noch ohne Nummer):`);
                    for (const l of result.lines) {
                        console.log(
                            `  ${l.project}: ${l.hours} h aus ${l.entries} Einträgen  (${formatDuration(l.seconds)})`,
                        );
                    }
                    console.log(
                        `  Leistungszeitraum ${result.invoice.performanceStart} – ${result.invoice.performanceEnd}`,
                    );
                    console.log(`  netto ${result.invoice.totals.net} €, brutto ${result.invoice.totals.gross} €`);
                    console.log(
                        `  ${result.entries.length} Zeiteinträge sind für den Entwurf vorgemerkt und gelten erst beim Festschreiben als abgerechnet.`,
                    );
                },
            })
            .command({
                command: 'import',
                describe: 'CSV des alten Trackers importieren (idempotent über dessen ID)',
                builder: (y) =>
                    y
                        .option('file', { type: 'string', demandOption: true, describe: 'Pfad zur CSV' })
                        .option('dry-run', { type: 'boolean', describe: 'Nur zeigen, was passieren würde' }),
                handler: async (argv) => {
                    const entityId = resolveEntityId(argv.entity as string | undefined);
                    const { readFile } = await import('node:fs/promises');
                    const csv = await readFile(argv.file as string, 'utf8');
                    const { rows, skipped } = parseLegacyTimeCsv(csv);
                    const contacts = customerContacts(entityId);
                    const match = (project: string) => matchProjectToContact(project, contacts);
                    const projects = listProjects(entityId);
                    const resolveProject = (label: string) => matchProjectByName(label, projects);

                    if (argv.dryRun) {
                        console.log(`${rows.length} Zeilen gelesen, ${skipped.length} nicht lesbar.`);
                        const byProject = new Map<string, number>();
                        for (const r of rows) byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1);
                        for (const [project, count] of byProject) {
                            const hit = resolveProject(project);
                            const id = hit?.contactId ?? match(project);
                            console.log(
                                `  ${project}: ${count} Einträge → ${id ?? 'KEIN Kunde zugeordnet'}${hit ? `, Projekt ${hit.id}` : ''}`,
                            );
                        }
                        return;
                    }

                    const result = importTimeRows(entityId, rows, match, resolveProject);
                    console.log(`Importiert: ${result.imported}, bereits vorhanden: ${result.skippedExisting}`);
                    if (skipped.length) console.log(`Nicht lesbare Zeilen: ${skipped.length}`);
                    if (result.unmatchedProjects.length) {
                        console.log(`Ohne Kundenzuordnung: ${result.unmatchedProjects.join(', ')}`);
                        console.log('  → mit „time list --json" die Einträge finden und den Kontakt nachtragen.');
                    }
                },
            })
            .demandCommand(1, 'Bitte ein Unterkommando angeben.'),
    handler: () => {
        /* handled by subcommands */
    },
};
