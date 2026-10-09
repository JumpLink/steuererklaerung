import type { CommandModule } from 'yargs';

import {
    paperlessMailAccounts,
    paperlessMailAccount,
    paperlessMailRules,
    paperlessMailRule,
    paperlessProcessedMail,
    paperlessProcessedMailItem,
} from '../../../core/actions/paperless/read.ts';
import { pickArgv, runAndExit } from '../output.ts';

export const mailAccountsSubcommand: CommandModule = {
    command: 'mail-accounts',
    describe: 'List mail accounts (E-Mail-Konten)',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        runAndExit(() => paperlessMailAccounts(pageSize != null || page != null ? { page_size: pageSize, page } : {}));
    },
};

export const mailAccountSubcommand: CommandModule = {
    command: 'mail-account <id>',
    describe: 'Get a single mail account by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessMailAccount((argv as unknown as { id: number }).id));
    },
};

export const mailRulesSubcommand: CommandModule = {
    command: 'mail-rules',
    describe: 'List mail rules (E-Mail-Regeln)',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        runAndExit(() => paperlessMailRules(pageSize != null || page != null ? { page_size: pageSize, page } : {}));
    },
};

export const mailRuleSubcommand: CommandModule = {
    command: 'mail-rule <id>',
    describe: 'Get a single mail rule by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessMailRule((argv as unknown as { id: number }).id));
    },
};

export const processedMailSubcommand: CommandModule = {
    command: 'processed-mail',
    describe: 'List processed mail entries (verarbeitete E-Mails)',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' })
            .option('rule', { type: 'number', describe: 'Filter by mail rule ID' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        const rule = pickArgv<number>(raw, 'rule');
        runAndExit(() =>
            paperlessProcessedMail({
                ...(pageSize != null ? { page_size: pageSize } : {}),
                ...(page != null ? { page } : {}),
                ...(rule != null ? { rule } : {}),
            }),
        );
    },
};

export const processedMailItemSubcommand: CommandModule = {
    command: 'processed-mail-item <id>',
    describe: 'Get a single processed mail entry by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessProcessedMailItem((argv as unknown as { id: number }).id));
    },
};
