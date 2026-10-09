import type { CommandModule } from 'yargs';

import {
    documentsSubcommand,
    documentSubcommand,
    updateDocumentSubcommand,
    trashDocumentSubcommand,
    uploadDocumentSubcommand,
    zuordnungSubcommand,
    taskSubcommand,
} from './documents.ts';
import {
    documentTypesSubcommand,
    documentTypeSubcommand,
    correspondentsSubcommand,
    correspondentSubcommand,
    tagsSubcommand,
    tagSubcommand,
    customFieldsSubcommand,
    customFieldSubcommand,
    setupFieldsSubcommand,
} from './resources.ts';
import {
    mailAccountsSubcommand,
    mailAccountSubcommand,
    mailRulesSubcommand,
    mailRuleSubcommand,
    processedMailSubcommand,
    processedMailItemSubcommand,
} from './mail.ts';
import { extractInvoiceFieldsIncomingSubcommand, extractInvoiceFieldsOutgoingSubcommand } from './extract.ts';
import { findDuplicatesIncomingSubcommand, findDuplicatesOutgoingSubcommand } from './duplicates.ts';
import { importAmazonSubcommand, reviewMetadataSubcommand, classifyDocumentsSubcommand } from './maintenance.ts';

export const paperlessCommand: CommandModule = {
    command: 'paperless',
    describe:
        'Paperless-NGX: list documents, document-types, custom-fields, task; setup fields; extract invoice fields; find duplicates',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(
                1,
                'Choose a subcommand: documents, document, zuordnung, upload, update, trash, document-types, document-type, correspondents, correspondent, tags, tag, custom-fields, custom-field, task, mail-accounts, mail-account, mail-rules, mail-rule, processed-mail, setup-fields, classify-documents, extract-invoice-fields-incoming, extract-invoice-fields-outgoing, find-duplicates-incoming, find-duplicates-outgoing, review-metadata',
            )
            .command(documentsSubcommand)
            .command(documentSubcommand)
            .command(updateDocumentSubcommand)
            .command(trashDocumentSubcommand)
            .command(uploadDocumentSubcommand)
            .command(zuordnungSubcommand)
            .command(documentTypesSubcommand)
            .command(documentTypeSubcommand)
            .command(correspondentsSubcommand)
            .command(correspondentSubcommand)
            .command(tagsSubcommand)
            .command(tagSubcommand)
            .command(customFieldsSubcommand)
            .command(customFieldSubcommand)
            .command(taskSubcommand)
            .command(mailAccountsSubcommand)
            .command(mailAccountSubcommand)
            .command(mailRulesSubcommand)
            .command(mailRuleSubcommand)
            .command(processedMailSubcommand)
            .command(processedMailItemSubcommand)
            .command(setupFieldsSubcommand)
            .command(importAmazonSubcommand)
            .command(extractInvoiceFieldsIncomingSubcommand)
            .command(extractInvoiceFieldsOutgoingSubcommand)
            .command(findDuplicatesIncomingSubcommand)
            .command(findDuplicatesOutgoingSubcommand)
            .command(reviewMetadataSubcommand)
            .command(classifyDocumentsSubcommand),
};
