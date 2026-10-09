import type { CommandModule } from 'yargs';

import { loadPaperlessConfig } from '../../core/config/index.ts';
import {
    reconcileDocumentToStore,
    reconcileStoreBatch,
    storeReconciliationStatus,
} from '../../core/actions/reconcile-store.ts';
import {
    suggestDocumentLinksForTransaction,
    suggestTransactionLinksForDocument,
} from '../../core/actions/link-candidates.ts';
import { pickArgv, runAndExit } from './output.ts';
import { fiscalYearRange } from '@steuererklaerung/shared';

/** Derive a [from, to] date range from --year (+ optional --month). */
function periodRange(year: number, month?: number): { from: string; to: string } {
    if (month) {
        const mm = String(month).padStart(2, '0');
        const lastDay = new Date(year, month, 0).getDate();
        return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
    }
    return fiscalYearRange(year);
}

export const reconcileCommand: CommandModule = {
    command: 'reconcile',
    describe:
        'Reconcile Paperless invoice documents against the LOCAL transaction store (camt:/fints:/qonto:). For closed accounts not reachable via the Qonto API.',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: store, document, status')
            .command({
                command: 'store',
                describe:
                    'Batch: auto-link every unmatched invoice document in a period to its store transaction (confident matches only).',
                builder: (y) =>
                    y
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('month', { type: 'number', describe: 'Optional month 1–12' })
                        .option('account-key', {
                            type: 'string',
                            describe: 'Restrict to one accountKey (see "transactions summary")',
                        })
                        .option('max-day-gap', {
                            type: 'number',
                            describe: 'Max |days| between booking and document date (default 60)',
                        })
                        .option('amount-tolerance', {
                            type: 'number',
                            describe: 'Max absolute amount difference in EUR (default 0.01)',
                        })
                        .option('limit', { type: 'number', describe: 'Max documents to process' })
                        .option('force', {
                            type: 'boolean',
                            default: false,
                            describe: 'Re-match documents that already have a match',
                        })
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Report planned links without writing',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    runAndExit(() =>
                        reconcileStoreBatch(loadPaperlessConfig(), periodRange(year, pickArgv<number>(raw, 'month')), {
                            accountKey: pickArgv<string>(raw, 'accountKey', 'account-key'),
                            maxDayGap: pickArgv<number>(raw, 'maxDayGap', 'max-day-gap'),
                            amountTolerance: pickArgv<number>(raw, 'amountTolerance', 'amount-tolerance'),
                            limit: pickArgv<number>(raw, 'limit'),
                            force: pickArgv<boolean>(raw, 'force') === true,
                            dryRun: pickArgv<boolean>(raw, 'dryRun', 'dry-run') === true,
                        }),
                    );
                },
            })
            .command({
                command: 'document <id>',
                describe: 'Reconcile a single document: auto-match, or link an explicit --store-transaction-id.',
                builder: (y) =>
                    y
                        .positional('id', { type: 'number', demandOption: true, describe: 'Paperless document ID' })
                        .option('store-transaction-id', {
                            type: 'string',
                            describe: 'Exact store transaction id to link (skips auto-match)',
                        })
                        .option('account-key', {
                            type: 'string',
                            describe: 'Restrict the store search to one accountKey',
                        })
                        .option('max-day-gap', {
                            type: 'number',
                            describe: 'Max |days| between booking and document date (default 60)',
                        })
                        .option('amount-tolerance', {
                            type: 'number',
                            describe: 'Max absolute amount difference in EUR (default 0.01)',
                        })
                        .option('force', {
                            type: 'boolean',
                            default: false,
                            describe: 'Re-match even if already matched',
                        })
                        .option('dry-run', {
                            type: 'boolean',
                            default: false,
                            describe: 'Report the chosen match without writing',
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const id = pickArgv<number>(raw, 'id') as number;
                    runAndExit(() =>
                        reconcileDocumentToStore(loadPaperlessConfig(), id, {
                            storeTransactionId: pickArgv<string>(raw, 'storeTransactionId', 'store-transaction-id'),
                            accountKey: pickArgv<string>(raw, 'accountKey', 'account-key'),
                            maxDayGap: pickArgv<number>(raw, 'maxDayGap', 'max-day-gap'),
                            amountTolerance: pickArgv<number>(raw, 'amountTolerance', 'amount-tolerance'),
                            force: pickArgv<boolean>(raw, 'force') === true,
                            dryRun: pickArgv<boolean>(raw, 'dryRun', 'dry-run') === true,
                        }),
                    );
                },
            })
            .command({
                command: 'status',
                describe: 'Gap report for a period: matched/unmatched store transactions and invoice documents.',
                builder: (y) =>
                    y
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('month', { type: 'number', describe: 'Optional month 1–12' })
                        .option('account-key', { type: 'string', describe: 'Restrict to one accountKey' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    runAndExit(() =>
                        storeReconciliationStatus(
                            loadPaperlessConfig(),
                            periodRange(year, pickArgv<number>(raw, 'month')),
                            {
                                accountKey: pickArgv<string>(raw, 'accountKey', 'account-key'),
                            },
                        ),
                    );
                },
            })
            .command({
                command: 'candidates',
                describe:
                    'Suggest link candidates (read-only): documents that could be the receipt for a transaction (--transaction-id), or transactions that could be the payment for a document (--document-id).',
                builder: (y) =>
                    y
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace entity id (gbr|jumplink|privat)',
                        })
                        .option('transaction-id', {
                            type: 'string',
                            describe: 'Store transaction id → suggest matching receipt documents',
                        })
                        .option('document-id', {
                            type: 'string',
                            describe: 'Document id → suggest matching payment transactions',
                        })
                        .option('limit', { type: 'number', describe: 'Max candidates (default 8)' })
                        .check((a) => {
                            if (!a['transaction-id'] && !a['document-id'])
                                throw new Error('Pass --transaction-id or --document-id.');
                            return true;
                        }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entity = pickArgv<string>(raw, 'entity') as string;
                    const txId = pickArgv<string>(raw, 'transactionId', 'transaction-id');
                    const docId = pickArgv<string>(raw, 'documentId', 'document-id');
                    const limit = pickArgv<number>(raw, 'limit');
                    runAndExit(() =>
                        txId
                            ? suggestDocumentLinksForTransaction(entity, txId, { limit })
                            : suggestTransactionLinksForDocument(entity, docId as string, { limit }),
                    );
                },
            }),
};
