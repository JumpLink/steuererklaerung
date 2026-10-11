/**
 * `contracts` — Verträge (ADR 0004): the contracts stored in the ledger with their next notice
 * deadline, `contracts speichern` to create or change one, `abgleich <id>` for the candidate bookings
 * and findings (fehlt / zurückgebucht / geändert), `fristen` for the upcoming notice deadlines (also
 * as .ics), and `buchung` / `dokument` to record what belongs to a contract. `--json` gives the raw model.
 */

import { writeFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';
import {
    CONTRACT_CYCLES,
    CONTRACT_DOCUMENT_ROLES,
    CONTRACT_PAYMENT_METHODS,
    CONTRACT_STATUSES,
    type ContractCycle,
    type ContractDocumentRole,
    type ContractInput,
    type ContractPaymentMethod,
    type ContractStatus,
    NOTICE_UNITS,
    type NoticeUnit,
} from '@steuererklaerung/store';
import {
    archiveContractRecord,
    contractDeadlines,
    contractDeadlinesIcs,
    type ContractMatch,
    type ContractSummary,
    decideContractTransaction,
    linkContractDocument,
    loadContract,
    loadContracts,
    matchContract,
    saveContractRecord,
} from '../../core/actions/contracts.ts';
import { type ContractFinding, type NoticeDeadline, parseReminderOffsets } from '../../core/contracts/contracts.ts';
import { fmtDe } from '../../core/lib/money.ts';
import { runAndExit } from './output.ts';

const jsonOption = { json: { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' } } as const;

function fristText(d: NoticeDeadline): string {
    if (d.kind === 'fixed') return `kündigen bis ${d.latestNotice} (${d.daysLeft} Tage) → Ende ${d.termEnd}`;
    if (d.kind === 'anytime') return `jederzeit kündbar, frühestens zum ${d.termEnd}`;
    return d.reason;
}

function printList(list: ContractSummary[]): void {
    if (!list.length) {
        console.log('Keine Verträge. → anlegen: contracts speichern --entity <id> --name <name> …');
        return;
    }
    for (const c of list) {
        const betrag = c.amount != null ? `${fmtDe(c.amount)} €`.padStart(12) : ''.padStart(12);
        console.log(`  ${c.name.slice(0, 32).padEnd(32)}  ${betrag}  ${(c.cycle ?? '').padEnd(16)}  ${c.status}`);
        console.log(`      ${fristText(c.deadline)}   [${c.id}]`);
    }
    const sum = list.reduce((s, c) => s + (c.status === 'active' ? (c.monthlyAmount ?? 0) : 0), 0);
    console.log(`\nAktiv pro Monat: ${fmtDe(sum)} €`);
}

function findingText(f: ContractFinding): string {
    if (f.kind === 'missing')
        return `${f.expectedDate}  fehlt${f.expectedAmount != null ? ` (${fmtDe(f.expectedAmount)} €)` : ''}`;
    if (f.kind === 'returned') return `${f.date}  zurückgebucht ${fmtDe(f.amount)} € (Lastschrift ${f.originalTxId})`;
    if (f.kind === 'no_data') return `${f.since}  keine Kontodaten seit diesem Tag — Import aktualisieren`;
    const geaendert = `Betrag geändert: ${fmtDe(Math.abs(f.amount))} € statt ${fmtDe(f.expectedAmount)} € (${f.txId})`;
    return `${f.date}  ${geaendert}${f.hint ? `\n              ${f.hint}` : ''}`;
}

function printMatch(m: ContractMatch): void {
    console.log(`${m.contract.name} — Datenstand ${m.asOf ?? '—'}`);
    console.log(`\nKandidaten (${m.candidates.length})`);
    for (const c of m.candidates) {
        const flags = [
            c.linked ? 'zugeordnet' : 'offen',
            `über ${c.via}`,
            c.inAmountWindow ? null : 'Betrag abweichend',
        ]
            .filter(Boolean)
            .join(' · ');
        console.log(
            `  ${c.bookingDate}  ${fmtDe(c.amount).padStart(10)} €  ${(c.counterparty ?? '').slice(0, 28).padEnd(28)}  ${flags}  [${c.txId}]`,
        );
    }
    if (m.accounts.length > 1) {
        console.log(`\nZahlungen von ${m.accounts.length} Konten — Lastschrift ggf. umgezogen`);
        for (const a of m.accounts) console.log(`  ${a.accountKey}: ${a.payments}× ${a.first} … ${a.last}`);
    }
    console.log(`\nBefunde (${m.findings.length})`);
    for (const f of m.findings) console.log(`  ${findingText(f)}`);
    console.log('\n→ zuordnen: contracts buchung <id> <txId> --als linked|rejected|none');
}

const num = (v: unknown) => (v === undefined ? undefined : v === 'null' ? null : Number(v));
const str = (v: unknown) => (v === undefined ? undefined : v === 'null' || v === '' ? null : String(v));

export const contractsCommand: CommandModule = {
    command: 'contracts',
    describe: 'Verträge: Laufzeit, Kündigungsfristen, zugeordnete Buchungen und Dokumente, Abgleich',
    builder: (y) =>
        y
            .command({
                command: ['liste', '$0'],
                describe: 'Verträge mit monatlichem Betrag und nächster Kündigungsfrist',
                builder: (yy) =>
                    yy
                        .option('entity', { type: 'string', describe: 'Nur diese Entität' })
                        .option('archiviert', { type: 'boolean', default: false, describe: 'Auch archivierte' })
                        .options(jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () =>
                            loadContracts({
                                entityId: argv.entity as string | undefined,
                                includeArchived: Boolean(argv.archiviert),
                            }),
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : printList },
                    ),
            })
            .command({
                command: 'zeigen <id>',
                describe: 'Ein Vertrag mit Buchungsentscheidungen und Dokumenten',
                builder: (yy) => yy.positional('id', { type: 'string', demandOption: true }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const d = loadContract(String(argv.id));
                        if (!d) throw new Error(`Unbekannter Vertrag ${argv.id}`);
                        return d;
                    }),
            })
            .command({
                command: 'speichern',
                describe: 'Vertrag anlegen (ohne --id: --entity und --name nötig) oder ändern; "null" leert ein Feld',
                builder: (yy) =>
                    yy
                        .option('id', { type: 'string', describe: 'Diesen Vertrag ändern' })
                        .option('entity', { type: 'string', describe: 'Entität (beim Anlegen)' })
                        .option('name', { type: 'string' })
                        .option('anbieter', { type: 'string', describe: 'Gegenpartei wie auf dem Kontoauszug' })
                        .option('anbieter-ref', { type: 'string', describe: 'DMS-Korrespondent, z. B. paperless:12' })
                        .option('vertragsnummer', { type: 'string' })
                        .option('konto', { type: 'string', describe: 'Account-Key, von dem bezahlt wird' })
                        .option('kategorie', { type: 'string' })
                        .option('betrag', { type: 'string', describe: 'EUR pro Zahlung' })
                        .option('zyklus', { choices: [...CONTRACT_CYCLES, 'null'] })
                        .option('toleranz', { type: 'string', describe: 'EUR Abweichung, die noch passt' })
                        .option('beginn', { type: 'string', describe: 'JJJJ-MM-TT' })
                        .option('laufzeit', { type: 'string', describe: 'Erstlaufzeit in Monaten' })
                        .option('verlaengerung', {
                            type: 'string',
                            describe: 'Monate je Verlängerung; null = unbefristet',
                        })
                        .option('frist', { type: 'string', describe: 'Kündigungsfrist (Zahl)' })
                        .option('frist-einheit', { choices: [...NOTICE_UNITS, 'null'] })
                        .option('auto-verlaengerung', { type: 'boolean' })
                        .option('ende', { type: 'string', describe: 'JJJJ-MM-TT' })
                        .option('zahlart', { choices: [...CONTRACT_PAYMENT_METHODS, 'null'] })
                        .option('glaeubiger-id', { type: 'string' })
                        .option('mandatsreferenz', { type: 'string' })
                        .option('iban', { type: 'string', describe: 'IBAN des Anbieters' })
                        .option('suchtext', { type: 'string', describe: 'Text, den eine Buchung enthalten muss' })
                        .option('status', { choices: CONTRACT_STATUSES })
                        .option('notiz', { type: 'string' }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const input: ContractInput = {
                            id: argv.id as string | undefined,
                            entityId: argv.entity as string | undefined,
                            name: argv.name as string | undefined,
                            counterparty: str(argv.anbieter),
                            counterpartyRef: str(argv['anbieter-ref']),
                            contractNumber: str(argv.vertragsnummer),
                            accountKey: str(argv.konto),
                            category: str(argv.kategorie),
                            amount: num(argv.betrag),
                            cycle: str(argv.zyklus) as ContractCycle | null | undefined,
                            amountTolerance: num(argv.toleranz),
                            startDate: str(argv.beginn),
                            initialTermMonths: num(argv.laufzeit),
                            renewalMonths: num(argv.verlaengerung),
                            noticeValue: num(argv.frist),
                            noticeUnit: str(argv['frist-einheit']) as NoticeUnit | null | undefined,
                            autoRenewal: argv['auto-verlaengerung'] as boolean | undefined,
                            endDate: str(argv.ende),
                            paymentMethod: str(argv.zahlart) as ContractPaymentMethod | null | undefined,
                            creditorId: str(argv['glaeubiger-id']),
                            mandateReference: str(argv.mandatsreferenz),
                            counterpartyIban: str(argv.iban),
                            matchText: str(argv.suchtext),
                            status: argv.status as ContractStatus | undefined,
                            notes: str(argv.notiz),
                        };
                        return saveContractRecord(input);
                    }),
            })
            .command({
                command: 'archivieren <id>',
                describe: 'Vertrag aus der Liste nehmen (Zuordnungen bleiben)',
                builder: (yy) => yy.positional('id', { type: 'string', demandOption: true }),
                handler: (argv) =>
                    runAndExit(async () => {
                        if (!archiveContractRecord(String(argv.id))) throw new Error(`Unbekannter Vertrag ${argv.id}`);
                        return { archived: String(argv.id) };
                    }),
            })
            .command({
                command: 'abgleich <id>',
                describe: 'Passende Buchungen und Befunde: fehlende, zurückgebuchte und geänderte Zahlungen',
                builder: (yy) => yy.positional('id', { type: 'string', demandOption: true }).options(jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const m = matchContract(String(argv.id));
                            if (!m) throw new Error(`Unbekannter Vertrag ${argv.id}`);
                            return m;
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : printMatch },
                    ),
            })
            .command({
                command: 'buchung <id> <txId>',
                describe: 'Eine Buchung dem Vertrag zuordnen, ablehnen oder die Entscheidung zurücknehmen',
                builder: (yy) =>
                    yy
                        .positional('id', { type: 'string', demandOption: true })
                        .positional('txId', { type: 'string', demandOption: true })
                        .option('als', { choices: ['linked', 'rejected', 'none'] as const, demandOption: true }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const status = argv.als === 'none' ? null : (argv.als as 'linked' | 'rejected');
                        decideContractTransaction(String(argv.id), String(argv.txId), status, 'cli');
                        return { id: String(argv.id), txId: String(argv.txId), status };
                    }),
            })
            .command({
                command: 'dokument <id> <ref>',
                describe: 'Ein DMS-Dokument (z. B. paperless:123) dem Vertrag zuordnen oder lösen',
                builder: (yy) =>
                    yy
                        .positional('id', { type: 'string', demandOption: true })
                        .positional('ref', { type: 'string', demandOption: true })
                        .option('rolle', {
                            choices: [...CONTRACT_DOCUMENT_ROLES, 'none'],
                            describe: `Rolle des Dokuments (${CONTRACT_DOCUMENT_ROLES.join(' | ')}); none löst die Zuordnung`,
                        }),
                handler: (argv) =>
                    runAndExit(async () => {
                        if (!argv.rolle)
                            throw new Error(
                                `--rolle fehlt. Erlaubt: ${[...CONTRACT_DOCUMENT_ROLES, 'none'].join(', ')} (none löst die Zuordnung)`,
                            );
                        const role = argv.rolle === 'none' ? null : (argv.rolle as ContractDocumentRole);
                        linkContractDocument(String(argv.id), String(argv.ref), role);
                        return { id: String(argv.id), documentRef: String(argv.ref), role };
                    }),
            })
            .command({
                command: 'fristen',
                describe: 'Kündigungsfristen der nächsten Tage, früheste zuerst; --ics schreibt eine Kalenderdatei',
                builder: (yy) =>
                    yy
                        .option('entity', { type: 'string' })
                        .option('tage', { type: 'number', default: 90 })
                        .option('ics', { type: 'string', describe: 'Pfad der .ics-Datei' })
                        .option('erinnerung', {
                            type: 'string',
                            default: '3m,2m,14d',
                            describe:
                                'Gestaffelte Erinnerungen vor der letzten Kündigungsfrist (Monate m, Tage d), nur mit --ics',
                        })
                        .options(jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const opts = {
                                entityId: argv.entity as string | undefined,
                                days: Number(argv.tage),
                                reminders: parseReminderOffsets(String(argv.erinnerung)),
                            };
                            if (argv.ics) {
                                writeFileSync(String(argv.ics), contractDeadlinesIcs(opts));
                                return { ics: String(argv.ics), count: contractDeadlines(opts).length };
                            }
                            return contractDeadlines(opts);
                        },
                        {
                            print: (v) => {
                                if (argv.json || !Array.isArray(v)) return console.log(JSON.stringify(v, null, 2));
                                if (!v.length)
                                    return console.log(`Keine Kündigungsfrist in den nächsten ${argv.tage} Tagen.`);
                                for (const { contract, deadline } of v) {
                                    console.log(
                                        `  ${deadline.latestNotice}  ${contract.name.slice(0, 32).padEnd(32)}  Ende ${deadline.termEnd}  [${contract.id}]`,
                                    );
                                }
                            },
                        },
                    ),
            }),
    handler: () => {},
};
