import type { CommandModule } from 'yargs';

import {
    fintsSync,
    fintsAccounts,
    fintsTanMethods,
    fintsBalance,
    fintsTransactions,
} from '../../core/actions/fints.ts';
import { defaultStatementsEntity, fintsStatementGaps, fintsStatements } from '../../core/actions/fints-statements.ts';
import { pickArgv, runAndExit } from './output.ts';

export const fintsCommand: CommandModule = {
    command: 'fints',
    describe: 'FinTS/HBCI banking: sync, accounts, balance, transactions, statements, tan-methods',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: sync, accounts, balance, transactions, statements, tan-methods')
            .option('account', {
                type: 'string',
                alias: 'a',
                describe: 'Bank account name from fints-config.json (default: first/only account)',
            })
            .command({
                command: 'sync',
                describe: 'Synchronize with bank (fetch TAN methods, accounts, BPD/UPD)',
                handler: (argv) => {
                    const accountName = pickArgv<string>(argv as Record<string, unknown>, 'account');
                    runAndExit(() => fintsSync(accountName));
                },
            })
            .command({
                command: 'accounts',
                describe: 'List bank accounts from synchronized banking information',
                handler: (argv) => {
                    const accountName = pickArgv<string>(argv as Record<string, unknown>, 'account');
                    runAndExit(() => Promise.resolve(fintsAccounts(accountName)));
                },
            })
            .command({
                command: 'statements',
                describe:
                    'PDF account statements from the bank (HKEKA) into the DMS. Dry run by default; --gaps lists missing statement numbers from the DMS without calling the bank.',
                builder: (y) =>
                    y
                        .option('entity', {
                            type: 'string',
                            describe: 'Workspace entity id (default: first business entity)',
                        })
                        .option('account-number', { type: 'string', describe: 'Only this bank account number' })
                        .option('from', {
                            type: 'string',
                            describe: 'Skip statements ending before this day (YYYY-MM-DD)',
                        })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Upload missing statements (default: dry run)',
                        })
                        .option('acknowledge', {
                            type: 'boolean',
                            default: false,
                            describe: 'Acknowledge receipt at the bank (not supported by the FinTS library yet)',
                        })
                        .option('gaps', {
                            type: 'boolean',
                            default: false,
                            describe: 'List missing statement numbers per account from the DMS (no bank call)',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entityId = defaultStatementsEntity(pickArgv<string>(raw, 'entity'));
                    if (pickArgv<boolean>(raw, 'gaps') === true) {
                        runAndExit(() => fintsStatementGaps(entityId));
                        return;
                    }
                    runAndExit(() =>
                        fintsStatements({
                            entityId,
                            account: pickArgv<string>(raw, 'account'),
                            accountNumber: pickArgv<string>(raw, 'accountNumber', 'account-number'),
                            from: pickArgv<string>(raw, 'from'),
                            apply: pickArgv<boolean>(raw, 'apply') === true,
                            acknowledge: pickArgv<boolean>(raw, 'acknowledge') === true,
                        }),
                    );
                },
            })
            .command({
                command: 'tan-methods',
                describe: 'List available TAN methods',
                handler: (argv) => {
                    const accountName = pickArgv<string>(argv as Record<string, unknown>, 'account');
                    runAndExit(() => Promise.resolve(fintsTanMethods(accountName)));
                },
            })
            .command({
                command: 'balance <account-number>',
                describe: 'Get current balance for a bank account',
                builder: (y) =>
                    y.positional('account-number', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Bank account number (from "fints accounts")',
                    }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const accountNumber = pickArgv<string>(raw, 'accountNumber', 'account-number')!;
                    const accountName = pickArgv<string>(raw, 'account');
                    runAndExit(() => fintsBalance(accountNumber, accountName));
                },
            })
            .command({
                command: 'transactions <account-number>',
                describe: 'Get transactions/statements for a bank account',
                builder: (y) =>
                    y
                        .positional('account-number', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Bank account number (from "fints accounts")',
                        })
                        .option('from', { type: 'string', describe: 'Start date (YYYY-MM-DD)' })
                        .option('to', { type: 'string', describe: 'End date (YYYY-MM-DD)' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const accountNumber = pickArgv<string>(raw, 'accountNumber', 'account-number')!;
                    const accountName = pickArgv<string>(raw, 'account');
                    const from = pickArgv<string>(raw, 'from');
                    const to = pickArgv<string>(raw, 'to');
                    runAndExit(() => fintsTransactions(accountNumber, accountName, from, to));
                },
            }),
};
