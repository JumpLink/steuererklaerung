export {
    paperlessDocuments,
    paperlessDocument,
    paperlessDocumentTypes,
    paperlessDocumentType,
    paperlessCorrespondents,
    paperlessCorrespondent,
    paperlessTagsAll,
    paperlessTags,
    paperlessTag,
    paperlessCustomFields,
    paperlessCustomField,
    paperlessTask,
} from './read.ts';

export { setupPaperlessFields, type SetupPaperlessFieldsResult } from './setup.ts';

export {
    extractInvoiceFieldsFromContent,
    buildInvoiceCustomFieldsPayload,
    runInvoiceExtractionForDocument,
    extractInvoiceFields,
    MAX_CONTENT_LENGTH,
    type ExtractedInvoiceFields,
    type ExtractInvoiceFieldsResult,
    type ExtractInvoiceFieldsOptions,
    type ExtractInvoiceFieldsProcessedInfo,
    type InvoiceDocumentTypeKey,
} from './extract-invoice.ts';

export {
    findAndMergeDuplicates,
    type FindDuplicatesGroupInfo,
    type FindDuplicatesGroupChoice,
    type FindDuplicatesOptions,
    type FindDuplicatesResult,
} from './find-duplicates.ts';

export {
    reviewMetadata,
    type ReviewMetadataOptions,
    type ReviewMetadataResult,
    type ReviewMetadataProcessedInfo,
} from './review-metadata.ts';

export { getDocumentTypeHandlers, type DocumentTypeHandler } from './type-handlers.ts';

export {
    classifyDocuments,
    type ClassifyDocumentsOptions,
    type ClassifyDocumentsResult,
    type ClassifyDocumentProcessedInfo,
} from './classify-documents.ts';
