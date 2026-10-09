export { check as checkQonto } from './qonto/index.ts';
export {
    check as checkPaperless,
    listDocuments,
    getDocument,
    postDocument,
    updateDocument,
    bulkEditDocuments,
    getTask,
    listCustomFields,
    getCustomField,
    createCustomField,
    updateCustomField,
} from '@steuererklaerung/paperless';
export type {
    ListDocumentsParams,
    ListCustomFieldsParams,
    Document,
    DocumentCustomFieldValue,
    PostDocumentOptions,
    PostDocumentResponse,
    PaginatedDocuments,
    UpdateDocumentPayload,
    Task,
    CustomField,
    CustomFieldDataType,
    CustomFieldExtraData,
    CustomFieldSelectOption,
    CreateCustomFieldOptions,
    UpdateCustomFieldOptions,
    PaginatedCustomFields,
    PaperlessConfig,
    ConfigResult,
} from '@steuererklaerung/paperless';
export { check as checkInwx } from './inwx/index.ts';
export { check as checkFinTS } from './fints/index.ts';
