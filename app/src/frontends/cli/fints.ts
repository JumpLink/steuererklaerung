import type { CommandModule } from 'yargs';

import {
    fintsSync,
    fintsAccounts,
    fintsTanMethods,
    fintsBalance,
    fintsTransactions,
} from '../../core/actions/fints.ts';
import { pickArgv, runAndExit } from './output.ts';

export const fintsCommand: CommandModule = {
    command: 'fints',
    describe: 'FinTS/HBCI banking: sync, accounts, balance, transactions, tan-methods',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: sync, accounts, balance, transactions, tan-methods')
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
