import type { CommandModule } from 'yargs';

import { reviewMetadata } from '../../../core/actions/paperless/review-metadata.ts';
import { classifyDocuments } from '../../../core/actions/paperless/classify-documents.ts';
import { importAmazonReceipts } from '../../../core/actions/paperless/import-amazon-receipts.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { interactivePrompts } from '../../../core/lib/interactive-prompts.ts';
import { pickArgv, runAndExit } from '../output.ts';
import { INTERACTIVE_TTY_MESSAGE } from './render.ts';

export const importAmazonSubcommand: CommandModule = {
    command: 'import-amazon <docDir> <csvPath>',
    describe:
        'Import Amazon "Tax Invoice" PDFs into Paperless, scoped business/private from the order CSV (correspondent Amazon, type incoming_invoice, data_scope, order number). Use --dry-run to preview the split.',
    builder: (y2) =>
        y2
            .positional('docDir', { type: 'string', describe: 'Folder of Amazon invoice PDFs' })
            .positional('csvPath', { type: 'string', describe: 'Amazon "Bestellungen" CSV (for scoping)' })
            .option('dry-run', {
                type: 'boolean',
                default: false,
                describe: 'Classify + report the business/private split without uploading',
            })
            .option('upload-only', {
                type: 'boolean',
                default: false,
                describe: 'Upload new files without waiting for Paperless OCR (fast); re-run without it to set scope',
            }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const docDir = pickArgv<string>(raw, 'docDir');
        const csvPath = pickArgv<string>(raw, 'csvPath');
        const dryRun = pickArgv<boolean>(raw, 'dryRun') ?? false;
        const uploadOnly = pickArgv<boolean>(raw, 'uploadOnly') ?? false;
        runAndExit(() => {
            if (!docDir || !csvPath) throw new Error('docDir and csvPath are required');
            return importAmazonReceipts({ docDir, csvPath, dryRun, uploadOnly });
        });
    },
};

export const reviewMetadataSubcommand: CommandModule = {
    command: 'review-metadata',
    describe:
        'Review document metadata (title, correspondent, document type, created date) via LLM; optionally run type-specific enrichment (e.g. invoice fields for invoice types). Use filters to limit scope. Default: only documents without tag ai_reviewed.',
    builder: (y) =>
        y
            .option('force', {
                type: 'boolean',
                describe: 'Also process documents that already have tag ai_reviewed',
                default: false,
            })
            .option('auto', {
                type: 'boolean',
                describe: 'Run in batch without pausing after each document',
                default: false,
            })
            .option('dry-run', {
                type: 'boolean',
                describe: 'Do not update Paperless; only list documents and planned changes',
                default: false,
            })
            .option('from', {
                type: 'string',
                describe: 'Only documents with created date >= this (YYYY-MM-DD)',
            })
            .option('to', {
                type: 'string',
                describe: 'Only documents with created date <= this (YYYY-MM-DD)',
            })
            .option('document-type-id', {
                type: 'array',
                describe: 'Only documents of these document type IDs (repeat or comma-separated)',
                coerce: (arg: unknown[]) => {
                    const flat = arg.flatMap((a) =>
                        typeof a === 'string' ? a.split(',').map((s) => parseInt(s.trim(), 10)) : [Number(a)],
                    );
                    return flat.filter((n) => Number.isInteger(n) && n > 0);
                },
            })
            .option('document-type', {
                type: 'string',
                describe: 'Shorthand: incoming_invoice or outgoing_invoice (uses config document_type_ids)',
                choices: ['incoming_invoice', 'outgoing_invoice'],
            })
            .option('limit', {
                type: 'number',
                describe: 'Max number of documents to process',
            })
            .option('query', {
                type: 'string',
                describe: 'Paperless search query to filter documents',
            }),
    handler: async (argv) => {
        if (!argv.auto && !process.stdin.isTTY) {
            console.error(INTERACTIVE_TTY_MESSAGE);
            process.exit(1);
        }
        try {
            const config = loadPaperlessConfig();
            const raw = argv as Record<string, unknown>;
            let documentTypeIds = (raw['document-type-id'] as number[] | undefined) ?? [];
            const documentTypeKey = raw['document-type'] as 'incoming_invoice' | 'outgoing_invoice' | undefined;
            if (documentTypeKey) {
                const id = config.document_type_ids[documentTypeKey];
                if (id > 0) documentTypeIds = [...new Set([...documentTypeIds, id])];
            }
            const result = await reviewMetadata(config, {
                force: Boolean(raw.force),
                auto: Boolean(raw.auto),
                dryRun: Boolean(raw['dry-run']),
                from: raw.from as string | undefined,
                to: raw.to as string | undefined,
                documentTypeIds: documentTypeIds.length > 0 ? documentTypeIds : undefined,
                limit: raw.limit as number | undefined,
                query: raw.query as string | undefined,
                onDocumentProcessed: raw.auto
                    ? async (info) => {
                          const status = info.updated ? 'saved' : 'no changes';
                          const changeSummary =
                              info.changes.length > 0
                                  ? `: ${info.changes.slice(0, 2).join('; ')}${info.changes.length > 2 ? '…' : ''}`
                                  : '';
                          console.log(`Document #${info.documentId} ${status}${changeSummary}`);
                      }
                    : process.stdin.isTTY
                      ? async (info) => {
                            console.log('');
                            console.log(`--- Document #${info.documentId} ---`);
                            if (info.changes.length > 0) {
                                for (const line of info.changes) {
                                    console.log(`  ${line}`);
                                }
                            } else {
                                console.log('  (no changes)');
                            }
                            console.log(info.updated ? '  → Saved to Paperless.' : '  → Dry-run (not saved).');
                            console.log('');
                            const { input } = await interactivePrompts();
                            await input({ message: 'Press Enter to continue', default: '' });
                        }
                      : undefined,
            });
            console.log(
                `Processed ${result.processed}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors}`,
            );
            if (result.errors > 0) process.exit(1);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};

export const classifyDocumentsSubcommand: CommandModule = {
    command: 'classify-documents',
    describe:
        'Classify documents using LLM: analyze OCR content and assign the best-matching document type from all available types.',
    builder: (y) =>
        y
            .option('document-type-id', {
                type: 'number',
                describe: 'Only re-classify documents currently of this type',
            })
            .option('unclassified', {
                type: 'boolean',
                describe: 'Only classify documents without a document type',
                default: false,
            })
            .option('only-wrong', {
                type: 'boolean',
                describe: 'Skip documents where the LLM confirms the current type',
                default: false,
            })
            .option('dry-run', {
                type: 'boolean',
                describe: 'Only report changes; do not update Paperless',
                default: false,
            })
            .option('limit', { type: 'number', describe: 'Max number of documents to process' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const dryRun = Boolean(raw['dry-run']);
        try {
            const result = await classifyDocuments({
                documentTypeId: raw['document-type-id'] as number | undefined,
                unclassified: Boolean(raw.unclassified),
                onlyWrong: Boolean(raw['only-wrong']),
                dryRun,
                limit: raw.limit as number | undefined,
                onDocumentProcessed: async (info) => {
                    const prefix = dryRun ? '[dry-run] ' : '';
                    if (info.changed) {
                        console.log(
                            `${prefix}Document ${info.documentId}: ${info.fileName ?? info.title ?? '?'} – ${info.previousTypeName ?? 'none'} → ${info.newTypeName ?? 'none'} (${info.confidence}: ${info.reason})`,
                        );
                    } else {
                        console.log(
                            `${prefix}Document ${info.documentId}: ${info.fileName ?? info.title ?? '?'} – kept ${info.previousTypeName ?? 'none'} (${info.confidence}: ${info.reason})`,
                        );
                    }
                },
            });
            console.log(
                `\nProcessed ${result.processed}, changed ${result.changed}, unchanged ${result.unchanged}, skipped ${result.skipped}, errors ${result.errors}`,
            );
            if (result.errors > 0) process.exit(1);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
