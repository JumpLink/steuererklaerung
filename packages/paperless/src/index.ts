/**
 * Paperless-NGX API client.
 * Documents (list, get, post, update), tasks (consumption status), custom fields (CRUD).
 */

import type { ApiCheckResult } from '@steuererklaerung/shared';
import { config, probeApiVersion } from './request.ts';

/**
 * Check connectivity to Paperless-NGX — and, in the same request, whether the instance still
 * serves the API version this client pins.
 */
export async function check(): Promise<ApiCheckResult> {
    const result = config();
    if (result.error) {
        return {
            name: 'Paperless-NGX',
            ok: false,
            message: result.error,
        };
    }
    try {
        const info = await probeApiVersion();
        if (!info.accepted) {
            return {
                name: 'Paperless-NGX',
                ok: false,
                message:
                    `Die Instanz nimmt API-Version ${info.pinned} nicht mehr an (HTTP 406). ` +
                    'Der Client muss auf die neue Version portiert werden — siehe PAPERLESS_API_VERSION.',
            };
        }
        const release = info.release ? `Paperless ${info.release}` : 'Paperless';
        // Say it on every run, not once at upgrade time: a server that has moved past our pin is
        // still working today and broken on the day the old version is dropped.
        const drift =
            info.served && info.served !== info.pinned
                ? `, Server bietet v${info.served} — wir sprechen v${info.pinned}`
                : `, API v${info.pinned}`;
        return {
            name: 'Paperless-NGX',
            ok: true,
            message: `OK (${release}${drift}, documents: ${info.documentCount ?? '—'})`,
        };
    } catch (err) {
        return {
            name: 'Paperless-NGX',
            ok: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export {
    listDocuments,
    getDocument,
    downloadDocument,
    downloadThumbnail,
    postDocument,
    contentTypeForFilename,
    updateDocument,
    bulkEditDocuments,
    deleteDocument,
} from './documents.ts';
export type { ListDocumentsParams, DownloadDocumentOptions } from './documents.ts';

export { listDocumentTypes, getDocumentType, createDocumentType } from './document-types.ts';
export type { ListDocumentTypesParams, CreateDocumentTypeOptions } from './document-types.ts';

export { listCorrespondents, getCorrespondent, createCorrespondent } from './correspondents.ts';
export type { ListCorrespondentsParams } from './correspondents.ts';

export { listTags, getTag, createTag } from './tags.ts';
export type { ListTagsParams } from './tags.ts';

export { getTask, waitForTaskResult } from './tasks.ts';
export type { WaitForTaskResultOptions, WaitForTaskResultOutcome } from './tasks.ts';

export { listCustomFields, getCustomField, createCustomField, updateCustomField } from './custom-fields.ts';
export type { ListCustomFieldsParams } from './custom-fields.ts';

export {
    listMailAccounts,
    getMailAccount,
    listMailRules,
    getMailRule,
    listProcessedMail,
    getProcessedMail,
} from './mail.ts';
export type { ListMailAccountsParams, ListMailRulesParams, ListProcessedMailParams } from './mail.ts';

export type {
    Document,
    DocumentCustomFieldValue,
    DocumentType,
    PaginatedDocumentTypes,
    PostDocumentOptions,
    PostDocumentResponse,
    PaginatedDocuments,
    UpdateDocumentPayload,
    Task,
    Tag,
    PaginatedTags,
    CreateTagOptions,
    Correspondent,
    PaginatedCorrespondents,
    CreateCorrespondentOptions,
    CustomField,
    CustomFieldDataType,
    CustomFieldExtraData,
    CustomFieldSelectOption,
    CreateCustomFieldOptions,
    UpdateCustomFieldOptions,
    PaginatedCustomFields,
    MailAccount,
    PaginatedMailAccounts,
    MailRule,
    PaginatedMailRules,
    ProcessedMail,
    PaginatedProcessedMail,
} from './types.ts';

// Request layer (config/creds resolution + the low-level get/post/… helpers).
export * from './request.ts';
// Document-field helpers (custom-field reads, monetary parsing, merge).
export * from './helpers.ts';
// Generic Paperless-style pagination ({results, next}) used by the read aggregations.
export * from './pagination.ts';
