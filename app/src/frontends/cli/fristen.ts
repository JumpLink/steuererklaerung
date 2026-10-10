/**
 * `fristen` — the "Fristen & offene Posten" overview. Three layers:
 *   • reactive: open items (payment_status=offen) from Paperless, ranked by urgency;
 *   • proactive: recurring statutory Steuertermine (Regelfristen) derived from the ELSTER configs;
 *   • payments: filed-but-unpaid tax amounts from the filing register, with estimated due dates.
 * Reads the fields the document-workflow skill records; the proactive layer needs no documents.
 */

import { writeFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';
import { listOpenItems, type OpenItem } from '../../core/actions/fristen.ts';
import { listSteuertermine } from '../../core/actions/steuertermine.ts';
import { listBescheidAbweichungen, listOffeneSteuerzahlungen } from '../../core/actions/steuerzahlungen.ts';
import type { SteuerTermin } from '../../core/elster/steuertermine.ts';
import type { BescheidAbweichung, OffeneSteuerzahlung } from '../../core/elster/steuerzahlungen.ts';
import { buildIcs, type IcsEvent } from '../../core/actions/ics.ts';
import { buildFristenIcsEvents, buildFristenReminder } from '../../core/actions/fristen-reminder.ts';
import { sendDesktopNotification } from '../../core/notify/desktop.ts';
import { pickArgv, runAndExit } from './output.ts';

function eur(n: number | null): string {
    return n == null ? '—' : `${n.toFixed(2)} €`;
}

function fristText(dueDate: string | null, daysUntil: number | null): string {
    if (dueDate == null || daysUntil == null) return 'ohne Frist';
    const n = daysUntil;
    if (n > 0) return `fällig in ${n} Tag${n === 1 ? '' : 'en'} (${dueDate})`;
    if (n === 0) return `heute fällig (${dueDate})`;
    return `ÜBERFÄLLIG seit ${-n} Tag${n === -1 ? '' : 'en'} (${dueDate})`;
}

function printOpenItems(items: OpenItem[], today: string): void {
    if (items.length === 0) {
        console.log(`Offene Posten: keine (Stand ${today}). 🎉\n`);
        return;
    }
    const sum = items.reduce((s, i) => s + (i.amount ?? 0), 0);
    console.log(`Offene Posten — Stand ${today} (${items.length}, Summe bekannter Beträge ${eur(sum)})\n`);
    for (const i of items) {
        const scope = i.dataScope ? `[${i.dataScope}] ` : '';
        const who = i.correspondent ? `${i.correspondent} — ` : '';
        console.log(`  #${i.id}  ${fristText(i.dueDate, i.daysUntil)}`);
        console.log(`        ${scope}${who}${i.title ?? ''}${i.amount != null ? `  ·  ${eur(i.amount)}` : ''}`);
    }
    console.log('');
}

function printSteuerzahlungen(zahlungen: OffeneSteuerzahlung[]): void {
    if (zahlungen.length === 0) return;
    const sum = zahlungen.reduce((s, z) => s + z.amount, 0);
    console.log(
        `Offene Steuerzahlungen — eingereicht, aber noch nicht überwiesen (${zahlungen.length}, Summe ${eur(sum)})\n`,
    );
    for (const z of zahlungen) {
        console.log(`  ${z.entityName}: ${z.label}  ·  ${eur(z.amount)}  ·  ${fristText(z.dueDate, z.daysUntil)}`);
        console.log(`        ↳ ${z.note}`);
    }
    console.log('');
}

function printAbweichungen(abw: BescheidAbweichung[]): void {
    if (abw.length === 0) return;
    console.log(`Bescheid weicht von der Erklärung ab (${abw.length})\n`);
    for (const a of abw) {
        const richtung = a.difference < 0 ? 'weniger' : 'mehr';
        console.log(
            `  ${a.entityName}: ${a.label}  ·  erklärt ${eur(a.declared)} → festgesetzt ${eur(a.assessed)}` +
                `${a.assessedAt ? ` (Bescheid ${a.assessedAt})` : ''}`,
        );
        console.log(
            `        ↳ ${eur(Math.abs(a.difference))} ${richtung} als erklärt. Prüfen, woher die Differenz kommt —` +
                ' ein zu niedriger Bescheid heißt meist, dass unser Vorauszahlungssoll unvollständig war.',
        );
    }
    console.log('');
}

function termineStatusText(t: SteuerTermin): string {
    if (t.status === 'bezahlt') return `✓ bezahlt${t.paidAt ? ` ${t.paidAt}` : ''} (Frist war ${t.dueDate})`;
    if (t.status === 'eingereicht') return `✓ eingereicht${t.filedAt ? ` ${t.filedAt}` : ''} (Frist war ${t.dueDate})`;
    return fristText(t.dueDate, t.daysUntil);
}

function printSteuertermine(termine: SteuerTermin[]): void {
    if (termine.length === 0) return;
    console.log('Kommende Steuertermine (Regelfrist-Schätzung — gegen den Bescheid prüfen)\n');
    for (const t of termine) {
        console.log(`  ${t.entityName}: ${t.label}  ·  ${termineStatusText(t)}`);
        if (!t.status && t.note) console.log(`        ↳ ${t.note}`);
        // Never suppressed by `status`: this line exists precisely BECAUSE the
        // status was derived from the submission evidence instead of the
        // register, and that disagreement is the thing worth acting on.
        if (t.registerGap) console.log(`        ⚠ ${t.registerGap}`);
    }
    console.log('');
}

/** Collect the dated, still-open deadlines as calendar events (open items with a due date + not-yet-filed Steuertermine + unpaid tax amounts). */
function toIcsEvents(items: OpenItem[], termine: SteuerTermin[], zahlungen: OffeneSteuerzahlung[]): IcsEvent[] {
    const events: IcsEvent[] = [];
    for (const i of items) {
        if (!i.dueDate) continue;
        const who = i.correspondent ?? i.title ?? `#${i.id}`;
        const amount = i.amount != null ? ` · ${eur(i.amount)}` : '';
        events.push({
            uid: `openitem-${i.id}`,
            date: i.dueDate,
            summary: `[Offen] ${who}${amount}`,
            description: i.title ?? undefined,
            alarmDaysBefore: 3,
        });
    }
    for (const t of termine) {
        if (t.status) continue; // already filed/paid → no reminder
        events.push({
            uid: t.key,
            date: t.dueDate,
            summary: `[Steuer] ${t.entityName}: ${t.label}`,
            description: t.note,
            alarmDaysBefore: 7,
        });
    }
    for (const z of zahlungen) {
        if (!z.dueDate) continue; // Bescheid-driven due dates are unknown → no calendar entry
        events.push({
            uid: z.key,
            date: z.dueDate,
            summary: `[Steuerzahlung] ${z.entityName}: ${z.label} · ${eur(z.amount)}`,
            description: z.note,
            alarmDaysBefore: 3,
        });
    }
    return events;
}

/** UTC instant as an iCalendar DTSTAMP (YYYYMMDDTHHMMSSZ). */
function icsStamp(): string {
    return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`;
}

export const fristenCommand: CommandModule = {
    command: 'fristen',
    describe: 'Fristen & offene Posten: offene Posten (payment_status=offen) + Regelfrist-Steuertermine',
    builder: (y) =>
        y
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' })
            .option('ics', {
                type: 'string',
                describe: 'Termine als iCalendar-Datei (.ics) für den Kalender schreiben',
            })
            .command({
                command: 'notify',
                describe: 'Überfällige und bald fällige offene Posten per Desktop-Benachrichtigung melden',
                builder: (y2) =>
                    y2.option('lead', { type: 'number', default: 7, describe: 'Vorlauf in Tagen' }).option('print', {
                        type: 'boolean',
                        default: false,
                        describe: 'Nur ausgeben, was gesendet würde — niemanden benachrichtigen',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const leadDays = pickArgv<number>(raw, 'lead');
                    const printOnly = raw.print === true;
                    runAndExit(
                        async () => {
                            const items = await listOpenItems();
                            const reminder = buildFristenReminder(items, { leadDays });
                            if (!reminder) return { due: 0, notified: false, message: 'Nichts fällig.' };
                            if (printOnly) {
                                return {
                                    due: reminder.items.length,
                                    notified: false,
                                    message: `${reminder.title}\n${reminder.body}`,
                                };
                            }
                            const result = sendDesktopNotification({
                                title: `Steuererklärung: ${reminder.title}`,
                                body: reminder.body,
                                urgency: 'critical',
                                appName: 'Steuererklärung',
                                icon: 'x-office-calendar',
                            });
                            // Same contract as `invoices recurring notify`: an undelivered reminder
                            // prints its content and fails, so silence is never ambiguous.
                            if (!result.delivered) {
                                throw new Error(
                                    `${reminder.title}\n${reminder.body}\n\n` +
                                        `Die Benachrichtigung ging nicht raus (${result.reason}): ${result.detail}`,
                                );
                            }
                            return { due: reminder.items.length, notified: true, message: reminder.title };
                        },
                        { print: (v) => console.log((v as { message: string }).message) },
                    );
                },
            })
            .command({
                command: 'ics',
                describe: 'Offene Posten mit Fälligkeit als abonnierbaren .ics-Feed (VEVENT + VALARM) schreiben',
                builder: (y2) => y2.option('out', { type: 'string', demandOption: true, describe: 'Zieldatei (.ics)' }),
                handler: (argv) => {
                    const out = String((argv as Record<string, unknown>).out);
                    runAndExit(
                        async () => {
                            const events = buildFristenIcsEvents(await listOpenItems());
                            writeFileSync(out, buildIcs(events, { dtstamp: icsStamp(), calName: 'Fristen-Wächter' }));
                            return { written: out, events: events.length };
                        },
                        { print: (v) => console.log(`iCalendar geschrieben: ${v.written} (${v.events} Termine)`) },
                    );
                },
            }),
    handler: async (argv) => {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const [items, termine, zahlungen, abweichungen] = await Promise.all([
                listOpenItems({ today }),
                Promise.resolve(listSteuertermine({ today })),
                Promise.resolve(listOffeneSteuerzahlungen({ today })),
                Promise.resolve(listBescheidAbweichungen()),
            ]);
            if (argv.ics) {
                const path = String(argv.ics);
                const events = toIcsEvents(items, termine, zahlungen);
                writeFileSync(path, buildIcs(events, { dtstamp: icsStamp(), calName: 'Steuererklärung — Fristen' }));
                console.log(`iCalendar geschrieben: ${path} (${events.length} Termine)`);
                process.exit(0);
            }
            if (argv.json) {
                console.log(
                    JSON.stringify(
                        {
                            today,
                            openItems: items,
                            steuerzahlungen: zahlungen,
                            bescheidAbweichungen: abweichungen,
                            steuertermine: termine,
                        },
                        null,
                        2,
                    ),
                );
            } else {
                console.log('');
                printOpenItems(items, today);
                printSteuerzahlungen(zahlungen);
                printAbweichungen(abweichungen);
                printSteuertermine(termine);
            }
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
