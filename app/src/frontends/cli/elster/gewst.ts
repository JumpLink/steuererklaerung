import { join } from 'node:path';

import { writeGewstXml, buildGewstEds, gewstDatenartVersion } from '../../../core/elster/index.ts';
import { gewstReport, printGewstReport } from '../../../core/actions/elster/gewst.ts';
import { runEricValidateCommand, printGenerateXmlResult } from '../../../core/actions/elster/eric-cli.ts';
import { gewstToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster gewst` — Gewerbesteuer (GewSt 1 A): report / generate-xml / validate-eric. */
export const gewstSubcommand: YargsCommandModule = {
    command: 'gewst',
    describe: 'Gewerbesteuer (GewSt 1 A): Messbetragsermittlung, XML generation, ERiC validation.',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, generate-xml, validate-eric')
            .command({
                command: 'report',
                describe: 'GewSt Messbetragsermittlung aus dem EÜR-Gewinn (€0 unter dem Freibetrag).',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
                        .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' })
                        .option('pdf', {
                            type: 'string',
                            describe: 'Prüf-Datenblatt als PDF in diese Datei schreiben',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const elster = parseElsterArgs(raw);
                        const report = await gewstReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const pdfPath = pickArgv<string>(raw, 'pdf');
                        if (pdfPath != null) {
                            const out =
                                pdfPath ||
                                join(elster.output_directory, `gewst-${elster.entity_id}-${year}-pruefblatt.pdf`);
                            console.log(
                                `PDF geschrieben: ${await writeSteuerblattPdf(gewstToSteuerblatt(report, elster, year), out)}`,
                            );
                        } else if (raw.json) console.log(JSON.stringify(report, null, 2));
                        else printGewstReport(report, elster.gewerbe!, year);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'generate-xml',
                describe: 'Generate the Gewerbesteuererklärung (GewSt 1 A) EDS XML.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
                        .option('output', { type: 'string', describe: 'Output path' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const elster = parseElsterArgs(raw);
                        if (!elster.betrieb) throw new Error('No `betrieb` block in the ELSTER config.');
                        const report = await gewstReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const file = writeGewstXml(
                            report.result,
                            elster,
                            elster.betrieb,
                            year,
                            pickArgv<string>(raw, 'output'),
                        );
                        printGenerateXmlResult('gewst', file, year);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate the Gewerbesteuererklärung XML with the local ERiC library.',
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
                            datenartVersion: gewstDatenartVersion(year),
                            buildXml: async () => {
                                const elster = parseElsterArgs(raw);
                                if (!elster.betrieb)
                                    throw new Error('No `betrieb` block in the ELSTER config (or pass --xml).');
                                const report = await gewstReport(loadPaperlessConfig(), elster, year, {
                                    accountKeys: accountKeysFrom(raw),
                                });
                                return buildGewstEds(report.result, elster, elster.betrieb, year);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
