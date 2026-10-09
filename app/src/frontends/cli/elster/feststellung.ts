import { join } from 'node:path';

import { writeFeststellungXml, buildFeststellungEds, feststellungDatenartVersion } from '../../../core/elster/index.ts';
import { feststellungReport, printFeststellungDatenblatt } from '../../../core/actions/elster/feststellung.ts';
import { runEricValidateCommand, printGenerateXmlResult } from '../../../core/actions/elster/eric-cli.ts';
import { feststellungToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster feststellung` — GbR gesonderte u. einheitliche Feststellung: report / generate-xml / validate-eric. */
export const feststellungSubcommand: YargsCommandModule = {
    command: 'feststellung',
    describe: 'Gesonderte u. einheitliche Feststellung (GbR): Datenblatt, FEIN-90-XML, ERiC-Validierung.',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, generate-xml, validate-eric')
            .command({
                command: 'report',
                describe: 'Feststellungs-Datenblatt: Gewinnverteilung + Anlage-EÜR Kennzahlen für Mein ELSTER.',
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
                        const report = await feststellungReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const pdfPath = pickArgv<string>(raw, 'pdf');
                        if (pdfPath != null) {
                            const out =
                                pdfPath ||
                                join(
                                    elster.output_directory,
                                    `feststellung-${elster.entity_id}-${year}-pruefblatt.pdf`,
                                );
                            console.log(
                                `PDF geschrieben: ${await writeSteuerblattPdf(feststellungToSteuerblatt(report, elster), out)}`,
                            );
                        } else if (raw.json) console.log(JSON.stringify(report, null, 2));
                        else printFeststellungDatenblatt(report, elster);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'generate-xml',
                describe: 'Generate the Feststellungserklärung (FEIN 90) EDS XML for Mein ELSTER upload.',
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
                        const report = await feststellungReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const file = writeFeststellungXml(
                            report.result,
                            elster,
                            elster.betrieb,
                            pickArgv<string>(raw, 'output'),
                        );
                        printGenerateXmlResult('feststellung', file, year);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate the Feststellungserklärung XML with the local ERiC library.',
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
                            datenartVersion: feststellungDatenartVersion(year),
                            buildXml: async () => {
                                const elster = parseElsterArgs(raw);
                                if (!elster.betrieb)
                                    throw new Error('No `betrieb` block in the ELSTER config (or pass --xml).');
                                const report = await feststellungReport(loadPaperlessConfig(), elster, year, {
                                    accountKeys: accountKeysFrom(raw),
                                });
                                return buildFeststellungEds(report.result, elster, elster.betrieb);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
