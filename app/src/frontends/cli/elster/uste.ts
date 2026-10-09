import { join } from 'node:path';

import { writeUsteXml, buildUsteEds, usteDatenartVersion } from '../../../core/elster/index.ts';
import { computeUsteFormFigures } from '../../../core/elster/uste-aggregate.ts';
import {
    usteReport,
    printUsteReport,
    printUsteVordruck,
    printUsteAnpassungen,
    usteAnpassungen,
    usteVordruckRows,
} from '../../../core/actions/elster/uste.ts';
import { runEricValidateCommand, printGenerateXmlResult } from '../../../core/actions/elster/eric-cli.ts';
import { usteToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster uste` — USt-Jahreserklärung: report / generate-xml / validate-eric. */
export const usteSubcommand: YargsCommandModule = {
    command: 'uste',
    describe: 'USt-Jahreserklärung: annual VAT summary, XML generation, ERiC validation.',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, generate-xml, validate-eric')
            .command({
                command: 'report',
                describe: 'Annual VAT summary + closing balance vs. the filed Voranmeldungen.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
                        .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' })
                        .option('vordruck', {
                            type: 'boolean',
                            default: false,
                            describe: 'Jede Zahl mit ihrer Vordruckzeile des Jahresformulars annotieren (nur Anzeige)',
                        })
                        .option('pdf', {
                            type: 'string',
                            describe: 'Prüf-Datenblatt als PDF in diese Datei schreiben',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const elster = parseElsterArgs(raw);
                        const u = await usteReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const vordruck = Boolean(raw.vordruck);
                        const pdfPath = pickArgv<string>(raw, 'pdf');
                        if (pdfPath != null) {
                            const out =
                                pdfPath ||
                                join(elster.output_directory, `uste-${elster.entity_id}-${year}-pruefblatt.pdf`);
                            console.log(
                                `PDF geschrieben: ${await writeSteuerblattPdf(usteToSteuerblatt(u, elster), out)}`,
                            );
                        } else if (raw.json) {
                            // WITHOUT --vordruck: byte-identical to the established baseline. --vordruck ADDS
                            // the display-only Vordruckzeilen mapping + Anpassungen (no figure changes).
                            const base = { ...u, formFigures: computeUsteFormFigures(u) };
                            const out = vordruck
                                ? {
                                      ...base,
                                      vordruck: usteVordruckRows(u, year),
                                      anpassungen: usteAnpassungen(u, elster, year),
                                  }
                                : base;
                            console.log(JSON.stringify(out, null, 2));
                        } else {
                            printUsteReport(u);
                            if (vordruck) {
                                printUsteVordruck(u, year);
                                printUsteAnpassungen(usteAnpassungen(u, elster, year));
                            }
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'generate-xml',
                describe: 'Generate the USt-Jahreserklärung EDS XML for ERiC validation / Mein ELSTER upload.',
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
                        if (!elster.betrieb) throw new Error('No `betrieb` block in the ELSTER config (incl. widnr).');
                        const u = await usteReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        const file = writeUsteXml(u, elster, elster.betrieb, pickArgv<string>(raw, 'output'));
                        printGenerateXmlResult('uste', file, year);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate the USt-Jahreserklärung XML with the local ERiC library.',
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
                            datenartVersion: usteDatenartVersion(year),
                            buildXml: async () => {
                                const elster = parseElsterArgs(raw);
                                if (!elster.betrieb)
                                    throw new Error('No `betrieb` block in the ELSTER config (or pass --xml).');
                                const u = await usteReport(loadPaperlessConfig(), elster, year, {
                                    accountKeys: accountKeysFrom(raw),
                                });
                                return buildUsteEds(u, elster, elster.betrieb);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
