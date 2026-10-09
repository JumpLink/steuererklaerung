import type { CommandModule } from 'yargs';

import { extractInvoiceFields } from '../../../core/actions/paperless/extract-invoice.ts';
import { resolveDefaultElster, getPeriodDateRange } from '../../../core/config/index.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { INTERACTIVE_TTY_MESSAGE, onDocumentProcessedInteractive } from './render.ts';

function runExtractInvoiceFields(documentTypeKey: 'incoming_invoice' | 'outgoing_invoice') {
    return async (argv: Record<string, unknown>) => {
        const auto = Boolean(argv['auto']);
        const force = Boolean(argv['force']);
        const onlyMissing = force ? false : Boolean(argv['only-missing']);
        const dryRun = Boolean(argv['dry-run']);
        let from = argv['from'] != null ? String(argv['from']).trim() : undefined;
        let to = argv['to'] != null ? String(argv['to']).trim() : undefined;
        if (argv['period']) {
            try {
                const elsterConfig = resolveDefaultElster();
                if (!elsterConfig) throw new Error('keine ELSTER-Config in steuererklaerung.json');
                const range = getPeriodDateRange(elsterConfig.period);
                from = range.dateFrom;
                to = range.dateTo;
            } catch (e) {
                console.error(
                    '--period requires a valid ELSTER config in steuererklaerung.json:',
                    e instanceof Error ? e.message : e,
                );
                process.exit(1);
            }
        }
        if (!auto && !process.stdin.isTTY) {
            console.error(INTERACTIVE_TTY_MESSAGE);
            process.exit(1);
        }
        const config = loadPaperlessConfig();
        const documentTypeId = config.document_type_ids[documentTypeKey];
        const result = await extractInvoiceFields(config, documentTypeId, {
            onlyMissing,
            dryRun,
            from,
            to,
            onDocumentProcessed: auto
                ? (info) => {
                      const label = info.fileName || info.title || `#${info.documentId}`;
                      const status = info.updated ? 'updated' : dryRun ? 'would update' : 'skipped';
                      console.log(`Document ${info.documentId}: ${label} – ${status}`);
                      return Promise.resolve();
                  }
                : onDocumentProcessedInteractive,
        });
        console.log(
            `Processed ${result.processed}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors}`,
        );
        if (result.errors > 0) process.exit(1);
        process.exit(0);
    };
}

const extractInvoiceFieldsOptions = {
    auto: {
        type: 'boolean' as const,
        describe: 'Run in batch mode without pausing after each document',
        default: false,
    },
    force: {
        type: 'boolean' as const,
        describe: 'Process all documents and update even when Rechnungsnummer is already set',
        default: false,
    },
    'only-missing': {
        type: 'boolean' as const,
        describe: 'Only process documents that do not yet have Rechnungsnummer set (default when no --force)',
        default: true,
    },
    'dry-run': {
        type: 'boolean' as const,
        describe: 'Do not update Paperless; only list documents and extracted values',
        default: false,
    },
    from: {
        type: 'string' as const,
        describe: 'Only process documents with invoice/booking date on or after this date (YYYY-MM-DD)',
    },
    to: {
        type: 'string' as const,
        describe: 'Only process documents with invoice/booking date on or before this date (YYYY-MM-DD)',
    },
    period: {
        type: 'boolean' as const,
        describe: 'Use date range from elster-config.json period (e.g. Q1 2026)',
        default: false,
    },
};

export const extractInvoiceFieldsIncomingSubcommand: CommandModule = {
    command: 'extract-invoice-fields-incoming',
    describe:
        'Extract invoice fields (Rechnungsnummer, dates, amounts, etc.) from OCR content of incoming invoices via the configured LLM (default: Claude on your subscription) and save to Paperless custom fields. Interactive by default; use --auto for batch.',
    builder: (y) =>
        y
            .option('auto', extractInvoiceFieldsOptions.auto)
            .option('force', extractInvoiceFieldsOptions.force)
            .option('only-missing', extractInvoiceFieldsOptions['only-missing'])
            .option('dry-run', extractInvoiceFieldsOptions['dry-run'])
            .option('from', extractInvoiceFieldsOptions.from)
            .option('to', extractInvoiceFieldsOptions.to)
            .option('period', extractInvoiceFieldsOptions.period),
    handler: async (argv) => {
        try {
            await runExtractInvoiceFields('incoming_invoice')(argv as Record<string, unknown>);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};

export const extractInvoiceFieldsOutgoingSubcommand: CommandModule = {
    command: 'extract-invoice-fields-outgoing',
    describe:
        'Extract invoice fields (Rechnungsnummer, dates, amounts, etc.) from OCR content of outgoing invoices via the configured LLM (default: Claude on your subscription) and save to Paperless custom fields. Interactive by default; use --auto for batch.',
    builder: (y) =>
        y
            .option('auto', extractInvoiceFieldsOptions.auto)
            .option('force', extractInvoiceFieldsOptions.force)
            .option('only-missing', extractInvoiceFieldsOptions['only-missing'])
            .option('dry-run', extractInvoiceFieldsOptions['dry-run'])
            .option('from', extractInvoiceFieldsOptions.from)
            .option('to', extractInvoiceFieldsOptions.to)
            .option('period', extractInvoiceFieldsOptions.period),
    handler: async (argv) => {
        try {
            await runExtractInvoiceFields('outgoing_invoice')(argv as Record<string, unknown>);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
