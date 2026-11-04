import { aufgabebilanzReport, printAufgabebilanz } from '../../../core/actions/elster/aufgabebilanz.ts';
import { exportAufgabeAnlagen } from '../../../core/actions/elster/aufgabe-anlagen.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster aufgabebilanz` — Bilanz on the Betriebsaufgabe date + Übergangsgewinn (R 4.5 Abs. 6 EStR). */
export const aufgabebilanzSubcommand: YargsCommandModule = {
    command: 'aufgabebilanz',
    describe: 'Aufgabebilanz zum Tag der Betriebsaufgabe + Übergangsgewinn (Wechsel zum Bestandsvergleich).',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, export')
            .command({
                command: 'report',
                describe:
                    'Aufgabebilanz, Übergangsgewinn (Anlage zu R 4.6 EStR) und Überleitung zum laufenden Gewinn der EÜR.',
                builder: (yy) =>
                    yy
                        .option('year', {
                            type: 'number',
                            demandOption: true,
                            describe: 'Tax year of the Aufgabe, e.g. 2025',
                        })
                        .option('account-key', {
                            type: 'array',
                            describe: 'Account(s) to sum (default: all camt:)',
                        })
                        .option('json', {
                            type: 'boolean',
                            default: false,
                            describe: 'Output raw JSON',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const elster = parseElsterArgs(raw);
                        const report = await aufgabebilanzReport(loadPaperlessConfig(), elster, year, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        if (raw.json) console.log(JSON.stringify(report, null, 2));
                        else printAufgabebilanz(report, elster);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'export',
                describe:
                    'Anlagen zur Feststellungserklärung (Aufgabegewinn, Aufgabebilanz, Übergangsgewinn) als PDF + Markdown schreiben.',
                builder: (yy) =>
                    yy
                        .option('year', {
                            type: 'number',
                            demandOption: true,
                            describe: 'Tax year of the Aufgabe, e.g. 2025',
                        })
                        .option('out', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Output directory (created)',
                        })
                        .option('account-key', {
                            type: 'array',
                            describe: 'Account(s) to sum (default: all camt:)',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    const out = pickArgv<string>(raw, 'out') as string;
                    try {
                        const elster = parseElsterArgs(raw);
                        const { files } = await exportAufgabeAnlagen(loadPaperlessConfig(), elster, year, out, {
                            accountKeys: accountKeysFrom(raw),
                        });
                        for (const f of files) console.log(`geschrieben: ${f}`);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
