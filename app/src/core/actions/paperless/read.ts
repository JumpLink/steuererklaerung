/**
 * Read-only Paperless-NGX API actions for CLI commands.
 * Each function calls the client and returns the result (command layer handles output).
 */

import {
    listDocuments,
    getDocument,
    listDocumentTypes,
    getDocumentType,
    listCorrespondents,
    getCorrespondent,
    listTags,
    getTag,
    listCustomFields,
    getCustomField,
    getTask,
    listMailAccounts,
    getMailAccount,
    listMailRules,
    getMailRule,
    listProcessedMail,
    getProcessedMail,
    type ListDocumentsParams,
    type ListDocumentTypesParams,
    type ListCorrespondentsParams,
    type ListTagsParams,
    type ListCustomFieldsParams,
    type ListMailAccountsParams,
    type ListMailRulesParams,
    type ListProcessedMailParams,
} from '@steuererklaerung/paperless';
import { fetchAllPages } from '@steuererklaerung/paperless';

export async function paperlessDocuments(params: ListDocumentsParams = {}) {
    return listDocuments(params);
}

export async function paperlessDocument(id: number) {
    return getDocument(id);
}

export async function paperlessDocumentTypes(params: ListDocumentTypesParams = {}) {
    return listDocumentTypes(params);
}

export async function paperlessDocumentType(id: number) {
    return getDocumentType(id);
}

export async function paperlessCorrespondents(params: ListCorrespondentsParams = {}) {
    return listCorrespondents(params);
}

export async function paperlessCorrespondent(id: number) {
    return getCorrespondent(id);
}

/**
 * Fetch all tags from all pages and return a single PaginatedTags-like object
 * with count, results (all tags), and next/previous set to null.
 */
export async function paperlessTagsAll(): Promise<{
    count: number;
    next: null;
    previous: null;
    results: Awaited<ReturnType<typeof listTags>>['results'];
}> {
    const results = await fetchAllPages((page, pageSize) => listTags({ page_size: pageSize, page }));
    return {
        count: results.length,
        next: null,
        previous: null,
        results,
    };
}

export async function paperlessTags(params: ListTagsParams = {}) {
    return listTags(params);
}

export async function paperlessTag(id: number) {
    return getTag(id);
}

export async function paperlessCustomFields(params: ListCustomFieldsParams = {}) {
    return listCustomFields(params);
}

export async function paperlessCustomField(id: number) {
    return getCustomField(id);
}

export async function paperlessTask(taskId: string) {
    return getTask(taskId);
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export async function paperlessMailAccounts(params: ListMailAccountsParams = {}) {
    return listMailAccounts(params);
}

export async function paperlessMailAccount(id: number) {
    return getMailAccount(id);
}

export async function paperlessMailRules(params: ListMailRulesParams = {}) {
    return listMailRules(params);
}

export async function paperlessMailRule(id: number) {
    return getMailRule(id);
}

export async function paperlessProcessedMail(params: ListProcessedMailParams = {}) {
    return listProcessedMail(params);
}

export async function paperlessProcessedMailItem(id: number) {
    return getProcessedMail(id);
}
