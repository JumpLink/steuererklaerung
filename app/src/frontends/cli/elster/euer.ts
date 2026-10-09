import { join } from 'node:path';

import { writeEuerXml, buildEuerEds, euerDatenartVersion } from '../../../core/elster/index.ts';
import {
    euerReport,
    printEuerReport,
    euerReportByTransactions,
    printEuerTxReport,
    printEuerTxDetail,
} from '../../../core/actions/elster/euer.ts';
import { runEricValidateCommand, printGenerateXmlResult } from '../../../core/actions/elster/eric-cli.ts';
import { euerToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster euer` — Anlage-EÜR cash-basis aggregate from Paperless + store. */
export const euerSubcommand: YargsCommandModule = {
    command: 'euer',
    describe: 'Anlage EÜR: cash-basis year aggregate from Paperless invoice documents (+ store cross-check).',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, generate-xml, validate-eric')
            .command({
                command: 'generate-xml',
                describe: 'Generate the Anlage-EÜR EDS XML for ERiC validation / Mein ELSTER upload.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
                        .option('output', {
                            type: 'string',
                            describe: 'Output path (default: <output_directory>/euer-<entity>-<year>.xml)',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const elster = parseElsterArgs(raw);
                        if (!elster.betrieb) {
                            throw new Error('No `betrieb` block (name, strasse, plz, ort, art) in the ELSTER config.');
                        }
                        const agg = await euerReportByTransactions(loadPaperlessConfig(), year, {
                            accountKeys: accountKeysFrom(raw),
                            elster,
                        });
                        if (agg.coverage.unclassified.length > 0) {
                            console.error(
                                `⚠ ${agg.coverage.unclassified.length} unklassifizierte Buchung(en) — vor Abgabe klären (elster euer report --by transactions --detail).`,
                            );
                        }
                        const file = writeEuerXml(agg, elster, elster.betrieb, pickArgv<string>(raw, 'output'));
                        printGenerateXmlResult('euer', file, year, 'Then upload manually in Mein ELSTER.');
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate the Anlage-EÜR XML with the local ERiC library (plausibility checks).',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
                        .option('xml', { type: 'string', describe: 'Path to an existing XML file (skip generation)' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        await runEricValidateCommand({
                            xmlPath: pickArgv<string>(raw, 'xml'),
                            datenartVersion: euerDatenartVersion(year),
                            buildXml: async () => {
                                const elster = parseElsterArgs(raw);
                                if (!elster.betrieb) {
                                    throw new Error('No `betrieb` block in the ELSTER config (or pass --xml).');
                                }
                                const agg = await euerReportByTransactions(loadPaperlessConfig(), year, {
                                    accountKeys: accountKeysFrom(raw),
                                    elster,
                                });
                                return buildEuerEds(agg, elster, elster.betrieb);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'report',
                describe: 'EÜR summary + Anlage-EÜR Kennzahlen sheet for a tax year (cash basis).',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('by', {
                            choices: ['transactions', 'documents'],
                            default: 'transactions',
                            describe:
                                'transactions (default) = the authoritative EÜR: sum every bank transaction + fold in AfA/§24/Privatanteil (needs --config); documents = a Paperless-doc-vs-store cross-check only',
                        })
                        .option('account-key', {
                            type: 'array',
                            describe:
                                'Account(s): document mode uses one for the cross-check; transaction mode sums these (default: all camt: accounts)',
                        })
                        .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' })
                        .option('detail', {
                            type: 'boolean',
                            default: false,
                            describe:
                                'transaction mode: list every booking with its category + matched rule (review view)',
                        })
                        .option('pdf', {
                            type: 'string',
                            describe: 'Prüf-Datenblatt als PDF in diese Datei schreiben (nur --by=transactions)',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        // Scope: explicit --account-key wins, else --entity's accounts (never a camt:* blanket
                        // sum); an unresolvable --entity throws here and is reported cleanly below.
                        const accountKeys = accountKeysFrom(raw);
                        if (raw.by === 'transactions') {
                            const detail = raw.detail === true;
                            // Load the ELSTER config if available, so the report includes the
                            // year-end adjustments (AfA / Privatanteile). Optional — the report
                            // still works without an ELSTER config (then no adjustments).
                            let elster: ReturnType<typeof parseElsterArgs> | undefined;
                            try {
                                elster = parseElsterArgs(raw);
                            } catch {
                                elster = undefined;
                            }
                            const agg = await euerReportByTransactions(loadPaperlessConfig(), year, {
                                accountKeys,
                                detail,
                                elster,
                            });
                            const pdfPath = pickArgv<string>(raw, 'pdf');
                            if (pdfPath != null) {
                                if (!elster) {
                                    throw new Error(
                                        'PDF-Export benötigt eine ELSTER-Config — via ELSTER_CONFIG oder --config setzen.',
                                    );
                                }
                                const out =
                                    pdfPath ||
                                    join(elster.output_directory, `euer-${elster.entity_id}-${year}-pruefblatt.pdf`);
                                console.log(
                                    `PDF geschrieben: ${await writeSteuerblattPdf(euerToSteuerblatt(agg, elster), out)}`,
                                );
                            } else if (raw.json) console.log(JSON.stringify(agg, null, 2));
                            else if (detail) printEuerTxDetail(agg);
                            else printEuerTxReport(agg);
                        } else {
                            const agg = await euerReport(loadPaperlessConfig(), year, { accountKey: accountKeys?.[0] });
                            if (raw.json) console.log(JSON.stringify(agg, null, 2));
                            else printEuerReport(agg);
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
