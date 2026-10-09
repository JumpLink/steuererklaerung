import type { CommandModule } from 'yargs';

import { matchQontoPaperless } from '../../../core/actions/sync/match-qonto-paperless.ts';
import { syncPaperlessToQonto } from '../../../core/actions/sync/push-to-qonto.ts';
import { getDefaultBankAccountId, getQontoEnv } from '../../../core/clients/qonto/index.ts';
import { pickArgv } from '../output.ts';
import { runInteractiveMatch, runAutoMatch } from './interactive.ts';

export const syncCommand: CommandModule = {
    command: 'sync',
    describe: 'Synchronize data between services (Qonto ↔ Paperless, Paperless → Qonto).',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: match-qonto-paperless, push-paperless-to-qonto')
            .command({
                command: 'match-qonto-paperless [bank-account-id]',
                describe:
                    'Match Qonto transactions with Paperless, import unmatched attachments, update matched. Interactive by default; use --auto for batch.',
                builder: (y) =>
                    y
                        .positional('bank-account-id', {
                            type: 'string',
                            describe: 'Bank account ID (e.g. from qonto bank-accounts)',
                        })
                        .option('auto', {
                            type: 'boolean',
                            describe: 'Run in batch mode: import all unmatched and update all with changes, no prompts',
                            default: false,
                        })
                        .option('iban', { type: 'string', describe: 'Filter by IBAN instead of bank-account-id' })
                        .option('settled-at-from', { type: 'string', describe: 'Settled at from (ISO date)' })
                        .option('settled-at-to', { type: 'string', describe: 'Settled at to (ISO date)' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const auto = Boolean(raw['auto']);
                    const bankAccountId = pickArgv<string>(raw, 'bankAccountId', 'bank-account-id');
                    const trimmedId =
                        (typeof bankAccountId === 'string' && bankAccountId.trim()) ||
                        getDefaultBankAccountId() ||
                        undefined;
                    const iban = pickArgv<string>(raw, 'iban');
                    const settledAtFrom = pickArgv<string>(raw, 'settledAtFrom', 'settled-at-from');
                    const settledAtTo = pickArgv<string>(raw, 'settledAtTo', 'settled-at-to');

                    if (!trimmedId && !iban) {
                        const env = getQontoEnv();
                        const envVar =
                            env === 'staging'
                                ? 'QONTO_STAGING_DEFAULT_BANK_ACCOUNT_ID'
                                : 'QONTO_PRODUCTION_DEFAULT_BANK_ACCOUNT_ID';
                        console.error(
                            `Error: Pass bank-account-id, use --iban, or set ${envVar} (or QONTO_DEFAULT_BANK_ACCOUNT_ID) in .env`,
                        );
                        process.exit(1);
                    }

                    if (!auto && !process.stdin.isTTY) {
                        console.error(
                            'This command is interactive by default. Use --auto for non-TTY (e.g. in scripts), or run from a terminal.',
                        );
                        process.exit(1);
                    }

                    try {
                        const report = await matchQontoPaperless({
                            bankAccountId: trimmedId,
                            iban,
                            settled_at_from: settledAtFrom,
                            settled_at_to: settledAtTo,
                        });
                        if (auto) {
                            const result = await runAutoMatch(report);
                            console.log(
                                `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors}`,
                            );
                            if (result.errors > 0) process.exit(1);
                        } else {
                            await runInteractiveMatch(report);
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'push-paperless-to-qonto',
                describe: 'Upload Paperless documents as receipt attachments to linked Qonto transactions.',
                builder: (y) =>
                    y
                        .option('dry-run', {
                            type: 'boolean',
                            describe: 'Only report planned actions; no download, upload, or Paperless update',
                            default: false,
                        })
                        .option('date-from', {
                            type: 'string',
                            describe: 'Only documents with Qonto settled date on or after this (YYYY-MM-DD)',
                        })
                        .option('date-to', {
                            type: 'string',
                            describe: 'Only documents with Qonto settled date on or before this (YYYY-MM-DD)',
                        })
                        .option('limit', {
                            type: 'number',
                            describe: 'Max number of documents to process',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const dryRun = Boolean(raw['dry-run']);
                    const dateFrom = pickArgv<string>(raw, 'dateFrom', 'date-from');
                    const dateTo = pickArgv<string>(raw, 'dateTo', 'date-to');
                    const limit = typeof raw['limit'] === 'number' && raw['limit'] > 0 ? raw['limit'] : undefined;
                    try {
                        const result = await syncPaperlessToQonto({
                            dryRun,
                            dateFrom: dateFrom ?? undefined,
                            dateTo: dateTo ?? undefined,
                            limit,
                        });
                        console.log(
                            `Uploaded: ${result.uploaded}, skipped (already synced): ${result.skippedAlreadySynced}, skipped (no transaction): ${result.skippedNoTransaction}, errors: ${result.errors}`,
                        );
                        if (result.details.length > 0) {
                            for (const d of result.details) {
                                console.log(
                                    `  Doc #${d.documentId}: ${d.outcome}${d.message ? ` – ${d.message}` : ''}`,
                                );
                            }
                        }
                        if (result.errors > 0) process.exit(1);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
