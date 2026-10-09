import type { Argv, CommandModule } from 'yargs';

import { listImports, newImportBatchId, undoImportBatch } from '../../core/actions/imports.ts';
import { withImportBatch } from '@steuererklaerung/store';
import {
    importCamt,
    importPaypal,
    enrichStoreFromQontoExport,
    enrichStoreFromAmazon,
    searchTransactions,
    syncTransactions,
    transactionsSummary,
    type SearchOptions,
} from '../../core/actions/transactions.ts';
import { pickArgv, runAndExit } from './output.ts';

function searchOptionsFromArgv(raw: Record<string, unknown>): SearchOptions {
    const side = pickArgv<string>(raw, 'type');
    return {
        query: pickArgv<string>(raw, 'query', 'q'),
        from: pickArgv<string>(raw, 'from', 'date-from'),
        to: pickArgv<string>(raw, 'to', 'date-to'),
        minAmount: pickArgv<number>(raw, 'minAmount', 'min-amount'),
        maxAmount: pickArgv<number>(raw, 'maxAmount', 'max-amount'),
        side: side === 'income' || side === 'expense' ? side : undefined,
        source: pickArgv<'qonto' | 'fints' | 'camt'>(raw, 'source'),
        accountKey: pickArgv<string>(raw, 'accountKey', 'account-key'),
        limit: pickArgv<number>(raw, 'limit'),
    };
}

const searchBuilder = (y: Argv) =>
    y
        .option('query', {
            type: 'string',
            alias: 'q',
            describe: 'Text search (counterparty, purpose, reference, IBAN)',
        })
        .option('from', { type: 'string', describe: 'From booking date (YYYY-MM-DD)' })
        .option('to', { type: 'string', describe: 'To booking date (YYYY-MM-DD)' })
        .option('min-amount', { type: 'number', describe: 'Minimum absolute amount (EUR)' })
        .option('max-amount', { type: 'number', describe: 'Maximum absolute amount (EUR)' })
        .option('type', { type: 'string', choices: ['income', 'expense'], describe: 'Filter income or expense' })
        .option('source', { type: 'string', choices: ['qonto', 'fints', 'camt'], describe: 'Filter by source' })
        .option('account-key', { type: 'string', describe: 'Filter by exact accountKey (see "transactions summary")' })
        .option('limit', { type: 'number', default: 50, describe: 'Max results' });

export const transactionsCommand: CommandModule = {
    command: 'transactions',
    describe:
        'Unified transaction store across Qonto + FinTS: incremental sync, then search/list/summary across all accounts',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: sync, search, list, summary')
            .command({
                command: 'sync',
                describe:
                    'Fetch new transactions from all sources into the local store (incremental). Qonto is unattended; FinTS may require a SecureGo/TAN approval.',
                builder: (y) =>
                    y
                        .option('account', {
                            type: 'string',
                            describe: 'Limit to one account: "qonto" or a FinTS config name (e.g. musterbank-privat)',
                        })
                        .option('from', {
                            type: 'string',
                            describe: 'Force start date (YYYY-MM-DD), overrides the cursor',
                        })
                        .option('full', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ignore cursor and pull full available history',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    runAndExit(() =>
                        syncTransactions({
                            account: pickArgv<string>(raw, 'account'),
                            from: pickArgv<string>(raw, 'from'),
                            full: pickArgv<boolean>(raw, 'full') === true,
                        }),
                    );
                },
            })
            .command({
                command: 'search',
                describe: 'Search the unified store across all accounts (newest first)',
                builder: searchBuilder,
                handler: (argv) => {
                    const opts = searchOptionsFromArgv(argv as Record<string, unknown>);
                    runAndExit(() => Promise.resolve(searchTransactions(opts)));
                },
            })
            .command({
                command: 'list',
                describe: 'List stored transactions (alias for search without text query)',
                builder: searchBuilder,
                handler: (argv) => {
                    const opts = searchOptionsFromArgv(argv as Record<string, unknown>);
                    runAndExit(() => Promise.resolve(searchTransactions(opts)));
                },
            })
            .command({
                command: 'summary',
                describe: 'Per-account totals and date ranges across the whole store',
                handler: () => runAndExit(() => Promise.resolve(transactionsSummary())),
            })
            .command({
                command: 'imports',
                describe: 'List the file imports still represented in the store (newest first)',
                handler: () => runAndExit(() => Promise.resolve(listImports())),
            })
            .command({
                command: 'undo-import <batch>',
                describe:
                    'Take back one import: remove the transactions it ADDED from the store and the ledger. Rows it merely updated existed before and are kept. Refused for festgeschriebene Perioden (GoBD).',
                builder: (y) =>
                    y.positional('batch', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Batch id from "transactions imports"',
                    }),
                handler: (argv) => {
                    const batch = pickArgv<string>(argv as Record<string, unknown>, 'batch');
                    runAndExit(() => {
                        if (!batch) throw new Error('A batch id is required');
                        return Promise.resolve(undoImportBatch(batch));
                    });
                },
            })
            .command({
                command: 'import <path>',
                describe:
                    'Import CAMT.052/053 XML exports (file, account folder, or a parent folder with per-account subfolders) into the store, matched by IBAN. By default backfills only transactions older than the account already has (no overlap dup); --full imports everything.',
                builder: (y) =>
                    y
                        .positional('path', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Path to a CAMT XML file or directory',
                        })
                        .option('full', {
                            type: 'boolean',
                            default: false,
                            describe: 'Import all transactions, not just those older than the existing data',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const path = pickArgv<string>(raw, 'path');
                    const full = pickArgv<boolean>(raw, 'full') === true;
                    runAndExit(() => {
                        if (!path) throw new Error('A CAMT path is required');
                        // Stamp everything this import ADDS with one batch id, so it can be taken
                        // back with `transactions undo-import`. The app's runImport does the same;
                        // this path must not be the one that silently produces unrevertable data.
                        const batchId = newImportBatchId(path);
                        return Promise.resolve(
                            withImportBatch(batchId, () => ({ batchId, ...importCamt(path, { full }) })),
                        );
                    });
                },
            })
            .command({
                command: 'import-paypal <path>',
                describe:
                    'Import a PayPal Aktivitätsbericht CSV as a searchable paypal: source. Enrichment only (NOT counted in the EÜR); each payment carries the bank reference so a bank "PP.1555.PP/<ref>" debit can be resolved to its real merchant.',
                builder: (y) =>
                    y.positional('path', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Path to the PayPal activity CSV export',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const path = pickArgv<string>(raw, 'path');
                    runAndExit(() => {
                        if (!path) throw new Error('A PayPal CSV path is required');
                        const batchId = newImportBatchId(path);
                        return Promise.resolve(withImportBatch(batchId, () => ({ batchId, ...importPaypal(path) })));
                    });
                },
            })
            .command({
                command: 'enrich-qonto <path>',
                describe:
                    'Restore card merchants onto the CAMT-imported camt: transactions from a Qonto XLS "Vollständiger Datenexport" (matched by IBAN + date + amount). CAMT53 drops the card merchant; this folds counterpartyName back in. Data repair, not classification.',
                builder: (y) =>
                    y.positional('path', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Path to the Qonto XLS export (Vollständiger Datenexport)',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const path = pickArgv<string>(raw, 'path');
                    runAndExit(() => {
                        if (!path) throw new Error('A Qonto XLS export path is required');
                        return Promise.resolve(enrichStoreFromQontoExport(path));
                    });
                },
            })
            .command({
                command: 'enrich-amazon <path>',
                describe:
                    'Fold Amazon article details (title + category) onto the matching camt: card charges from an Amazon "Bestellungen" CSV (matched by amount + date window), so the EÜR can classify by item. Data repair, not classification.',
                builder: (y) =>
                    y.positional('path', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Path to the Amazon orders CSV (Bestellungen export)',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const path = pickArgv<string>(raw, 'path');
                    runAndExit(() => {
                        if (!path) throw new Error('An Amazon CSV path is required');
                        return Promise.resolve(enrichStoreFromAmazon(path));
                    });
                },
            }),
};
