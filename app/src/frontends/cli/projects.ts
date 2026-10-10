/**
 * `projects` — customer projects: the link between a customer, its domains, the person the cover
 * letters address, the recurring invoices and the tracked time.
 *
 *   projects list [--entity <id>] [--json]
 *   projects show <id> [--entity <id>]
 *   projects add --entity <id> --name "Website Relaunch" --contact c_… [--domain example.com]
 *       [--greeting "Silke"] [--first-name Silke] [--formality du|sie|inherit] [--notes …] [--dry-run]
 *   projects edit <id> --entity <id> [same options; "" clears a text field, --formality inherit the form] [--dry-run]
 *   projects remove <id> --entity <id> [--dry-run]
 *   projects suggest [--entity <id>] [--json]       # prints proposals, writes nothing
 *   projects result [id] [--entity <id>] [--year <y>] [--json]   # Projektergebnis + Kosten (interne Auswertung)
 *   projects assign <project> <tx-id…> [--entity <id>] [--year <y>] [--part <n>] [--rule [<muster>]] [--json]
 *   projects exclude <tx-id…> [--part <n>]          # „kein Projekt": nimmt eine Ausgabe aus einer Regel heraus
 *   projects unassign <tx-id…> [--part <n>]         # Zuordnung zurücknehmen, sagt „Danach gilt: …"
 *   projects rules [--entity <id>] [--year <y>] [--json]
 *   projects rule add <muster> --project <id> [--entity <id>]
 *   projects rule remove <muster> [--project <id>] [--entity <id>]
 *
 * A contract joins a project with `invoices recurring set-project`. Projects are optional; nothing
 * in a manifest or ledger without them changes.
 */

import type { CommandModule } from 'yargs';
import type { Contact } from '@steuererklaerung/store';
import { contactDisplayName } from '@steuererklaerung/store';
import { listEntityContacts } from '../../core/actions/contacts.ts';
import {
    addProject,
    FORMALITY_ARGS,
    formalityFromArg,
    getProject,
    listProjects,
    type ProjectContactPersonPatch,
    removeProject,
    suggestProjects,
    updateProject,
} from '../../core/actions/projects.ts';
import { listSchedules } from '../../core/actions/recurring-schedules.ts';
import { defaultEntityFor, requireEntity } from '../../core/config/entities.ts';
import { loadManifest, type Project } from '../../core/config/index.ts';
import {
    legeProjektRegelAn,
    loadProjektAnsicht,
    loeseProjektRegel,
    nimmProjektZuordnungZurueck,
    projektRegelVorschau,
    weiseProjektZu,
    type ProjektAnsicht,
} from '../../core/presenters/projekt.ts';
import { createPresenterSession, type PresenterSession } from '../../core/presenters/session.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { fmtDe } from '../../core/lib/money.ts';
import { ensureDemoSeeded } from './demo.ts';
import { runAndExit } from './output.ts';

/** `--entity` omitted on a read command falls back to the manifest's default business entity. */
function resolveEntityId(entityArg: string | undefined): string {
    const manifest = loadManifest();
    const entity = entityArg ? requireEntity(manifest, entityArg) : defaultEntityFor(manifest);
    return entity.id;
}

/** Shell-quote one argument for the copy-and-paste lines of `suggest`. */
const quote = (s: string): string => (/^[\w.@:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** An optional string option: `undefined` when not given, so "unchanged" stays distinguishable from "". */
const optText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

/** `--domain a.de --domain b.de` or `--domain a.de,b.de`. */
function domainsArg(v: unknown): string[] | undefined {
    if (v === undefined) return undefined;
    return (Array.isArray(v) ? v : [v]).flatMap((d) => String(d).split(','));
}

/** The contact-person options of add/edit; `""` becomes `null` (clear), absent stays `undefined` (keep). */
function contactPersonArg(argv: Record<string, unknown>): ProjectContactPersonPatch | undefined {
    const text = (v: unknown) => (optText(v) === undefined ? undefined : optText(v) === '' ? null : optText(v));
    const patch: ProjectContactPersonPatch = {
        greeting: text(argv.greeting),
        firstName: text(argv.firstName),
        formality: formalityFromArg(optText(argv.formality)),
    };
    return Object.values(patch).some((v) => v !== undefined) ? patch : undefined;
}

function contactName(contacts: readonly Contact[], id: string): string {
    const c = contacts.find((x) => x.id === id);
    return c ? contactDisplayName(c) : `(unbekannter Kontakt ${id})`;
}

function printProject(p: Project, contacts: readonly Contact[], scheduleIds: readonly string[] = []): void {
    console.log(`  ${p.id}  ${p.name}  — ${contactName(contacts, p.contactId)} (${p.contactId})`);
    if (p.domains.length) console.log(`        Domains: ${p.domains.join(', ')}`);
    const person = p.contactPerson;
    if (person) {
        const parts = [
            person.greeting ? `Anrede „${person.greeting}"` : null,
            person.firstName ? `Vorname ${person.firstName}` : null,
            person.formality ? (person.formality === 'sie' ? 'Sie' : 'du') : null,
        ].filter(Boolean);
        if (parts.length) console.log(`        Kontaktperson: ${parts.join(', ')}`);
    }
    if (scheduleIds.length) console.log(`        Verträge: ${scheduleIds.join(', ')}`);
    if (p.notes) console.log(`        ${p.notes}`);
}

const yearOptions = {
    entity: { type: 'string', describe: 'Entity-Id (Standard: die erste Firma)' },
    year: { type: 'number', describe: 'Jahr (Standard: laufendes Jahr)' },
    json: { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' },
} as const;

/** The presenter session and the entity-year a `projects` command with money in it works on. */
async function openYear(argv: Record<string, unknown>): Promise<{
    session: PresenterSession;
    entity: EntityModel;
    year: number;
}> {
    await ensureDemoSeeded();
    const session = createPresenterSession();
    const wanted = argv.entity as string | undefined;
    const entities = session.workspace.entities;
    const entity = wanted ? entities.find((e) => e.id === wanted) : (entities.find((e) => !!e.elster) ?? entities[0]);
    if (!entity) {
        throw new Error(
            wanted
                ? `Unbekannte Entität '${wanted}'. Bekannt: ${entities.map((e) => e.id).join(', ') || '—'}`
                : 'Keine Entität in steuererklaerung.json.',
        );
    }
    return { session, entity, year: (argv.year as number | undefined) ?? new Date().getFullYear() };
}

const eur = (n: number): string => `${fmtDe(n).padStart(11)} €`;

function printErgebnis(a: ProjektAnsicht, only?: string): void {
    const list = only ? a.projekte.filter((p) => p.projectId === only) : a.projekte;
    if (list.length === 0) {
        console.log(`Keine Projekte für ${a.entityId}.`);
        return;
    }
    console.log(`Projektergebnis ${a.year} — interne Auswertung, keine Steuerzahl\n`);
    for (const p of list) {
        console.log(`  ${p.projectId}  ${p.name}`);
        console.log(`      Umsatz ${eur(p.umsatz)}   Kosten ${eur(-p.kosten)}   Ergebnis ${eur(p.ergebnis)}`);
        if (p.stunden != null) {
            console.log(`      ${fmtDe(p.stunden)} h erfasst · ${fmtDe(p.ergebnisProStunde ?? 0)} €/h Ergebnis`);
        }
        for (const r of p.rechnungen) {
            const anteil = r.anteil < 1 ? ` (${Math.round(r.anteil * 100)} % der Stunden)` : '';
            console.log(`      Rechnung ${r.nummer ?? '(Entwurf)'}  ${r.datum}  ${eur(r.netto)}${anteil}`);
        }
        for (const k of p.ausgaben) {
            const teil = k.teilNr != null ? ` Teil ${k.teilNr}` : '';
            const wer = (k.counterparty?.trim() || k.purpose?.trim() || '—').slice(0, 30);
            console.log(
                `      Ausgabe  ${k.bookingDate}  ${eur(-k.net)}  ${wer}${teil} — ${k.herkunft.label}   [${k.txId}]`,
            );
        }
    }
}

/** `projects assign` and `projects exclude`: one write, one report. */
function zuordnen(argv: Record<string, unknown>, project: string | null): void {
    runAndExit(
        async () => {
            const txIds = ((argv.ids as string[]) ?? []).map(String);
            const { session, entity, year } = await openYear(argv);
            let regel: { muster: string } | undefined;
            if (argv.rule !== undefined && project != null) {
                const gegeben = String(argv.rule).trim();
                const muster = gegeben || (await projektRegelVorschau(session, entity, year, txIds, project)).muster;
                if (!muster) throw new Error('Kein gemeinsames Muster — bitte --rule "<muster>" angeben.');
                regel = { muster };
            }
            return weiseProjektZu(session, entity, year, txIds, project, {
                teilNr: argv.part as number | undefined,
                decidedBy: 'cli',
                regel,
            });
        },
        {
            print: (r) => {
                if (argv.json) return console.log(JSON.stringify(r, null, 2));
                const ziel = r.projectId ? `Projekt ${r.projectId}` : 'kein Projekt';
                console.log(
                    `${r.zugeordnet.length + r.viaRegel.length + r.unveraendert.length} Buchung(en) → ${ziel}.`,
                );
                if (r.viaRegel.length)
                    console.log(`${r.viaRegel.length} davon folgen der Regel (via Regel), ohne eigene Entscheidung.`);
                if (r.unveraendert.length) console.log(`${r.unveraendert.length} waren schon so zugeordnet.`);
                if (r.regel) {
                    const m = r.regel.rule.muster;
                    console.log(
                        r.regel.added ? `Regel gemerkt: „${m}“ → ${r.projectId}.` : `Regel „${m}“ gab es schon.`,
                    );
                }
                for (const u of r.uebersprungen) console.log(`Übersprungen: ${u.id} — ${u.warum}`);
            },
        },
    );
}

const personOptions = {
    greeting: { type: 'string' as const, describe: 'Anrede-Freitext für {anrede}, z. B. „Silke"' },
    'first-name': { type: 'string' as const, describe: 'Vorname der Kontaktperson' },
    formality: {
        type: 'string' as const,
        choices: [...FORMALITY_ARGS],
        describe: 'Anredeform der Kontaktperson; inherit = wie im Vertrag (löscht die des Projekts)',
    },
    notes: { type: 'string' as const },
    domain: { type: 'string' as const, array: true, describe: 'Domain (mehrfach oder kommagetrennt)' },
    'dry-run': { type: 'boolean' as const, default: false, describe: 'Prüfen, aber nichts schreiben' },
};

/** Run a command handler, printing a failure instead of a stack trace. */
function run(fn: () => void): void {
    try {
        fn();
        process.exit(0);
    } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    }
}

export const projectsCommand: CommandModule = {
    command: 'projects',
    describe: 'Projekte: Kunde, Domains, Kontaktperson, zugehörige Verträge und Zeiten',
    builder: (yargs) =>
        yargs
            .demandCommand(
                1,
                'Choose: list, show, add, edit, remove, suggest, result, assign, exclude, unassign, rules or rule',
            )
            .command({
                command: 'list',
                describe: 'Projekte einer Entität auflisten (Default: die Standard-Entität)',
                builder: (y) =>
                    y.option('entity', { type: 'string', describe: 'Entity-Id' }).option('json', { type: 'boolean' }),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string | undefined);
                        const projects = listProjects(entityId);
                        if (argv.json) {
                            console.log(JSON.stringify(projects, null, 2));
                            return;
                        }
                        if (!projects.length) {
                            console.log(`Keine Projekte für ${entityId}.`);
                            return;
                        }
                        const contacts = listEntityContacts(entityId);
                        const schedules = listSchedules(entityId);
                        for (const p of projects) {
                            printProject(
                                p,
                                contacts,
                                schedules.filter((s) => s.projectId === p.id).map((s) => s.id),
                            );
                        }
                    }),
            })
            .command({
                command: 'show <id>',
                describe: 'Ein Projekt mit Kunde und Verträgen zeigen',
                builder: (y) =>
                    y
                        .positional('id', { type: 'string' })
                        .option('entity', { type: 'string', describe: 'Entity-Id' })
                        .option('json', { type: 'boolean' }),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string | undefined);
                        const project = getProject(entityId, String(argv.id));
                        const scheduleIds = listSchedules(entityId)
                            .filter((s) => s.projectId === project.id)
                            .map((s) => s.id);
                        if (argv.json) {
                            console.log(JSON.stringify({ ...project, scheduleIds }, null, 2));
                            return;
                        }
                        printProject(project, listEntityContacts(entityId), scheduleIds);
                    }),
            })
            .command({
                command: 'add',
                describe: 'Ein Projekt anlegen',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', demandOption: true, describe: 'Entity-Id' })
                        .option('name', { type: 'string', demandOption: true })
                        .option('contact', { type: 'string', demandOption: true, describe: 'Kontakt-Id des Kunden' })
                        .option('id', { type: 'string', describe: 'Eigene Projekt-Id (Default: aus dem Namen)' })
                        .options(personOptions),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string);
                        const project = addProject(
                            entityId,
                            {
                                id: optText(argv.id),
                                name: String(argv.name),
                                contactId: String(argv.contact),
                                domains: domainsArg(argv.domain),
                                contactPerson: contactPersonArg(argv),
                                notes: optText(argv.notes),
                            },
                            { dryRun: Boolean(argv.dryRun) },
                        );
                        console.log(argv.dryRun ? 'Würde anlegen (--dry-run):' : 'Angelegt:');
                        printProject(project, listEntityContacts(entityId));
                    }),
            })
            .command({
                command: 'edit <id>',
                describe: 'Ein Projekt ändern (nicht angegebene Felder bleiben, "" leert ein Textfeld)',
                builder: (y) =>
                    y
                        .positional('id', { type: 'string' })
                        .option('entity', { type: 'string', demandOption: true, describe: 'Entity-Id' })
                        .option('name', { type: 'string' })
                        .option('contact', { type: 'string', describe: 'Anderer Kunde (nur ohne verknüpfte Verträge)' })
                        .options(personOptions),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string);
                        const notes = optText(argv.notes);
                        const project = updateProject(
                            entityId,
                            String(argv.id),
                            {
                                name: optText(argv.name),
                                contactId: optText(argv.contact),
                                domains: domainsArg(argv.domain),
                                contactPerson: contactPersonArg(argv),
                                notes: notes === undefined ? undefined : notes === '' ? null : notes,
                            },
                            { dryRun: Boolean(argv.dryRun) },
                        );
                        console.log(argv.dryRun ? 'Würde ändern (--dry-run):' : 'Geändert:');
                        printProject(project, listEntityContacts(entityId));
                    }),
            })
            .command({
                command: 'remove <id>',
                describe: 'Ein Projekt löschen (verweigert, solange ein Vertrag daran hängt)',
                builder: (y) =>
                    y
                        .positional('id', { type: 'string' })
                        .option('entity', { type: 'string', demandOption: true, describe: 'Entity-Id' })
                        .option('dry-run', personOptions['dry-run']),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string);
                        removeProject(entityId, String(argv.id), { dryRun: Boolean(argv.dryRun) });
                        console.log(argv.dryRun ? `Würde löschen (--dry-run): ${argv.id}` : `Gelöscht: ${argv.id}`);
                    }),
            })
            .command({
                command: 'suggest',
                describe: 'Projekte aus den Verträgen vorschlagen (Kunde + Domains) — schreibt nichts',
                builder: (y) =>
                    y.option('entity', { type: 'string', describe: 'Entity-Id' }).option('json', { type: 'boolean' }),
                handler: (argv) =>
                    run(() => {
                        const entityId = resolveEntityId(argv.entity as string | undefined);
                        const result = suggestProjects(listSchedules(entityId), listProjects(entityId));
                        if (argv.json) {
                            console.log(JSON.stringify(result, null, 2));
                            return;
                        }
                        if (!result.suggestions.length && !result.skipped.length) {
                            console.log(
                                'Nichts vorzuschlagen: jeder Vertrag mit Domains gehört schon zu einem Projekt.',
                            );
                            return;
                        }
                        const contacts = listEntityContacts(entityId);
                        for (const { kind, project, scheduleIds } of result.suggestions) {
                            console.log(
                                kind === 'new'
                                    ? `\nNeues Projekt „${project.name}":`
                                    : `\nBestehendes Projekt „${project.name}":`,
                            );
                            printProject(project, contacts, scheduleIds);
                            console.log('  Übernehmen:');
                            if (kind === 'new') {
                                const flags = [
                                    `--entity ${quote(entityId)}`,
                                    `--id ${quote(project.id)}`,
                                    `--name ${quote(project.name)}`,
                                    `--contact ${quote(project.contactId)}`,
                                    ...project.domains.map((d) => `--domain ${quote(d)}`),
                                    ...(project.contactPerson?.greeting
                                        ? [`--greeting ${quote(project.contactPerson.greeting)}`]
                                        : []),
                                    ...(project.contactPerson?.formality
                                        ? [`--formality ${project.contactPerson.formality}`]
                                        : []),
                                ];
                                console.log(`    steuer projects add ${flags.join(' ')}`);
                            }
                            for (const id of scheduleIds) {
                                console.log(
                                    `    steuer invoices recurring set-project ${quote(id)} --entity ${quote(entityId)} --project ${quote(project.id)}`,
                                );
                            }
                        }
                        for (const s of result.skipped) console.log(`\nÜbersprungen: ${s.scheduleId} — ${s.reason}`);
                    }),
            })
            .command({
                command: 'result [id]',
                describe: 'Projektergebnis (Umsatz − Kosten) mit den zugeordneten Ausgaben — interne Auswertung',
                builder: (y) =>
                    y.positional('id', { type: 'string', describe: 'Nur dieses Projekt' }).options(yearOptions),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity, year } = await openYear(argv);
                            const a = await loadProjektAnsicht(session, entity, year);
                            const only = argv.id as string | undefined;
                            if (only && !a.projekte.some((p) => p.projectId === only)) {
                                throw new Error(`Projekt „${only}" gibt es für ${entity.name} nicht.`);
                            }
                            return { a, only };
                        },
                        {
                            print: ({ a, only }) =>
                                argv.json
                                    ? console.log(
                                          JSON.stringify(
                                              only
                                                  ? { ...a, projekte: a.projekte.filter((p) => p.projectId === only) }
                                                  : a,
                                              null,
                                              2,
                                          ),
                                      )
                                    : printErgebnis(a, only),
                        },
                    ),
            })
            .command({
                command: 'assign <project> <ids..>',
                describe:
                    'Ausgaben einem Projekt zuordnen (--rule: das Muster der Buchungen als Projektregel merken, ohne Wert das gemeinsame)',
                builder: (y) =>
                    y
                        .positional('project', { type: 'string', describe: 'Projekt-Id' })
                        .positional('ids', { type: 'string', array: true, describe: 'Transaktions-IDs der Ausgaben' })
                        .options(yearOptions)
                        .option('part', { type: 'number', describe: 'Nur diesen Teil einer aufgeteilten Buchung' })
                        .option('rule', {
                            type: 'string',
                            describe: 'Als Regel merken; ohne Wert das gemeinsame Muster der Buchungen',
                        }),
                handler: (argv) => zuordnen(argv, String(argv.project)),
            })
            .command({
                command: 'exclude <ids..>',
                describe: 'Entscheiden: kein Projekt — die Ausgaben bleiben auch dann ohne, wenn eine Regel sie träfe',
                builder: (y) =>
                    y
                        .positional('ids', { type: 'string', array: true, describe: 'Transaktions-IDs der Ausgaben' })
                        .options(yearOptions)
                        .option('part', { type: 'number', describe: 'Nur diesen Teil einer aufgeteilten Buchung' }),
                handler: (argv) => zuordnen(argv, null),
            })
            .command({
                command: 'unassign <ids..>',
                describe: 'Die Zuordnung (oder „kein Projekt") zurücknehmen; sagt, was danach gilt',
                builder: (y) =>
                    y
                        .positional('ids', { type: 'string', array: true, describe: 'Transaktions-IDs' })
                        .options(yearOptions)
                        .option('part', { type: 'number', describe: 'Nur diesen Teil einer aufgeteilten Buchung' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity, year } = await openYear(argv);
                            return nimmProjektZuordnungZurueck(
                                session,
                                entity,
                                year,
                                ((argv.ids as string[]) ?? []).map(String),
                                {
                                    teilNr: argv.part as number | undefined,
                                    decidedBy: 'cli',
                                },
                            );
                        },
                        {
                            print: (r) => {
                                if (argv.json) return console.log(JSON.stringify(r, null, 2));
                                if (!r.ok) console.log('Keine dieser Buchungen hatte eine eigene Zuordnung.');
                                for (const z of r.zurueckgenommen) console.log(`${z.id}: zurückgenommen. ${z.danach}`);
                            },
                        },
                    ),
            })
            .command({
                command: 'rules',
                describe: 'Die Projektregeln mit der Zahl der Buchungen, die sie gerade zuordnen',
                builder: (y) => y.options(yearOptions),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity, year } = await openYear(argv);
                            return (await loadProjektAnsicht(session, entity, year)).regeln;
                        },
                        {
                            print: (regeln) => {
                                if (argv.json) return console.log(JSON.stringify(regeln, null, 2));
                                if (!regeln.length) return console.log('Keine Projektregeln.');
                                for (const r of regeln) {
                                    const aus = r.ausnahmen?.length ? ` · ${r.ausnahmen.length} Ausnahme(n)` : '';
                                    console.log(
                                        `  „${r.muster}“ → ${r.projektName} (${r.projekt}) · trifft ${r.treffer}${aus}`,
                                    );
                                }
                            },
                        },
                    ),
            })
            .command({
                command: 'rule <action> <muster>',
                describe: 'Eine Projektregel anlegen (add) oder entfernen (remove); Zuordnungen von Hand bleiben',
                builder: (y) =>
                    y
                        .positional('action', { type: 'string', choices: ['add', 'remove'] })
                        .positional('muster', {
                            type: 'string',
                            describe: 'Text im Buchungstext (Gegenseite, Zweck, Referenz)',
                        })
                        .option('project', { type: 'string', describe: 'Projekt-Id (bei add nötig)' })
                        .option('entity', { type: 'string', describe: 'Entity-Id' })
                        .option('json', { type: 'boolean', default: false }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity } = await openYear(argv);
                            const muster = String(argv.muster);
                            const project = argv.project as string | undefined;
                            if (argv.action === 'add') {
                                if (!project) throw new Error('--project <id> fehlt.');
                                return { action: 'add', ...legeProjektRegelAn(session, entity, muster, project) };
                            }
                            return { action: 'remove', removed: loeseProjektRegel(session, entity, muster, project) };
                        },
                        {
                            print: (r) => {
                                if (argv.json) return console.log(JSON.stringify(r, null, 2));
                                if ('removed' in r)
                                    console.log(r.removed ? 'Regel entfernt.' : 'Diese Regel gab es nicht.');
                                else console.log(r.added ? 'Regel gemerkt.' : 'Diese Regel gab es schon.');
                            },
                        },
                    ),
            })
            .demandCommand(1, 'Bitte ein Unterkommando angeben.'),
    handler: () => {
        /* handled by subcommands */
    },
};
