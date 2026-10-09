import { readFileSync } from 'node:fs';

import type { CommandModule } from 'yargs';

import {
    qontoOrg,
    qontoBankAccounts,
    qontoBankAccount,
    qontoTransactions,
    qontoTransaction,
    qontoStatements,
    qontoStatement,
    qontoClients,
    qontoClientInvoices,
    qontoUpdateInvoice,
    qontoSendInvoice,
} from '../../core/actions/qonto.ts';
import type { CreateInvoiceInput } from '../../core/actions/qonto.ts';
import { createOutgoingInvoiceDraft } from '../../core/actions/outgoing-invoices.ts';
import { getDefaultBankAccountId, getQontoEnv } from '../../core/clients/qonto/index.ts';
import { pickArgv, runAndExit } from './output.ts';

/** Parse and minimally validate an invoice spec JSON file ({ client, invoice }). */
function loadInvoiceSpecFile(path: string): CreateInvoiceInput {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(`Could not read invoice spec file "${path}": ${err instanceof Error ? err.message : err}`);
    }
    const spec = parsed as Partial<CreateInvoiceInput>;
    if (!spec.client || !spec.invoice) {
        throw new Error('Invoice spec file must contain top-level "client" and "invoice" objects');
    }
    return { client: spec.client, invoice: spec.invoice };
}

export const qontoCommand: CommandModule = {
    command: 'qonto',
    describe: 'Qonto API: org, bank-accounts, transactions, statements (read); clients, invoices (read/create)',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(
                1,
                'Choose a subcommand: org, bank-accounts, transactions, statements, clients, invoices, invoice',
            )
            .command({
                command: 'org',
                describe: 'Get organization and linked bank accounts',
                builder: (y) =>
                    y.option('include-external-accounts', {
                        type: 'boolean',
                        default: false,
                        describe: 'Include external accounts',
                    }),
                handler: (argv) => {
                    const include = pickArgv<boolean>(argv, 'includeExternalAccounts', 'include-external-accounts');
                    runAndExit(() => qontoOrg(include === true));
                },
            })
            .command({
                command: 'bank-accounts',
                describe: 'List all bank accounts',
                handler: () => runAndExit(qontoBankAccounts),
            })
            .command({
                command: 'bank-account <id>',
                describe: 'Get a single bank account by id',
                builder: (y) => y.positional('id', { type: 'string', demandOption: true }),
                handler: (argv) => {
                    const id = (argv as { id: string }).id;
                    runAndExit(() => qontoBankAccount(id));
                },
            })
            .command({
                command: 'transactions [bank-account-id]',
                describe: 'List transactions. Pass bank-account-id as first arg or use --iban.',
                builder: (y) =>
                    y
                        .positional('bank-account-id', {
                            type: 'string',
                            describe: 'Bank account ID (e.g. from qonto bank-accounts)',
                        })
                        .option('iban', { type: 'string', describe: 'Filter by IBAN instead of bank-account-id' })
                        .option('limit', { type: 'number', describe: 'Max items per page (API default)' })
                        .option('settled-at-from', { type: 'string', describe: 'Settled at from (ISO date)' })
                        .option('settled-at-to', { type: 'string', describe: 'Settled at to (ISO date)' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
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
                            `Error: Pass bank-account-id as first argument (e.g. qonto transactions <id>), use --iban, or set ${envVar} (or QONTO_DEFAULT_BANK_ACCOUNT_ID) in .env`,
                        );
                        process.exit(1);
                    }
                    runAndExit(() =>
                        qontoTransactions({
                            bankAccountId: trimmedId,
                            iban,
                            settled_at_from: settledAtFrom,
                            settled_at_to: settledAtTo,
                        }),
                    );
                },
            })
            .command({
                command: 'transaction <id>',
                describe: 'Get a single transaction by id',
                builder: (y) => y.positional('id', { type: 'string', demandOption: true }),
                handler: (argv) => {
                    runAndExit(() => qontoTransaction((argv as { id: string }).id));
                },
            })
            .command({
                command: 'statements',
                describe: 'List statements',
                builder: (y) =>
                    y
                        .option('bank-account-ids', { type: 'array', string: true, describe: 'Bank account IDs' })
                        .option('period-from', { type: 'string', describe: 'Period from (YYYY-MM-DD)' })
                        .option('period-to', { type: 'string', describe: 'Period to (YYYY-MM-DD)' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const bankAccountIds = pickArgv<string[]>(raw, 'bankAccountIds', 'bank-account-ids');
                    const periodFrom = pickArgv<string>(raw, 'periodFrom', 'period-from');
                    const periodTo = pickArgv<string>(raw, 'periodTo', 'period-to');
                    runAndExit(() =>
                        qontoStatements({
                            bank_account_ids: Array.isArray(bankAccountIds) ? bankAccountIds : undefined,
                            period_from: periodFrom,
                            period_to: periodTo,
                        }),
                    );
                },
            })
            .command({
                command: 'statement <id>',
                describe: 'Get a single statement by id',
                builder: (y) => y.positional('id', { type: 'string', demandOption: true }),
                handler: (argv) => {
                    runAndExit(() => qontoStatement((argv as { id: string }).id));
                },
            })
            .command({
                command: 'clients',
                describe: 'List clients (customers for outgoing invoices)',
                handler: () => runAndExit(qontoClients),
            })
            .command({
                command: 'invoices',
                describe: 'List client invoices (outgoing). Optionally filter by --status.',
                builder: (y) =>
                    y.option('status', {
                        type: 'string',
                        describe: 'Filter by status (e.g. draft, unpaid, paid)',
                    }),
                handler: (argv) => {
                    const status = pickArgv<string>(argv as Record<string, unknown>, 'status');
                    runAndExit(() => qontoClientInvoices({ status }));
                },
            })
            .command({
                command: 'invoice',
                describe: 'Outgoing client invoices (read/create): create, update, send.',
                handler: () => {},
                builder: (iy) =>
                    iy
                        .demandCommand(1, 'Choose a subcommand: create, update, send')
                        .command({
                            command: 'create <file>',
                            describe:
                                "Create an outgoing invoice from a JSON spec file ({ client, invoice }) via the entity's invoicing back-end (Qonto by default). Defaults to draft; client is found-or-created by name.",
                            builder: (y) =>
                                y
                                    .positional('file', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Path to invoice spec JSON ({ "client": {...}, "invoice": {...} })',
                                    })
                                    .option('dry-run', {
                                        type: 'boolean',
                                        default: false,
                                        describe:
                                            'Resolve client read-only and print the payload without creating anything',
                                    })
                                    .option('status', {
                                        type: 'string',
                                        choices: ['draft', 'unpaid'],
                                        describe: 'Override invoice status (default from spec or "draft")',
                                    })
                                    .option('iban', { type: 'string', describe: 'Override payment IBAN from the spec' })
                                    .option('entity', {
                                        type: 'string',
                                        describe:
                                            "Entity id whose invoicing back-end applies (default: the workspace's Qonto config)",
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const file = pickArgv<string>(raw, 'file');
                                const dryRun = pickArgv<boolean>(raw, 'dryRun', 'dry-run') === true;
                                const status = pickArgv<'draft' | 'unpaid'>(raw, 'status');
                                const iban = pickArgv<string>(raw, 'iban');
                                const entity = pickArgv<string>(raw, 'entity');
                                runAndExit(() => {
                                    if (!file) throw new Error('Invoice spec file path is required');
                                    const spec = loadInvoiceSpecFile(file);
                                    if (status) spec.invoice.status = status;
                                    if (iban) spec.invoice.iban = iban;
                                    return createOutgoingInvoiceDraft({
                                        entityId: entity,
                                        client: spec.client,
                                        invoice: spec.invoice,
                                        dryRun,
                                    });
                                });
                            },
                        })
                        .command({
                            command: 'update <id> <file>',
                            describe:
                                'Update an existing DRAFT invoice in place from a JSON spec file ({ client, invoice }). Items are fully replaced.',
                            builder: (y) =>
                                y
                                    .positional('id', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Draft client invoice id',
                                    })
                                    .positional('file', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Path to invoice spec JSON ({ "client": {...}, "invoice": {...} })',
                                    })
                                    .option('dry-run', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'Print the rebuilt payload without updating anything',
                                    })
                                    .option('iban', {
                                        type: 'string',
                                        describe: 'Override payment IBAN from the spec',
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const id = pickArgv<string>(raw, 'id');
                                const file = pickArgv<string>(raw, 'file');
                                const dryRun = pickArgv<boolean>(raw, 'dryRun', 'dry-run') === true;
                                const iban = pickArgv<string>(raw, 'iban');
                                runAndExit(() => {
                                    if (!id) throw new Error('Draft invoice id is required');
                                    if (!file) throw new Error('Invoice spec file path is required');
                                    const input = loadInvoiceSpecFile(file);
                                    if (iban) input.invoice.iban = iban;
                                    input.dryRun = dryRun;
                                    return qontoUpdateInvoice(id, input);
                                });
                            },
                        })
                        .command({
                            command: 'send <id>',
                            describe:
                                'Email a finalized invoice to the client. Preview by default; pass --confirm to actually send (outward-facing).',
                            builder: (y) =>
                                y
                                    .positional('id', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Client invoice id',
                                    })
                                    .option('to', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Recipient email(s), comma-separated',
                                    })
                                    .option('subject', {
                                        type: 'string',
                                        demandOption: true,
                                        describe: 'Email subject',
                                    })
                                    .option('message', { type: 'string', describe: 'Email body text' })
                                    .option('message-file', {
                                        type: 'string',
                                        describe: 'Read the email body from a file',
                                    })
                                    .option('cc', {
                                        type: 'boolean',
                                        default: true,
                                        describe: 'Send a copy to yourself (use --no-cc to disable)',
                                    })
                                    .option('confirm', {
                                        type: 'boolean',
                                        default: false,
                                        describe: 'Actually send the email (otherwise preview only)',
                                    }),
                            handler: (argv) => {
                                const raw = argv as Record<string, unknown>;
                                const id = pickArgv<string>(raw, 'id');
                                const to = pickArgv<string>(raw, 'to');
                                const subject = pickArgv<string>(raw, 'subject');
                                const messageOpt = pickArgv<string>(raw, 'message');
                                const messageFile = pickArgv<string>(raw, 'messageFile', 'message-file');
                                const cc = pickArgv<boolean>(raw, 'cc');
                                const confirm = pickArgv<boolean>(raw, 'confirm') === true;
                                runAndExit(() => {
                                    if (!id) throw new Error('Invoice id is required');
                                    if (!to) throw new Error('At least one recipient (--to) is required');
                                    if (!subject) throw new Error('A subject (--subject) is required');
                                    const body = messageFile ? readFileSync(messageFile, 'utf8') : messageOpt;
                                    return qontoSendInvoice(
                                        id,
                                        { sendTo: to, subject, body, copyToSelf: cc !== false },
                                        { confirm },
                                    );
                                });
                            },
                        }),
            }),
};
