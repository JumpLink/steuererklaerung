import type { CommandModule } from 'yargs';

import { qontoExportSummary, qontoExportSearch, qontoExportList } from '../../core/actions/qonto-export.ts';
import { pickArgv, runAndExit } from './output.ts';

export const qontoExportCommand: CommandModule = {
    command: 'qonto-export',
    describe: 'Read and analyze Qonto XLS transaction exports',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: summary, list, search')
            .option('file', {
                type: 'string',
                alias: 'f',
                describe: 'Path to XLS export file (default: exports/qonto/...Export.xls)',
            })
            .command({
                command: 'summary',
                describe: 'Show summary: totals, date range, category breakdown',
                handler: (argv) => {
                    const file = pickArgv<string>(argv as Record<string, unknown>, 'file');
                    runAndExit(() => Promise.resolve(qontoExportSummary(file)));
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
                            qontoExportList({
                                file: pickArgv<string>(raw, 'file'),
                                limit: pickArgv<number>(raw, 'limit'),
                                offset: pickArgv<number>(raw, 'offset'),
                            }),
                        ),
                    );
                },
            })
            .command({
                command: 'search',
                describe: 'Search transactions by text, date, amount, category, or type',
                builder: (y) =>
                    y
                        .option('query', {
                            type: 'string',
                            alias: 'q',
                            describe: 'Text search (counterparty, reference, note)',
                        })
                        .option('date-from', { type: 'string', describe: 'From date (YYYY-MM-DD)' })
                        .option('date-to', { type: 'string', describe: 'To date (YYYY-MM-DD)' })
                        .option('min-amount', { type: 'number', describe: 'Minimum absolute amount' })
                        .option('max-amount', { type: 'number', describe: 'Maximum absolute amount' })
                        .option('category', { type: 'string', describe: 'Cashflow category filter' })
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
                            qontoExportSearch({
                                file: pickArgv<string>(raw, 'file'),
                                query: pickArgv<string>(raw, 'query'),
                                dateFrom: pickArgv<string>(raw, 'dateFrom', 'date-from'),
                                dateTo: pickArgv<string>(raw, 'dateTo', 'date-to'),
                                minAmount: pickArgv<number>(raw, 'minAmount', 'min-amount'),
                                maxAmount: pickArgv<number>(raw, 'maxAmount', 'max-amount'),
                                category: pickArgv<string>(raw, 'category'),
                                type: pickArgv<string>(raw, 'type') as 'income' | 'expense' | undefined,
                                limit: pickArgv<number>(raw, 'limit'),
                            }),
                        ),
                    );
                },
            }),
};
