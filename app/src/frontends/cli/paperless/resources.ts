import type { CommandModule } from 'yargs';

import {
    paperlessDocumentTypes,
    paperlessDocumentType,
    paperlessCorrespondents,
    paperlessCorrespondent,
    paperlessTags,
    paperlessTagsAll,
    paperlessTag,
    paperlessCustomFields,
    paperlessCustomField,
} from '../../../core/actions/paperless/read.ts';
import { setupPaperlessFields } from '../../../core/actions/paperless/setup.ts';
import { pickArgv, runAndExit } from '../output.ts';

export const documentTypesSubcommand: CommandModule = {
    command: 'document-types',
    describe: 'List document types (use IDs in sync-config for sync match-qonto-paperless)',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        runAndExit(() => paperlessDocumentTypes(pageSize != null || page != null ? { page_size: pageSize, page } : {}));
    },
};

export const documentTypeSubcommand: CommandModule = {
    command: 'document-type <id>',
    describe: 'Get a single document type by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessDocumentType((argv as unknown as { id: number }).id));
    },
};

export const correspondentsSubcommand: CommandModule = {
    command: 'correspondents',
    describe: 'List correspondents (paginated)',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        runAndExit(() =>
            paperlessCorrespondents(pageSize != null || page != null ? { page_size: pageSize, page } : {}),
        );
    },
};

export const correspondentSubcommand: CommandModule = {
    command: 'correspondent <id>',
    describe: 'Get a single correspondent by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessCorrespondent((argv as unknown as { id: number }).id));
    },
};

export const tagsSubcommand: CommandModule = {
    command: 'tags',
    describe: 'List all tags (fetches all pages by default; use --page and --page-size for single-page output)',
    builder: (y) =>
        y
            .option('page-size', {
                type: 'number',
                describe: 'Page size (if set with --page, returns only that page)',
            })
            .option('page', {
                type: 'number',
                describe: 'Page number (if set with --page-size, returns only that page)',
            }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        const singlePage = pageSize != null || page != null;
        runAndExit(() =>
            singlePage ? paperlessTags({ page_size: pageSize ?? 25, page: page ?? 1 }) : paperlessTagsAll(),
        );
    },
};

export const tagSubcommand: CommandModule = {
    command: 'tag <id>',
    describe: 'Get a single tag by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessTag((argv as unknown as { id: number }).id));
    },
};

export const customFieldsSubcommand: CommandModule = {
    command: 'custom-fields',
    describe: 'List custom fields',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', describe: 'Page size' })
            .option('page', { type: 'number', describe: 'Page number' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        runAndExit(() => paperlessCustomFields(pageSize != null || page != null ? { page_size: pageSize, page } : {}));
    },
};

export const customFieldSubcommand: CommandModule = {
    command: 'custom-field <id>',
    describe: 'Get a single custom field by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessCustomField((argv as unknown as { id: number }).id));
    },
};

export const setupFieldsSubcommand: CommandModule = {
    command: 'setup-fields',
    describe:
        'Create document types, custom fields, and tags in Paperless when their IDs are 0 in sync-config.json; write new IDs back.',
    handler: async () => {
        try {
            const result = await setupPaperlessFields();
            for (const line of result.lines) {
                console.log(line);
            }
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
