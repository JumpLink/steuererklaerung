import {
    explainFigure,
    listFigures,
    printFigureExplanation,
    printFigureList,
} from '../../../core/actions/elster/explain.ts';
import {
    recordClassificationDecision,
    getDecisionLog,
    removeClassificationDecision,
} from '../../../core/actions/classifications.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster explain` — Herleitung drill-down (S1): resolve a FigureRef into its value + short formula
 * + the contributing transactions with provenance (via Beleg / via Regel / unklassifiziert). EÜR
 * figures only for now. `--list` enumerates the available refs for the year.
 */
export const explainSubcommand: YargsCommandModule = {
    command: 'explain',
    describe:
        'Herleitung einer Kennzahl: eine FigureRef (z.B. euer:2025:expense:4670, euer:2025:total:gewinn) in Wert + Formel + beitragende Buchungen (mit Beleg/Regel-Herkunft) auflösen. --list zeigt alle Refs.',
    builder: (y) =>
        y
            .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
            .option('figure', {
                type: 'string',
                describe:
                    'FigureRef, z.B. euer:expense:4670, euer:total:gewinn, euer:total:ust-zahllast (Jahr aus --year oder in der Ref: euer:2025:…)',
            })
            .option('list', { type: 'boolean', default: false, describe: 'Verfügbare FigureRefs des Jahres auflisten' })
            .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: the --entity accounts)' })
            .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const year = pickArgv<number>(raw, 'year') as number;
        try {
            const accountKeys = accountKeysFrom(raw);
            // The ELSTER config folds in AfA/§24/Privatanteil so the explained figure matches the
            // authoritative EÜR; optional (a bare aggregate is flagged "vorläufig").
            let elster: ReturnType<typeof parseElsterArgs> | undefined;
            try {
                elster = parseElsterArgs(raw);
            } catch {
                elster = undefined;
            }
            if (raw.list) {
                const refs = await listFigures(loadPaperlessConfig(), year, { accountKeys, elster });
                if (raw.json) console.log(JSON.stringify(refs, null, 2));
                else printFigureList(refs, year);
                process.exit(0);
            }
            const figure = pickArgv<string>(raw, 'figure');
            if (!figure) {
                throw new Error('--figure <ref> angeben (oder --list für die verfügbaren Kennzahlen des Jahres).');
            }
            const explanation = await explainFigure(loadPaperlessConfig(), figure, {
                year,
                accountKeys,
                elster,
                entity: pickArgv<string>(raw, 'entity'),
            });
            if (raw.json) console.log(JSON.stringify(explanation, null, 2));
            else printFigureExplanation(explanation);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};

/**
 * `elster reclassify` — persist a MANUAL bookkeeping decision for one transaction (S2): book it
 * under a different SKR03 category (`--category`), record the owner Begründung (`--note`), accept an
 * AI rationale (`--accept-ai`), or remove the override (`--remove`). The manual override wins over
 * the linked document AND the rule chain on the next EÜR build; every decision is appended to the
 * durable decision log (`--log` reads it). Store-scoped: writes the single ledger DB.
 */
export const reclassifySubcommand: YargsCommandModule = {
    command: 'reclassify',
    describe:
        'Buchung manuell umklassifizieren: eine Transaktion unter eine SKR03-Kategorie buchen (--category), mit Begründung (--note) — gewinnt über Beleg/Regel in der EÜR. --log zeigt das Entscheidungsprotokoll, --remove entfernt die Übersteuerung.',
    builder: (y) =>
        y
            .option('tx', {
                type: 'string',
                demandOption: true,
                describe: 'Unified transaction id (e.g. from elster explain / euer --detail)',
            })
            .option('category', {
                type: 'string',
                describe: 'SKR03 category label to book under, e.g. "4930 Bürobedarf"',
            })
            .option('note', { type: 'string', describe: 'Begründung ("warum habe ich das so gebucht")' })
            .option('by', { type: 'string', describe: 'Who decided (e.g. your name); recorded as decided_by' })
            .option('status', {
                choices: ['open', 'suggested', 'confirmed'],
                describe: 'Verification status (default: confirmed)',
            })
            .option('accept-ai', { type: 'boolean', describe: 'Accept the AI rationale (ai_note_accepted = true)' })
            .option('document-id', { type: 'number', describe: 'Paperless document id backing the decision' })
            .option('remove', { type: 'boolean', default: false, describe: 'Remove the decision for this transaction' })
            .option('log', {
                type: 'boolean',
                default: false,
                describe: 'Show the append-only decision log for the transaction',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const tx = pickArgv<string>(raw, 'tx') as string;
        try {
            if (raw.log) {
                const log = getDecisionLog(tx);
                if (raw.json) console.log(JSON.stringify(log, null, 2));
                else if (log.length === 0) console.log(`Kein Entscheidungsprotokoll für Transaktion ${tx}.`);
                else {
                    console.log(`\nEntscheidungsprotokoll — Transaktion ${tx}`);
                    console.log('='.repeat(72));
                    for (const e of log) console.log(`  ${e.at}  ${e.action}  ${JSON.stringify(e.detail)}`);
                    console.log('');
                }
                process.exit(0);
            }
            if (raw.remove) {
                const removed = removeClassificationDecision(tx);
                console.log(removed ? `Übersteuerung für ${tx} entfernt.` : `Keine Übersteuerung für ${tx} vorhanden.`);
                process.exit(0);
            }
            const saved = recordClassificationDecision({
                transactionId: tx,
                category: pickArgv<string>(raw, 'category'),
                note: pickArgv<string>(raw, 'note'),
                decidedBy: pickArgv<string>(raw, 'by'),
                status: pickArgv<'open' | 'suggested' | 'confirmed'>(raw, 'status'),
                aiNoteAccepted: raw['accept-ai'] === true ? true : undefined,
                documentId: pickArgv<number>(raw, 'document-id'),
            });
            if (raw.json) console.log(JSON.stringify(saved, null, 2));
            else {
                console.log(`Entscheidung gespeichert für Transaktion ${saved.transactionId}:`);
                console.log(
                    `  Kategorie: ${saved.category ?? '—'}  ·  Status: ${saved.status}  ·  Quelle: ${saved.source ?? '—'}`,
                );
                if (saved.note) console.log(`  Begründung: ${saved.note}`);
                if (saved.decidedBy) console.log(`  Entschieden von: ${saved.decidedBy}`);
                if (saved.category)
                    console.log('  → Wirkt als manuelle Übersteuerung in der EÜR (gewinnt über Beleg/Regel).');
            }
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
