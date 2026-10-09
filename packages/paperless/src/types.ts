/**
 * Paperless-NGX API types (documents, tasks, custom fields).
 */

/** Custom field value on a document (value type depends on CustomField.data_type). */
export interface DocumentCustomFieldValue {
    field: number;
    value: unknown;
}

/** Document as returned by list/detail endpoints. */
export interface Document {
    id: number;
    title: string | null;
    content: string | null;
    correspondent: number | null;
    document_type: number | null;
    storage_path: number | null;
    tags: number[];
    created: string | null;
    modified: string | null;
    added: string | null;
    original_file_name: string | null;
    archived_file_name: string | null;
    archive_serial_number: number | null;
    custom_fields?: DocumentCustomFieldValue[];
    owner?: number | null;
    user_can_change?: boolean;
    notes?: unknown[];
    page_count?: number | null;
    mime_type?: string | null;
    deleted_at?: string | null;
    is_shared_by_requester?: boolean | null;
}

/** Options when posting a new document (multipart form). */
export interface PostDocumentOptions {
    title?: string;
    created?: string;
    correspondent?: number;
    document_type?: number;
    storage_path?: number;
    tags?: number[];
    archive_serial_number?: number;
    /** Field ID -> value; or use array of field IDs for empty assignment. */
    custom_fields?: Record<number, unknown> | number[];
}

/**
 * Response from POST /api/documents/post_document/.
 * Paperless returns the raw task UUID as a string (not an object).
 */
export type PostDocumentResponse = string;

/** Paginated document list. */
export interface PaginatedDocuments {
    count: number;
    next: string | null;
    previous: string | null;
    results: Document[];
}

/** Task (consumption status). */
export interface Task {
    id?: number;
    task_id: string;
    task_name?: string | null;
    task_file_name?: string | null;
    date_created?: string | null;
    date_done?: string | null;
    type?: string | null;
    status?: string | null;
    result?: string | null;
    acknowledged?: boolean | null;
    /** Created document ID when consumption succeeded. */
    related_document: number | string | null;
    owner?: number | null;
}

/** Custom field data types supported by the API. */
export type CustomFieldDataType =
    | 'string'
    | 'url'
    | 'date'
    | 'boolean'
    | 'integer'
    | 'float'
    | 'monetary'
    | 'documentlink'
    | 'select';

/** Select option for custom field type "select". */
export interface CustomFieldSelectOption {
    id?: string | null;
    label?: string | null;
}

/** Extra data for custom fields (e.g. select options, default currency). */
export interface CustomFieldExtraData {
    default_currency?: string | null;
    select_options?: CustomFieldSelectOption[] | null;
}

/** Custom field definition. */
export interface CustomField {
    id: number;
    name: string;
    data_type: CustomFieldDataType;
    extra_data?: CustomFieldExtraData | null;
    document_count?: number | null;
}

/** Options when creating a custom field. */
export interface CreateCustomFieldOptions {
    name: string;
    data_type: CustomFieldDataType;
    extra_data?: CustomFieldExtraData | null;
}

/** Options when updating a custom field (all optional). */
export interface UpdateCustomFieldOptions {
    name?: string;
    data_type?: CustomFieldDataType;
    extra_data?: CustomFieldExtraData | null;
}

/** Paginated custom fields list. */
export interface PaginatedCustomFields {
    count: number;
    next: string | null;
    previous: string | null;
    results: CustomField[];
}

/** Tag as returned by /api/tags/. */
export interface Tag {
    id: number;
    name: string;
    color?: number | null;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
    owner?: number | null;
    user_can_change?: boolean | null;
}

/** Paginated tags list. */
export interface PaginatedTags {
    count: number;
    next: string | null;
    previous: string | null;
    results: Tag[];
}

/** Options when creating a tag. */
export interface CreateTagOptions {
    name: string;
    color?: number | null;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
}

/** Document type as returned by /api/document_types/. */
export interface DocumentType {
    id: number;
    name: string;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
    owner?: number | null;
    user_can_change?: boolean | null;
}

/** Paginated document types list. */
export interface PaginatedDocumentTypes {
    count: number;
    next: string | null;
    previous: string | null;
    results: DocumentType[];
}

/** Payload for PATCH /api/documents/{id}/. */
export interface UpdateDocumentPayload {
    title?: string;
    correspondent?: number | null;
    document_type?: number | null;
    storage_path?: number | null;
    tags?: number[];
    custom_fields?: Array<{ field: number; value: unknown }>;
    archive_serial_number?: number | null;
    /** Document date (e.g. issue date). Format YYYY-MM-DD. */
    created?: string | null;
}

/** Correspondent as returned by /api/correspondents/. */
export interface Correspondent {
    id: number;
    name: string;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
    owner?: number | null;
    user_can_change?: boolean | null;
}

/** Paginated correspondents list. */
export interface PaginatedCorrespondents {
    count: number;
    next: string | null;
    previous: string | null;
    results: Correspondent[];
}

/** Options when creating a correspondent. */
export interface CreateCorrespondentOptions {
    name: string;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** IMAP security choices (matches MailAccount.ImapSecurity in Django). */
export type ImapSecurity = 1 | 2 | 3; // 1=None, 2=SSL, 3=STARTTLS

/** Mail account type choices (matches MailAccount.MailAccountType). */
export type MailAccountType = 1 | 2 | 3; // 1=IMAP, 2=Gmail OAuth, 3=Outlook OAuth

/** Mail account as returned by /api/mail_accounts/. */
export interface MailAccount {
    id: number;
    name: string;
    imap_server: string;
    imap_port: number | null;
    imap_security: ImapSecurity;
    username: string;
    /** Obfuscated in API responses (e.g. "**********"). */
    password: string;
    character_set: string;
    is_token: boolean;
    account_type: MailAccountType;
    expiration: string | null;
    owner?: number | null;
    user_can_change?: boolean;
    permissions?: Record<string, unknown>;
}

/** Paginated mail accounts list. */
export interface PaginatedMailAccounts {
    count: number;
    next: string | null;
    previous: string | null;
    results: MailAccount[];
}

/** Mail action choices (matches MailRule.MailAction). */
export type MailAction = 1 | 2 | 3 | 4 | 5; // 1=Delete, 2=Move, 3=Mark read, 4=Flag, 5=Tag

/** Consumption scope choices (matches MailRule.ConsumptionScope). */
export type ConsumptionScope = 1 | 2 | 3; // 1=Attachments only, 2=EML only, 3=Everything

/** Attachment processing choices (matches MailRule.AttachmentProcessing). */
export type AttachmentProcessing = 1 | 2; // 1=Attachments only, 2=Everything

/** Title source choices (matches MailRule.TitleSource). */
export type TitleSource = 1 | 2 | 3; // 1=From subject, 2=From filename, 3=None

/** Correspondent source choices (matches MailRule.CorrespondentSource). */
export type CorrespondentSource = 1 | 2 | 3 | 4; // 1=Nothing, 2=Email, 3=Name, 4=Custom

/** Mail rule as returned by /api/mail_rules/. */
export interface MailRule {
    id: number;
    name: string;
    account: number;
    enabled: boolean;
    folder: string;
    filter_from: string | null;
    filter_to: string | null;
    filter_subject: string | null;
    filter_body: string | null;
    filter_attachment_filename_include: string | null;
    filter_attachment_filename_exclude: string | null;
    maximum_age: number;
    action: MailAction;
    action_parameter: string | null;
    assign_title_from: TitleSource;
    assign_tags: number[];
    assign_correspondent_from: CorrespondentSource;
    assign_correspondent: number | null;
    assign_document_type: number | null;
    assign_owner_from_rule: boolean;
    order: number;
    attachment_type: AttachmentProcessing;
    consumption_scope: ConsumptionScope;
    pdf_layout: number;
    stop_processing: boolean;
    owner?: number | null;
    user_can_change?: boolean;
    permissions?: Record<string, unknown>;
}

/** Paginated mail rules list. */
export interface PaginatedMailRules {
    count: number;
    next: string | null;
    previous: string | null;
    results: MailRule[];
}

/** Processed mail as returned by /api/processed_mail/. */
export interface ProcessedMail {
    id: number;
    owner: number | null;
    rule: number;
    folder: string;
    uid: string;
    subject: string;
    received: string;
    processed: string;
    status: string;
    error: string | null;
}

/** Paginated processed mail list. */
export interface PaginatedProcessedMail {
    count: number;
    next: string | null;
    previous: string | null;
    results: ProcessedMail[];
}
