import type { CommandModule } from 'yargs';

import { createInwxProvider } from '../../core/actions/invoices/inwx-provider.ts';
import { listProviderInvoices } from '../../core/actions/invoices/list.ts';
import { downloadProviderInvoices } from '../../core/actions/invoices/download.ts';
import { importProviderInvoices } from '../../core/actions/invoices/import.ts';
import { readEInvoiceFile } from '../../core/actions/invoices/e-rechnung.ts';
import { updateProviderInvoices } from '../../core/actions/invoices/update.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import {
    cancelOutgoingInvoice,
    deleteOutgoingInvoiceDraft,
    finalizeOutgoingInvoice,
    getInvoiceCapabilities,
    getOutgoingInvoice,
    getOutgoingInvoicePdf,
    getOutgoingInvoiceXml,
    listOutgoingInvoicesFor,
    markOutgoingInvoicePaid,
    saveOutgoingInvoiceDraft,
} from '../../core/actions/outgoing-invoices.ts';
import { getProject, setScheduleProject } from '../../core/actions/projects.ts';
import { buildProjectTimeDraft } from '../../core/actions/time-invoice.ts';
import { clearRechnungProjekt, getRechnungProjekt, setRechnungProjekt } from '../../core/actions/rechnung-projekt.ts';
import { findPaymentCandidates } from '../../core/actions/invoice-payments.ts';
import {
    entscheideDoppelzahlung,
    listDoppelzahlungVerdacht,
    listOffeneRueckzahlungen,
    parseEntscheidung,
} from '../../core/actions/invoices/doppelzahlung.ts';
import {
    entwerfeMahnung,
    loadForderungen,
    markiereMahnungVersandt,
    type ForderungenUebersicht,
} from '../../core/actions/forderungen.ts';
import { GREETING_MISSING } from '../../core/invoices/header-template.ts';
import type { ReconcileOutcome } from '../../core/invoices/reconcile.ts';
import { buildReminder } from '../../core/invoices/recurring.ts';
import { mahnstufeLabel } from '../../core/invoices/mahnung-text.ts';
import { sendDesktopNotification } from '../../core/notify/desktop.ts';
import type { CreateInvoiceInput } from '../../core/invoices/provider.ts';
import {
    createRecurringInvoiceDraft,
    recurringDashboard,
    recurringEmail,
    recurringIcs,
    reconcileRecurringInvoices,
} from '../../core/actions/recurring-invoices.ts';
import type { RecurringDueEntry } from '../../core/invoices/recurring.ts';
import { deDate } from '../../core/lib/format.ts';
import { fmtDe } from '../../core/lib/money.ts';
import { pickArgv, printJson, runAndExit } from './output.ts';

/** Common date filter options reused by list/download/import subcommands. */
const dateFilterOptions = {
    from: { type: 'string' as const, describe: 'Only invoices on or after this date (YYYY-MM-DD)' },
    to: { type: 'string' as const, describe: 'Only invoices on or before this date (YYYY-MM-DD)' },
};

/** Status labels + glyphs for the human-readable recurring reminder view. */
const DUE_LABELS: Record<RecurringDueEntry['status'], string> = {
    overdue: '⚠ ÜBERFÄLLIG',
    'due-soon': '● BALD FÄLLIG',
    upcoming: '· geplant   ',
    paused: '· pausiert  ',
    cancelled: '· storniert ',
};

/** What `recurring reconcile` says per outcome. */
const RECONCILE_LABEL: Record<ReconcileOutcome, string> = {
    updated: 'aktualisiert',
    replaced: 'ersetzt nach Storno',
    'cancelled-no-replacement': 'storniert, keine Ersatzrechnung gefunden',
    missing: 'Rechnung im Back-End nicht gefunden',
    unchanged: 'unverändert',
};

/** Human-readable printer for the recurring reminder dashboard (use --json for raw output). */
function formatDashboard(entries: RecurringDueEntry[]): void {
    if (!entries.length) {
        console.log('Keine wiederkehrenden Rechnungen vorhanden.');
        return;
    }
    for (const e of entries) {
        const label = DUE_LABELS[e.status];
        const when =
            e.daysUntilDue < 0
                ? `seit ${Math.abs(e.daysUntilDue)} T`
                : e.daysUntilDue === 0
                  ? 'heute'
                  : `in ${e.daysUntilDue} T`;
        const what = e.description ?? (e.domains.join(', ') || e.customer);
        const last = e.lastInvoiceNumber ? `  ↩ ${e.lastInvoiceNumber}` : '';
        const project = e.projectId ? `  ⌂ ${e.projectId}` : '';
        console.log(
            `${label}  ${e.dueDate} (${when})  ${fmtDe(e.totals.gross)} ${e.currency}  ${e.customer} — ${what}  [${e.id}]${last}${project}`,
        );
    }
}

/** Human-readable printer for `forderungen` (use --json for raw output). */
function formatForderungen(u: ForderungenUebersicht): void {
    if (!u.posten.length) console.log('Keine offenen Forderungen.');
    else {
        console.log(
            `Offene Forderungen am ${deDate(u.heute)}: ${u.alter.gesamt.anzahl} · ${fmtDe(u.alter.gesamt.summe)} €`,
        );
        for (const k of u.alter.klassen) if (k.anzahl) console.log(`  ${k.label}: ${k.anzahl} · ${fmtDe(k.summe)} €`);
        console.log('');
        for (const p of u.posten) {
            const tage =
                p.tageUeberfaellig != null && p.tageUeberfaellig > 0
                    ? `${p.tageUeberfaellig} T überfällig`
                    : 'nicht fällig';
            const teil = p.bezahlt > 0 ? ` (davon ${fmtDe(p.bezahlt)} € eingegangen)` : '';
            const v = p.verjaehrung;
            const frist = v
                ? v.status === 'verjaehrt'
                    ? `  vermutlich verjährt seit ${deDate(v.handelnBis)}`
                    : `  Handeln bis ${deDate(v.handelnBis)}`
                : '';
            const faellig = p.mahnungFaellig ? `  → Stufe ${p.naechsteStufe} fällig` : '';
            console.log(
                `${(p.nummer ?? p.rechnungId).padEnd(14)} ${p.kunde}  ${fmtDe(p.offen)} €${teil}  ${tage}  ${mahnstufeLabel(p.mahnstufe)}${frist}${faellig}`,
            );
        }
    }
    if (u.vermutlichBezahlt.length)
        console.log(
            `\n${u.vermutlichBezahlt.length} Rechnung(en) mit vollem Zahlungseingang, aber nicht als bezahlt markiert: ${u.vermutlichBezahlt.map((r) => r.nummer ?? r.rechnungId).join(', ')}`,
        );
    if (u.verhalten.length) {
        console.log('\nZahlungsverhalten (Tage nach Fälligkeit):');
        for (const v of u.verhalten) {
            const trend = v.trend ? `  Trend: ${v.trend}` : '';
            console.log(
                `  ${v.kunde}: Ø ${v.mittel.toLocaleString('de-DE')} · schlimmster ${v.schlimmster} · ${v.anzahl} bezahlt${trend}`,
            );
        }
    }
}

/** Date/entity options shared by the recurring reminder views. */
const recurringViewOptions = {
    entity: { type: 'string' as const, describe: 'Filter by entity id (e.g. jumplink)' },
    today: { type: 'string' as const, describe: 'Reference date YYYY-MM-DD (default: today)' },
    json: { type: 'boolean' as const, default: false, describe: 'Print raw JSON instead of the table' },
};

/** `invoices recurring …` — reminders for recurring outgoing invoices + draft creation. */
const recurringCommand: CommandModule = {
    command: 'recurring',
    describe: 'Recurring outgoing invoices: reminders (due/overdue) + draft creation',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose an action: list, due, create')
            .command({
                command: 'list',
                describe: 'List all recurring invoice schedules with their status',
                builder: (y2) =>
                    y2
                        .option('entity', recurringViewOptions.entity)
                        .option('today', recurringViewOptions.today)
                        .option('json', recurringViewOptions.json),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entityId = pickArgv<string>(raw, 'entity');
                    const today = pickArgv<string>(raw, 'today');
                    const print = raw.json ? printJson : formatDashboard;
                    runAndExit(async () => recurringDashboard({ entityId, today }), { print });
                },
            })
            .command({
                command: 'due',
                describe: 'Show only overdue + soon-due recurring invoices (the reminder view)',
                builder: (y2) =>
                    y2
                        .option('entity', recurringViewOptions.entity)
                        .option('today', recurringViewOptions.today)
                        .option('lead', {
                            type: 'number',
                            describe: 'Due-soon window in days (overrides per-schedule)',
                        })
                        .option('json', recurringViewOptions.json),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entityId = pickArgv<string>(raw, 'entity');
                    const today = pickArgv<string>(raw, 'today');
                    const leadDays = pickArgv<number>(raw, 'lead');
                    const print = raw.json ? printJson : formatDashboard;
                    runAndExit(async () => recurringDashboard({ entityId, today, leadDays, actionableOnly: true }), {
                        print,
                    });
                },
            })
            .command({
                command: 'create <id>',
                describe: 'Create a DRAFT invoice for one schedule via the entity back-end (Qonto)',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string', describe: 'Schedule id (see `recurring list`)' })
                        .option('today', recurringViewOptions.today)
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Print the prepared invoice without creating it',
                        })
                        .option('advance', {
                            type: 'boolean',
                            default: true,
                            describe: 'Advance the schedule after creating (use --no-advance to skip)',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const id = String(raw.id);
                    const today = pickArgv<string>(raw, 'today');
                    const dryRun = Boolean(raw['dry-run'] || raw.dryRun);
                    const advance = raw.advance !== false;
                    runAndExit(() => createRecurringInvoiceDraft(id, { today, dryRun, advance }), {
                        print: (result) => {
                            printJson(result);
                            // JSON escapes the newlines; show the cover letter as the customer will read it.
                            if (result.dryRun && result.input.header)
                                console.log(`\n--- Anschreiben ---\n${result.input.header}`);
                            if (result.dryRun && result.input.header) {
                                const { greeting, formality, greetingFrom } = result.addressing;
                                const from = { project: 'Projekt', contract: 'Vertrag', none: 'keine' }[greetingFrom];
                                console.log(
                                    `\nAnrede: ${greeting || '—'} (${from}), ${formality === 'sie' ? 'Sie' : 'du'}`,
                                );
                            }
                            if (result.dryRun && result.headerWarnings.includes(GREETING_MISSING))
                                console.log(
                                    '\nAnrede fehlt – Kontaktperson am Projekt oder customer.greeting am Vertrag eintragen',
                                );
                        },
                    });
                },
            })
            .command({
                command: 'reconcile',
                describe:
                    'Update lastInvoice of the schedules from the back-end (final number, replacement after a cancel)',
                builder: (y2) =>
                    y2
                        .option('entity', { ...recurringViewOptions.entity, demandOption: true })
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Show what would change, write nothing',
                        })
                        .option('json', recurringViewOptions.json),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(
                        () =>
                            reconcileRecurringInvoices({
                                entityId: String(raw.entity),
                                dryRun: Boolean(raw['dry-run'] || raw.dryRun),
                            }),
                        {
                            print: (result) => {
                                if (raw.json) return printJson(result);
                                for (const c of result.changes) {
                                    if (c.outcome === 'unchanged') continue;
                                    const arrow = c.before === c.after ? '' : `${c.before ?? '—'} → ${c.after ?? '—'}`;
                                    console.log(`${c.scheduleId}  ${RECONCILE_LABEL[c.outcome]}  ${arrow}`.trimEnd());
                                }
                                if (!result.rewritten) console.log('Nichts zu aktualisieren.');
                                else if (result.dryRun) console.log('\nTrockenlauf: nichts geschrieben.');
                            },
                        },
                    );
                },
            })
            .command({
                command: 'set-project <id>',
                describe: 'Attach a schedule to a project of the same customer (`--project none` detaches it)',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string', describe: 'Schedule id (see `recurring list`)' })
                        .option('entity', { ...recurringViewOptions.entity, demandOption: true })
                        .option('project', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Project id (see `projects list`), or `none`',
                        })
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Validate only, write nothing',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const project = String(raw.project);
                    runAndExit(async () =>
                        setScheduleProject(String(raw.entity), String(raw.id), project === 'none' ? null : project, {
                            dryRun: Boolean(raw['dry-run'] || raw.dryRun),
                        }),
                    );
                },
            })
            .command({
                command: 'ics',
                describe: 'Render a subscribable .ics reminder feed (VEVENT + VALARM) for the calendar',
                builder: (y2) =>
                    y2
                        .option('entity', recurringViewOptions.entity)
                        .option('today', recurringViewOptions.today)
                        .option('lead', { type: 'number', describe: 'Override the per-schedule alarm lead (days)' })
                        .option('out', { type: 'string', describe: 'Write to this file instead of stdout' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entityId = pickArgv<string>(raw, 'entity');
                    const today = pickArgv<string>(raw, 'today');
                    const leadDays = pickArgv<number>(raw, 'lead');
                    const out = pickArgv<string>(raw, 'out');
                    runAndExit(
                        async () => {
                            const ics = recurringIcs({ entityId, today, leadDays });
                            if (out) {
                                writeFileSync(out, ics);
                                return { written: out, bytes: ics.length };
                            }
                            return ics;
                        },
                        { print: (v) => (typeof v === 'string' ? process.stdout.write(v) : printJson(v)) },
                    );
                },
            })
            .command({
                command: 'notify',
                describe: 'Remind about due recurring invoices via a desktop notification',
                builder: (y2) =>
                    y2
                        .option('entity', recurringViewOptions.entity)
                        .option('today', recurringViewOptions.today)
                        .option('lead', {
                            type: 'number',
                            describe: 'Due-soon window in days (overrides per-schedule)',
                        })
                        .option('print', {
                            type: 'boolean',
                            default: false,
                            describe: 'Only print what would be sent — notify nobody',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entityId = pickArgv<string>(raw, 'entity');
                    const today = pickArgv<string>(raw, 'today');
                    const leadDays = pickArgv<number>(raw, 'lead');
                    const printOnly = raw.print === true;
                    runAndExit(
                        async () => {
                            const entries = await recurringDashboard({
                                entityId,
                                today,
                                leadDays,
                                actionableOnly: true,
                            });
                            const reminder = buildReminder(entries);
                            if (!reminder) return { due: 0, notified: false, message: 'Nichts fällig.' };
                            if (printOnly) {
                                return {
                                    due: reminder.entries.length,
                                    notified: false,
                                    message: `${reminder.title}\n${reminder.body}`,
                                };
                            }
                            const result = sendDesktopNotification({
                                title: `Steuererklärung: ${reminder.title}`,
                                body: `${reminder.body}\n\nErstellen:  steuer invoices recurring create <id>`,
                                urgency: 'critical',
                                appName: 'Steuererklärung',
                                icon: 'x-office-spreadsheet',
                            });
                            // A reminder that could not be delivered must not look like a quiet
                            // "nothing due": it is printed, and the exit code says it failed. The
                            // whole point of this command is that silence is never ambiguous.
                            if (!result.delivered) {
                                throw new Error(
                                    `${reminder.title}\n${reminder.body}\n\n` +
                                        `Die Benachrichtigung ging nicht raus (${result.reason}): ${result.detail}`,
                                );
                            }
                            return {
                                due: reminder.entries.length,
                                notified: true,
                                message: reminder.title,
                            };
                        },
                        { print: (v) => console.log((v as { message: string }).message) },
                    );
                },
            })
            .command({
                command: 'email <id>',
                describe: "Print the mail draft for the schedule's last issued invoice (not sent)",
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string', describe: 'Schedule id (see `recurring list`)' })
                        .option('template', { type: 'string', describe: 'Id of a mail template of the entity' })
                        .option('json', recurringViewOptions.json),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const id = String(raw.id);
                    const print = raw.json
                        ? printJson
                        : (m: ReturnType<typeof recurringEmail>) => {
                              const { number, period } = m.invoice;
                              console.log(
                                  `Rechnung: ${number || '(ohne Nummer)'}` +
                                      (period
                                          ? `, Leistungszeitraum ${deDate(period.start)} – ${deDate(period.end)}`
                                          : ''),
                              );
                              console.log(`An:      ${m.to ?? '(keine E-Mail hinterlegt)'}`);
                              console.log(`Betreff: ${m.subject}`);
                              if (m.unknownPlaceholders.length)
                                  console.log(
                                      `Warnung: unbekannte Platzhalter ${m.unknownPlaceholders.map((p) => `{${p}}`).join(', ')}`,
                                  );
                              if (m.missingValues.length)
                                  console.log(
                                      `Warnung: fehlende Werte: ${m.missingValues.map((p) => `{${p}}`).join(', ')}`,
                                  );
                              console.log('');
                              console.log(m.body);
                          };
                    runAndExit(
                        async () => {
                            const draft = recurringEmail(id, undefined, pickArgv<string>(raw, 'template'));
                            print(draft);
                            if (draft.unknownPlaceholders.length)
                                throw new Error(
                                    `Nicht versandfertig: unbekannte Platzhalter ${draft.unknownPlaceholders.map((p) => `{${p}}`).join(', ')}. Vorlage korrigieren.`,
                                );
                            return draft;
                        },
                        { print: () => {} },
                    );
                },
            }),
};

/** Require --entity for the self back-end commands. */
const entityOption = {
    entity: { type: 'string' as const, demandOption: true, describe: 'Workspace entity id (e.g. jumplink)' },
};

/** `invoices self …` — the self (local) outgoing-invoice back-end: own numbering + PDF + XRechnung. */
const selfCommand: CommandModule = {
    command: 'self',
    describe: 'Eigene Rechnungen (self back-end): erstellen, festschreiben, PDF/XRechnung, bezahlt, storno',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(
                1,
                'Choose an action: caps, list, show, create, projekt, finalize, pdf, xml, mark-paid, cancel, suggest-paid, doppelzahlung, doppelzahlung-entscheiden, forderungen, mahnung',
            )
            .command({
                command: 'caps',
                describe: 'Show the entity back-end + its capabilities',
                builder: (y2) => y2.option('entity', entityOption.entity),
                handler: (argv) => {
                    const entity = String((argv as Record<string, unknown>).entity);
                    runAndExit(async () => getInvoiceCapabilities(entity));
                },
            })
            .command({
                command: 'list',
                describe: 'List issued invoices for an entity',
                builder: (y2) =>
                    y2.option('entity', entityOption.entity).option('status', {
                        type: 'string',
                        describe: 'Filter by status (draft|open|paid|cancelled)',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () =>
                        listOutgoingInvoicesFor(String(raw.entity), { status: pickArgv<string>(raw, 'status') }),
                    );
                },
            })
            .command({
                command: 'show <id>',
                describe: 'Show one invoice in detail',
                builder: (y2) => y2.positional('id', { type: 'string' }).option('entity', entityOption.entity),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => getOutgoingInvoice(String(raw.entity), String(raw.id)));
                },
            })
            .command({
                command: 'create <spec>',
                describe: 'Create a DRAFT from a JSON spec ({ contactId?, recipient?, ...InvoiceSpec })',
                builder: (y2) =>
                    y2
                        .positional('spec', { type: 'string', describe: 'Path to the spec JSON' })
                        .option('entity', entityOption.entity)
                        .option('projekt', { type: 'string', describe: 'Projekt-Id: Rechnung diesem Projekt zuordnen' })
                        .option('zeiten', {
                            type: 'boolean',
                            describe:
                                'Offene Zeiten des Projekts als Positionen übernehmen (braucht --projekt, --stundensatz, --ust)',
                        })
                        .option('gruppierung', {
                            type: 'string',
                            choices: ['task', 'gesamt'],
                            default: 'task',
                            describe: 'Zeiten je Tätigkeit (task) oder als eine Position (gesamt)',
                        })
                        .option('stundensatz', {
                            type: 'number',
                            describe: 'Netto-Stundensatz für die Zeit-Positionen',
                        })
                        .option('ust', {
                            type: 'number',
                            describe: 'USt-Satz der Zeit-Positionen als Bruch, z. B. 0.19',
                        })
                        .option('zeit', {
                            type: 'array',
                            string: true,
                            describe: 'Nur diese Zeiteintrag-Id(s) übernehmen (Standard: alle offenen)',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => {
                        const entity = String(raw.entity);
                        const input = JSON.parse(readFileSync(String(raw.spec), 'utf-8')) as CreateInvoiceInput;
                        const projektId = pickArgv<string>(raw, 'projekt');
                        if (!raw.zeiten)
                            return saveOutgoingInvoiceDraft(entity, input, undefined, undefined, {
                                projectId: projektId,
                            });
                        if (!projektId) throw new Error('--zeiten braucht --projekt.');
                        const ust = pickArgv<number>(raw, 'ust');
                        if (ust == null) throw new Error('--zeiten braucht --ust (USt-Satz als Bruch, z. B. 0.19).');
                        const time = buildProjectTimeDraft(entity, getProject(entity, projektId), {
                            grouping: raw.gruppierung === 'gesamt' ? 'gesamt' : 'task',
                            hourlyRate: pickArgv<number>(raw, 'stundensatz'),
                            vatRate: ust,
                            entryIds: (raw.zeit as string[] | undefined)?.length ? (raw.zeit as string[]) : undefined,
                        });
                        const withTime: CreateInvoiceInput = {
                            ...input,
                            items: [...input.items, ...time.items],
                            performanceStart: input.performanceStart ?? time.performanceStart,
                            performanceEnd: input.performanceEnd ?? time.performanceEnd,
                        };
                        return saveOutgoingInvoiceDraft(entity, withTime, undefined, undefined, {
                            projectId: projektId,
                            timeEntryIds: time.entryIds,
                        });
                    });
                },
            })
            .command({
                command: 'projekt <id> [projekt]',
                describe: 'Rechnung einem Projekt zuordnen (Projekt-Id) oder mit --aufheben lösen',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string', describe: 'Rechnungs-Id' })
                        .positional('projekt', { type: 'string', describe: 'Projekt-Id' })
                        .option('entity', entityOption.entity)
                        .option('aufheben', { type: 'boolean', describe: 'Direkte Zuordnung zurücknehmen' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => {
                        const entity = String(raw.entity);
                        const id = String(raw.id);
                        if (raw.aufheben) {
                            const war = clearRechnungProjekt(entity, id);
                            return { id, projekt: null, geaendert: war };
                        }
                        const projekt = pickArgv<string>(raw, 'projekt');
                        if (!projekt) return { id, projekt: getRechnungProjekt(entity, id) };
                        const change = setRechnungProjekt(entity, id, projekt);
                        return { id, projekt, geaendert: change === 'assigned' };
                    });
                },
            })
            .command({
                command: 'delete <id>',
                describe: 'Delete a DRAFT invoice',
                builder: (y2) => y2.positional('id', { type: 'string' }).option('entity', entityOption.entity),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => {
                        await deleteOutgoingInvoiceDraft(String(raw.entity), String(raw.id));
                        return { deleted: String(raw.id) };
                    });
                },
            })
            .command({
                command: 'finalize <id>',
                describe: 'Festschreiben: assign the number, freeze, render + archive (irreversible)',
                builder: (y2) => y2.positional('id', { type: 'string' }).option('entity', entityOption.entity),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => finalizeOutgoingInvoice(String(raw.entity), String(raw.id)));
                },
            })
            .command({
                command: 'pdf <id>',
                describe: 'Fetch the invoice PDF (writes to --out, else prints the hosted URL)',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string' })
                        .option('entity', entityOption.entity)
                        .option('out', { type: 'string', describe: 'Write the PDF bytes to this file' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const out = pickArgv<string>(raw, 'out');
                    runAndExit(async () => {
                        const file = await getOutgoingInvoicePdf(String(raw.entity), String(raw.id));
                        if (!file) return { message: 'Kein PDF verfügbar.' };
                        if (file.kind === 'url') return { url: file.url };
                        if (out) {
                            writeFileSync(out, file.bytes);
                            return { written: out, bytes: file.bytes.length };
                        }
                        return { bytes: file.bytes.length, filename: file.filename, hint: 'use --out to save' };
                    });
                },
            })
            .command({
                command: 'xml <id>',
                describe: 'Fetch the XRechnung XML (writes to --out, else prints it)',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string' })
                        .option('entity', entityOption.entity)
                        .option('out', { type: 'string', describe: 'Write the XML to this file' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const out = pickArgv<string>(raw, 'out');
                    runAndExit(
                        async () => {
                            const file = await getOutgoingInvoiceXml(String(raw.entity), String(raw.id));
                            if (!file || file.kind !== 'bytes') return null;
                            const xml = new TextDecoder().decode(file.bytes);
                            if (out) {
                                writeFileSync(out, xml);
                                return { written: out, bytes: file.bytes.length };
                            }
                            return xml;
                        },
                        { print: (v) => (typeof v === 'string' ? process.stdout.write(v) : printJson(v)) },
                    );
                },
            })
            .command({
                command: 'mark-paid <id>',
                describe: 'Mark an open invoice paid (optionally link a transaction)',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string' })
                        .option('entity', entityOption.entity)
                        .option('tx', { type: 'string', describe: 'Store transaction id that settled it' })
                        .option('date', { type: 'string', describe: 'Payment date YYYY-MM-DD (default: today)' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () =>
                        markOutgoingInvoicePaid(String(raw.entity), String(raw.id), {
                            txId: pickArgv<string>(raw, 'tx'),
                            paidAt: pickArgv<string>(raw, 'date'),
                        }),
                    );
                },
            })
            .command({
                command: 'cancel <id>',
                describe: 'Cancel via a storno counter-invoice',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string' })
                        .option('entity', entityOption.entity)
                        .option('reason', { type: 'string', describe: 'Storno reason (printed on the credit note)' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () =>
                        cancelOutgoingInvoice(String(raw.entity), String(raw.id), {
                            reason: pickArgv<string>(raw, 'reason'),
                        }),
                    );
                },
            })
            .command({
                command: 'suggest-paid <id>',
                describe: 'Suggest the bank transaction that settled this invoice',
                builder: (y2) => y2.positional('id', { type: 'string' }).option('entity', entityOption.entity),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () => findPaymentCandidates(String(raw.entity), String(raw.id)));
                },
            })
            .command({
                command: 'doppelzahlung',
                describe: 'List credits that look like a double / excess payment + open refunds',
                builder: (y2) =>
                    y2
                        .option('entity', entityOption.entity)
                        .option('year', { type: 'number', describe: 'Only suspicions booked in this year' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entity = String(raw.entity);
                    runAndExit(async () => ({
                        verdacht: await listDoppelzahlungVerdacht(entity, { year: pickArgv<number>(raw, 'year') }),
                        rueckzahlungOffen: listOffeneRueckzahlungen(entity),
                    }));
                },
            })
            .command({
                command: 'doppelzahlung-entscheiden <tx>',
                describe: 'Decide a suspected double payment (exactly one decision flag)',
                builder: (y2) =>
                    y2
                        .positional('tx', { type: 'string', describe: 'The suspicious credit (store transaction id)' })
                        .option('entity', entityOption.entity)
                        .option('ist-doppelzahlung', { type: 'boolean', describe: 'Confirm: neutralised in the EÜR' })
                        .option('in-ordnung', { type: 'boolean', describe: 'Legitimate payment, stop flagging it' })
                        .option('andere-rechnung', { type: 'string', describe: 'Invoice id this credit really pays' })
                        .option('rueckzahlung', {
                            type: 'string',
                            describe: 'Refund debit (tx id) for an already confirmed double payment',
                        })
                        .option('rueckzahlung-extern', {
                            type: 'string',
                            describe: 'Customer refunded outside the accounts on this date (YYYY-MM-DD)',
                        })
                        .option('bezeichnung', {
                            type: 'string',
                            describe: 'Note stored with a confirmed double payment',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(async () =>
                        entscheideDoppelzahlung(
                            String(raw.entity),
                            String(raw.tx),
                            parseEntscheidung({
                                istDoppelzahlung: pickArgv<boolean>(raw, 'istDoppelzahlung', 'ist-doppelzahlung'),
                                inOrdnung: pickArgv<boolean>(raw, 'inOrdnung', 'in-ordnung'),
                                andereRechnung: pickArgv<string>(raw, 'andereRechnung', 'andere-rechnung'),
                                rueckzahlung: pickArgv<string>(raw, 'rueckzahlung'),
                                rueckzahlungExtern: pickArgv<string>(raw, 'rueckzahlungExtern', 'rueckzahlung-extern'),
                                bezeichnung: pickArgv<string>(raw, 'bezeichnung'),
                            }),
                        ),
                    );
                },
            })
            .command({
                command: 'forderungen',
                describe: 'Open outgoing invoices by age, per-customer payment behaviour, Mahnstufe and Verjährung',
                builder: (y2) =>
                    y2
                        .option('entity', entityOption.entity)
                        .option('today', { type: 'string', describe: 'Reference date YYYY-MM-DD (default: today)' })
                        .option('json', {
                            type: 'boolean',
                            default: false,
                            describe: 'Print raw JSON instead of the table',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const print = raw.json ? printJson : formatForderungen;
                    runAndExit(
                        async () => loadForderungen(String(raw.entity), { today: pickArgv<string>(raw, 'today') }),
                        {
                            print,
                        },
                    );
                },
            })
            .command({
                command: 'mahnung <id>',
                describe:
                    'Draft a reminder (stage 1 freundlich · 2 bestimmt · 3 förmlich) — prints text, sends NOTHING; --versandt records that YOU sent it',
                builder: (y2) =>
                    y2
                        .positional('id', { type: 'string', describe: 'Invoice id or number' })
                        .option('entity', entityOption.entity)
                        .option('stufe', {
                            type: 'number',
                            describe: 'Stage 1–3 (default: the next one; required with --versandt)',
                        })
                        .option('versandt', {
                            type: 'boolean',
                            default: false,
                            describe: 'Confirm that you sent this stage yourself — only then it counts as sent',
                        })
                        .option('datum', {
                            type: 'string',
                            describe: 'With --versandt: the date it went out YYYY-MM-DD (default: today)',
                        })
                        .option('today', { type: 'string', describe: 'Reference date YYYY-MM-DD (default: today)' })
                        .option('json', {
                            type: 'boolean',
                            default: false,
                            describe: 'Print raw JSON instead of the text',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entity = String(raw.entity);
                    const id = String(raw.id);
                    const stufe = pickArgv<number>(raw, 'stufe');
                    const today = pickArgv<string>(raw, 'today');
                    if (raw.versandt) {
                        if (stufe == null) {
                            console.error(
                                'Mit --versandt die Stufe angeben (--stufe 1–3): nur eine bestätigte Stufe wird gemerkt.',
                            );
                            process.exit(1);
                        }
                        runAndExit(
                            async () =>
                                markiereMahnungVersandt(entity, id, stufe, {
                                    datum: pickArgv<string>(raw, 'datum'),
                                    today,
                                }),
                            {
                                print: raw.json
                                    ? printJson
                                    : (r) =>
                                          console.log(
                                              `Stufe ${r.stufe} zu ${r.nummer ?? r.rechnungId} als versandt am ${deDate(r.versandtAm)} vermerkt.`,
                                          ),
                            },
                        );
                        return;
                    }
                    runAndExit(async () => entwerfeMahnung(entity, id, stufe, { today }), {
                        print: raw.json
                            ? printJson
                            : (d) =>
                                  console.log(
                                      `Entwurf Stufe ${d.stufe} — NICHT versendet. Nach dem Versand: --versandt --stufe ${d.stufe}\n\nBetreff: ${d.betreff}\n\n${d.text}`,
                                  ),
                    });
                },
            }),
};

/** `invoices e-rechnung …` — incoming e-invoices, read without AI. */
const eRechnungCommand: CommandModule = {
    command: 'e-rechnung',
    describe: 'Incoming e-invoices (XRechnung XML, ZUGFeRD/Factur-X PDF) — read without AI',
    handler: () => {},
    builder: (y) =>
        y.demandCommand(1, 'Choose an action: lesen').command({
            command: 'lesen <file>',
            describe: 'Parse an e-invoice file and print the fields, the §14 UStG classification and warnings as JSON',
            builder: (y2) => y2.positional('file', { type: 'string', describe: 'Path to the .xml or .pdf file' }),
            handler: (argv) => {
                const raw = argv as Record<string, unknown>;
                runAndExit(async () => readEInvoiceFile(String(raw.file)));
            },
        }),
};

export const invoicesCommand: CommandModule = {
    command: 'invoices',
    describe: 'Fetch invoices from service providers and optionally import to Paperless',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a source: inwx, recurring, self, e-rechnung')
            .command({
                command: 'inwx',
                describe: 'INWX domain registrar invoices',
                handler: () => {},
                builder: (y) =>
                    y
                        .demandCommand(1, 'Choose an action: list, download, import, update')
                        .command({
                            command: 'list',
                            describe: 'List INWX invoices',
                            builder: (y2) =>
                                y2.option('from', dateFilterOptions.from).option('to', dateFilterOptions.to),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const from = pickArgv<string>(raw, 'from');
                                const to = pickArgv<string>(raw, 'to');
                                const provider = createInwxProvider();
                                runAndExit(() => listProviderInvoices(provider, { from, to }));
                            },
                        })
                        .command({
                            command: 'download',
                            describe: 'Download INWX invoice PDFs to local directory',
                            builder: (y2) =>
                                y2
                                    .option('from', dateFilterOptions.from)
                                    .option('to', dateFilterOptions.to)
                                    .option('id', { type: 'array', string: true, describe: 'Specific invoice ID(s)' })
                                    .option('output-dir', {
                                        type: 'string',
                                        describe: 'Output directory (default: invoices/inwx/)',
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const from = pickArgv<string>(raw, 'from');
                                const to = pickArgv<string>(raw, 'to');
                                const ids = raw.id as string[] | undefined;
                                const outputDir = pickArgv<string>(raw, 'outputDir', 'output-dir');
                                const provider = createInwxProvider();
                                runAndExit(() =>
                                    downloadProviderInvoices(provider, { filter: { from, to }, ids, outputDir }),
                                );
                            },
                        })
                        .command({
                            command: 'import',
                            describe: 'Download INWX invoices and import to Paperless (with LLM extraction)',
                            builder: (y2) =>
                                y2
                                    .option('from', dateFilterOptions.from)
                                    .option('to', dateFilterOptions.to)
                                    .option('id', { type: 'array', string: true, describe: 'Specific invoice ID(s)' })
                                    .option('dry-run', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'List invoices without importing',
                                    })
                                    .option('skip-extraction', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'Skip LLM extraction (only set API+config metadata)',
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const from = pickArgv<string>(raw, 'from');
                                const to = pickArgv<string>(raw, 'to');
                                const ids = raw.id as string[] | undefined;
                                const dryRun = Boolean(raw['dry-run'] || raw['dryRun']);
                                const skipExtraction = Boolean(raw['skip-extraction'] || raw['skipExtraction']);
                                const provider = createInwxProvider();
                                runAndExit(() =>
                                    importProviderInvoices(provider, {
                                        filter: { from, to },
                                        ids,
                                        dryRun,
                                        skipExtraction,
                                        providerKey: 'inwx',
                                    }),
                                );
                            },
                        })
                        .command({
                            command: 'update',
                            describe: 'Update existing Paperless documents with fresh API metadata from INWX',
                            builder: (y2) =>
                                y2
                                    .option('from', dateFilterOptions.from)
                                    .option('to', dateFilterOptions.to)
                                    .option('id', {
                                        type: 'array',
                                        string: true,
                                        describe: 'Specific invoice ID(s) to update',
                                    })
                                    .option('dry-run', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'List matches without updating',
                                    })
                                    .option('skip-extraction', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'Skip LLM extraction (only set API+config metadata)',
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const from = pickArgv<string>(raw, 'from');
                                const to = pickArgv<string>(raw, 'to');
                                const ids = raw.id as string[] | undefined;
                                const dryRun = Boolean(raw['dry-run'] || raw['dryRun']);
                                const skipExtraction = Boolean(raw['skip-extraction'] || raw['skipExtraction']);
                                const provider = createInwxProvider();
                                runAndExit(() =>
                                    updateProviderInvoices(provider, {
                                        filter: { from, to },
                                        ids,
                                        dryRun,
                                        skipExtraction,
                                        providerKey: 'inwx',
                                    }),
                                );
                            },
                        }),
            })
            .command(recurringCommand)
            .command(selfCommand)
            .command(eRechnungCommand),
};
