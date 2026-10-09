import type { CommandModule } from 'yargs';

import {
    findAndMergeDuplicates,
    type FindDuplicatesGroupInfo,
    type FindDuplicatesGroupChoice,
} from '../../../core/actions/paperless/find-duplicates.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { interactivePrompts } from '../../../core/lib/interactive-prompts.ts';
import { INTERACTIVE_TTY_MESSAGE } from './render.ts';

function formatDuplicateGroup(info: FindDuplicatesGroupInfo): string {
    const primaryLabel = info.primaryTitle ?? `#${info.primaryId}`;
    const dupList = info.duplicateIds.map((id, i) => `#${id} (${info.duplicateTitles[i] ?? '—'})`).join(', ');
    return `Primary: #${info.primaryId} ${primaryLabel}\n  Duplicates: ${dupList}`;
}

async function onDuplicateGroupInteractive(info: FindDuplicatesGroupInfo): Promise<FindDuplicatesGroupChoice> {
    console.log('');
    console.log(`--- Duplicate group: ${info.groupKey} ---`);
    console.log(formatDuplicateGroup(info));
    const { select } = await interactivePrompts();
    const choice = await select({
        message: 'Merge this group?',
        choices: [
            { name: 'Yes, merge into primary', value: 'merge' },
            { name: 'Skip this group', value: 'skip' },
            { name: 'Quit', value: 'quit' },
        ],
    });
    return choice as FindDuplicatesGroupChoice;
}

function runFindDuplicates(documentTypeKey: 'incoming_invoice' | 'outgoing_invoice') {
    return async (argv: Record<string, unknown>) => {
        const auto = Boolean(argv['auto']);
        const dryRun = Boolean(argv['dry-run']);
        if (!auto && !process.stdin.isTTY) {
            console.error(INTERACTIVE_TTY_MESSAGE);
            process.exit(1);
        }
        const config = loadPaperlessConfig();
        const documentTypeId = config.document_type_ids[documentTypeKey];
        const result = await findAndMergeDuplicates(config, documentTypeId, {
            dryRun,
            onGroupProcessed: auto
                ? (info) => {
                      console.log(
                          `Duplicate group "${info.groupKey}": primary #${info.primaryId}, ${info.duplicateIds.length} duplicate(s) – merging`,
                      );
                      return Promise.resolve('merge' as const);
                  }
                : onDuplicateGroupInteractive,
        });
        console.log(
            `Duplicate groups: ${result.groupsFound}, merged: ${result.documentsMerged}, trashed: ${result.duplicatesTrashed}, errors: ${result.errors}`,
        );
        if (result.errors > 0) process.exit(1);
        process.exit(0);
    };
}

const findDuplicatesOptions = {
    auto: {
        type: 'boolean' as const,
        describe: 'Run in batch mode without prompting for each duplicate group',
        default: false,
    },
    'dry-run': {
        type: 'boolean' as const,
        describe: 'Only list duplicate groups, do not update or delete',
        default: false,
    },
};

export const findDuplicatesIncomingSubcommand: CommandModule = {
    command: 'find-duplicates-incoming',
    describe:
        'Find duplicate incoming invoices (same Rechnungsnummer, Bruttobetrag, Rechnungsdatum), merge custom fields into primary. Only considers documents with type "Eingehende Rechnung" (sync-config); set Lohnsteuerbescheinigungen, Bescheide etc. to another type in Paperless so they are not included. Interactive by default; use --auto for batch with live logging.',
    builder: (y) => y.option('auto', findDuplicatesOptions.auto).option('dry-run', findDuplicatesOptions['dry-run']),
    handler: async (argv) => {
        try {
            await runFindDuplicates('incoming_invoice')(argv as Record<string, unknown>);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};

export const findDuplicatesOutgoingSubcommand: CommandModule = {
    command: 'find-duplicates-outgoing',
    describe:
        'Find duplicate outgoing invoices (same Rechnungsnummer, Bruttobetrag, Rechnungsdatum), merge custom fields into primary. Only considers documents with type "Ausgehende Rechnung" (sync-config). Interactive by default; use --auto for batch with live logging.',
    builder: (y) => y.option('auto', findDuplicatesOptions.auto).option('dry-run', findDuplicatesOptions['dry-run']),
    handler: async (argv) => {
        try {
            await runFindDuplicates('outgoing_invoice')(argv as Record<string, unknown>);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
