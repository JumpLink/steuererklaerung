/**
 * `filing` — the "erledigt" side of the Fristen system: record which statutory declarations/
 * payments have been submitted/paid, so the proactive Steuertermine (see `fristen`) stop nagging
 * and the annual USt reconciliation can read the year's filed Vorauszahlungen.
 *
 *   filing record --entity jumplink --kind ustva --period 2026-Q1 --filed 2026-07-05 --declared 58.17
 *   filing record --entity gbr --kind ustva --period 2025-Q4 --filed 2026-03-20 \
 *     --declared 440.57 --paid 2026-04-29 --amount 444.57 --surcharge 4.00
 *   filing list [--entity jumplink] [--year 2026]
 *   filing remove --entity jumplink --kind ustva --period 2026-Q1
 *   filing attach-doc --entity gbr --kind ust-jahr --period 2025 --doc paperless:2900 --role bescheid
 *   filing docs [--entity gbr] [--kind ust-jahr] [--period 2025]
 *   filing detach-doc --entity gbr --kind ust-jahr --period 2025 --doc paperless:2900
 *
 * A USt-VA Zahllast is three DISTINCT numbers, so `record` takes them separately:
 *   --declared  = Anmeldungssoll (the declared Zahllast, Kz 83) → drives the annual Z119
 *   --amount    = the amount actually paid (may include a Säumniszuschlag); paid/legacy value
 *   --surcharge = Säumniszuschlag / steuerliche Nebenleistung (§240 AO) — NOT USt, never in Z119
 */

import type { CommandModule } from 'yargs';
import {
    attachFilingDocument,
    detachFilingDocument,
    listFilingDocuments,
    listFilings,
    recordFiling,
    removeFiling,
} from '../../core/actions/filings.ts';
import type { Filing, FilingDocument } from '@steuererklaerung/store';

const DOC_ROLES = ['bescheid', 'mahnung', 'uebertragungsprotokoll', 'zahlungsbeleg', 'schreiben', 'sonstiges'];

function eur(n: number | null): string {
    return n == null ? '—' : `${n.toFixed(2)} €`;
}

function statusText(f: Filing): string {
    if (f.paidAt) return `bezahlt ${f.paidAt}`;
    if (f.filedAt) return `eingereicht ${f.filedAt}`;
    return 'erfasst (offen)';
}

function printFilings(filings: Filing[], docs: FilingDocument[]): void {
    if (filings.length === 0) {
        console.log('Keine Einträge im Einreichungs-Register.');
        return;
    }
    const docsByKey = new Map<string, FilingDocument[]>();
    for (const d of docs) {
        const key = `${d.entityId}:${d.kind}:${d.period}`;
        docsByKey.set(key, [...(docsByKey.get(key) ?? []), d]);
    }
    console.log(`\nEinreichungs-Register (${filings.length})\n`);
    for (const f of filings) {
        // Prefer the declared Anmeldungssoll (the authoritative figure); show the paid amount +
        // Säumniszuschlag only when they add information beyond the Soll.
        const parts: string[] = [];
        if (f.declaredAmount != null) parts.push(`Soll ${eur(f.declaredAmount)}`);
        if (f.amount != null && (f.declaredAmount == null || f.amount !== f.declaredAmount))
            parts.push(`gezahlt ${eur(f.amount)}`);
        if (f.surcharge != null && f.surcharge !== 0) parts.push(`SZ ${eur(f.surcharge)}`);
        if (f.assessedAmount != null) {
            // The Finanzamt's own figure, always shown next to ours — never instead of it. When
            // the two disagree the gap is the whole point, so it is spelled out rather than left
            // for the reader to subtract.
            const bescheid = `FA ${eur(f.assessedAmount)}${f.assessedAt ? ` (${f.assessedAt})` : ''}`;
            const diff = f.declaredAmount != null ? Math.round((f.assessedAmount - f.declaredAmount) * 100) / 100 : 0;
            parts.push(diff !== 0 ? `${bescheid} ⚠ ${diff > 0 ? '+' : ''}${diff.toFixed(2)} € ggü. Soll` : bescheid);
        }
        const amt = parts.length ? `  ·  ${parts.join(' · ')}` : '';
        const note = f.note ? `  ·  ${f.note}` : '';
        console.log(`  ${f.entityId} · ${f.kind} · ${f.period}  —  ${statusText(f)}${amt}${note}`);
        for (const d of docsByKey.get(`${f.entityId}:${f.kind}:${f.period}`) ?? []) {
            console.log(`        ↳ [${d.role}] ${d.documentRef}${d.note ? ` — ${d.note}` : ''}`);
        }
    }
    console.log('');
}

export const filingCommand: CommandModule = {
    command: 'filing',
    describe: 'Einreichungs-Register: Steuererklärungen/-zahlungen als erledigt erfassen',
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose: record, list, remove, attach-doc, docs, or detach-doc')
            .command({
                command: 'record',
                describe: 'Eine Einreichung/Zahlung erfassen oder aktualisieren (merge)',
                builder: (y) =>
                    y
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace-Entität (gbr|jumplink|privat)',
                        })
                        .option('kind', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Art (ustva|ust-jahr|euer|feststellung|gewst|est|dauerfrist|sonstige)',
                        })
                        .option('period', {
                            type: 'string',
                            demandOption: true,
                            describe: "Periode ('2026-Q2' | '2026-03' | '2025')",
                        })
                        .option('filed', { type: 'string', describe: 'Einreichungsdatum YYYY-MM-DD' })
                        .option('paid', { type: 'string', describe: 'Zahlungsdatum YYYY-MM-DD' })
                        .option('declared', {
                            type: 'number',
                            describe: 'Anmeldungssoll (angemeldete Zahllast, Kz 83) in EUR — treibt Z119',
                        })
                        .option('amount', {
                            type: 'number',
                            describe: 'Tatsächlich gezahlter Betrag in EUR (ggf. inkl. Säumniszuschlag)',
                        })
                        .option('surcharge', {
                            type: 'number',
                            describe: 'Säumniszuschlag / steuerliche Nebenleistung (§240 AO) in EUR — keine USt',
                        })
                        .option('assessed', {
                            type: 'number',
                            describe: 'Vom Finanzamt FESTGESETZTER Betrag laut Bescheid in EUR (negativ = Erstattung)',
                        })
                        .option('assessed-at', { type: 'string', describe: 'Datum des Bescheids YYYY-MM-DD' })
                        .option('note', { type: 'string', describe: 'Notiz' }),
                handler: (argv) => {
                    try {
                        const saved = recordFiling({
                            entityId: String(argv.entity),
                            kind: String(argv.kind),
                            period: String(argv.period),
                            filedAt: argv.filed != null ? String(argv.filed) : undefined,
                            paidAt: argv.paid != null ? String(argv.paid) : undefined,
                            amount: argv.amount != null ? Number(argv.amount) : undefined,
                            declaredAmount: argv.declared != null ? Number(argv.declared) : undefined,
                            surcharge: argv.surcharge != null ? Number(argv.surcharge) : undefined,
                            assessedAmount: argv.assessed != null ? Number(argv.assessed) : undefined,
                            assessedAt: argv.assessedAt != null ? String(argv.assessedAt) : undefined,
                            note: argv.note != null ? String(argv.note) : undefined,
                        });
                        console.log(
                            `Erfasst: ${saved.entityId} · ${saved.kind} · ${saved.period} — ${statusText(saved)}`,
                        );
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'list',
                describe: 'Register auflisten (optional nach Entität/Jahr gefiltert)',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', describe: 'Nur diese Entität' })
                        .option('year', { type: 'number', describe: 'Nur dieses Jahr' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON' }),
                handler: (argv) => {
                    try {
                        const filings = listFilings({
                            entityId: argv.entity != null ? String(argv.entity) : undefined,
                            year: argv.year != null ? Number(argv.year) : undefined,
                        });
                        const docs = listFilingDocuments({
                            entityId: argv.entity != null ? String(argv.entity) : undefined,
                        });
                        if (argv.json) console.log(JSON.stringify(filings, null, 2));
                        else printFilings(filings, docs);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'attach-doc',
                describe: 'Ein DMS-Dokument (Bescheid, Mahnung, Protokoll, …) einer Einreichung zuordnen',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', demandOption: true, describe: 'Workspace-Entität' })
                        .option('kind', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Art (ustva|ust-jahr|euer|feststellung|gewst|est|dauerfrist|sonstige)',
                        })
                        .option('period', { type: 'string', demandOption: true, describe: 'Periode' })
                        .option('doc', {
                            type: 'string',
                            demandOption: true,
                            describe: "Dokument-Referenz, z. B. 'paperless:2777' oder eine Store-Dokument-ID",
                        })
                        .option('role', {
                            type: 'string',
                            default: 'sonstiges',
                            choices: DOC_ROLES,
                            describe: 'Rolle des Dokuments',
                        })
                        .option('note', { type: 'string', describe: 'Notiz' }),
                handler: (argv) => {
                    try {
                        const saved = attachFilingDocument({
                            entityId: String(argv.entity),
                            kind: String(argv.kind),
                            period: String(argv.period),
                            documentRef: String(argv.doc),
                            role: argv.role != null ? String(argv.role) : undefined,
                            note: argv.note != null ? String(argv.note) : undefined,
                        });
                        console.log(
                            `Zugeordnet: [${saved.role}] ${saved.documentRef} → ${saved.entityId} · ${saved.kind} · ${saved.period}`,
                        );
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'docs',
                describe: 'Zugeordnete Dokumente auflisten (optional gefiltert)',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', describe: 'Nur diese Entität' })
                        .option('kind', { type: 'string', describe: 'Nur diese Art' })
                        .option('period', { type: 'string', describe: 'Nur diese Periode' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON' }),
                handler: (argv) => {
                    try {
                        const docs = listFilingDocuments({
                            entityId: argv.entity != null ? String(argv.entity) : undefined,
                            kind: argv.kind != null ? String(argv.kind) : undefined,
                            period: argv.period != null ? String(argv.period) : undefined,
                        });
                        if (argv.json) {
                            console.log(JSON.stringify(docs, null, 2));
                        } else if (docs.length === 0) {
                            console.log('Keine zugeordneten Dokumente.');
                        } else {
                            console.log(`\nZugeordnete Dokumente (${docs.length})\n`);
                            for (const d of docs) {
                                console.log(
                                    `  ${d.entityId} · ${d.kind} · ${d.period}  —  [${d.role}] ${d.documentRef}${d.note ? ` — ${d.note}` : ''}`,
                                );
                            }
                            console.log('');
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'detach-doc',
                describe: 'Eine Dokument-Zuordnung entfernen',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', demandOption: true })
                        .option('kind', { type: 'string', demandOption: true })
                        .option('period', { type: 'string', demandOption: true })
                        .option('doc', { type: 'string', demandOption: true, describe: 'Dokument-Referenz' }),
                handler: (argv) => {
                    try {
                        const removed = detachFilingDocument(
                            String(argv.entity),
                            String(argv.kind),
                            String(argv.period),
                            String(argv.doc),
                        );
                        console.log(removed ? 'Zuordnung entfernt.' : 'Keine passende Zuordnung gefunden.');
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'remove',
                describe: 'Einen Eintrag löschen',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', demandOption: true })
                        .option('kind', { type: 'string', demandOption: true })
                        .option('period', { type: 'string', demandOption: true }),
                handler: (argv) => {
                    try {
                        const removed = removeFiling(String(argv.entity), String(argv.kind), String(argv.period));
                        console.log(removed ? 'Eintrag gelöscht.' : 'Kein passender Eintrag gefunden.');
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
    handler: () => {},
};
