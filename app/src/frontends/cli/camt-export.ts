import type { CommandModule } from 'yargs';

import { camtExportSummary, camtExportSearch, camtExportList } from '../../core/actions/camt-export.ts';
import { pickArgv, runAndExit } from './output.ts';

export const camtExportCommand: CommandModule = {
    command: 'camt-export',
    describe: 'Read and analyze CAMT.052/053 XML exports (any bank)',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: summary, list, search')
            .option('path', {
                type: 'string',
                alias: 'p',
                demandOption: true,
                describe: 'Path to CAMT XML file or directory containing XML files',
            })
            .command({
                command: 'summary',
                describe: 'Show summary: account, totals, date range',
                handler: (argv) => {
                    runAndExit(() => Promise.resolve(camtExportSummary(String(argv.path))));
                },
            })
            .command({
                command: 'list',
                describe: 'List transactions (paginated)',
                builder: (y) =>
                    y
                        .option('limit', { type: 'number', default: 50, describe: 'Max items' })
                        .option('offset', { type: 'number', default: 0, describe: 'Skip first N items' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(() =>
                        Promise.resolve(
                            camtExportList(String(argv.path), {
                                limit: pickArgv<number>(raw, 'limit'),
                                offset: pickArgv<number>(raw, 'offset'),
                            }),
                        ),
                    );
                },
            })
            .command({
                command: 'search',
                describe: 'Search transactions by text, date, amount, or type',
                builder: (y) =>
                    y
                        .option('query', {
                            type: 'string',
                            alias: 'q',
                            describe: 'Text search (name, purpose, reference)',
                        })
                        .option('date-from', { type: 'string', describe: 'From date (YYYY-MM-DD)' })
                        .option('date-to', { type: 'string', describe: 'To date (YYYY-MM-DD)' })
                        .option('min-amount', { type: 'number', describe: 'Minimum absolute amount' })
                        .option('max-amount', { type: 'number', describe: 'Maximum absolute amount' })
                        .option('type', {
                            type: 'string',
                            choices: ['income', 'expense'],
                            describe: 'Filter income or expense',
                        })
                        .option('limit', { type: 'number', default: 50, describe: 'Max results' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(() =>
                        Promise.resolve(
                            camtExportSearch(String(argv.path), {
                                query: pickArgv<string>(raw, 'query'),
                                dateFrom: pickArgv<string>(raw, 'dateFrom', 'date-from'),
                                dateTo: pickArgv<string>(raw, 'dateTo', 'date-to'),
                                minAmount: pickArgv<number>(raw, 'minAmount', 'min-amount'),
                                maxAmount: pickArgv<number>(raw, 'maxAmount', 'max-amount'),
                                type: pickArgv<string>(raw, 'type') as 'income' | 'expense' | undefined,
                                limit: pickArgv<number>(raw, 'limit'),
                            }),
                        ),
                    );
                },
            }),
};
