/**
 * Paperless-NGX API – Mail accounts, mail rules, and processed mail.
 */

import { get } from './request.ts';
import type {
    MailAccount,
    PaginatedMailAccounts,
    MailRule,
    PaginatedMailRules,
    ProcessedMail,
    PaginatedProcessedMail,
} from './types.ts';

// ---------------------------------------------------------------------------
// Mail Accounts
// ---------------------------------------------------------------------------

const MAIL_ACCOUNTS_PATH = '/api/mail_accounts/';

export interface ListMailAccountsParams {
    page_size?: number;
    page?: number;
}

export async function listMailAccounts(params: ListMailAccountsParams = {}): Promise<PaginatedMailAccounts> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedMailAccounts>(MAIL_ACCOUNTS_PATH, query);
}

export async function getMailAccount(id: number): Promise<MailAccount> {
    return get<MailAccount>(`${MAIL_ACCOUNTS_PATH}${id}/`);
}

// ---------------------------------------------------------------------------
// Mail Rules
// ---------------------------------------------------------------------------

const MAIL_RULES_PATH = '/api/mail_rules/';

export interface ListMailRulesParams {
    page_size?: number;
    page?: number;
}

export async function listMailRules(params: ListMailRulesParams = {}): Promise<PaginatedMailRules> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    return get<PaginatedMailRules>(MAIL_RULES_PATH, query);
}

export async function getMailRule(id: number): Promise<MailRule> {
    return get<MailRule>(`${MAIL_RULES_PATH}${id}/`);
}

// ---------------------------------------------------------------------------
// Processed Mail
// ---------------------------------------------------------------------------

const PROCESSED_MAIL_PATH = '/api/processed_mail/';

export interface ListProcessedMailParams {
    page_size?: number;
    page?: number;
    rule?: number;
}

export async function listProcessedMail(params: ListProcessedMailParams = {}): Promise<PaginatedProcessedMail> {
    const query: Record<string, unknown> = {};
    if (params.page_size != null) query.page_size = params.page_size;
    if (params.page != null) query.page = params.page;
    if (params.rule != null) query.rule = params.rule;
    return get<PaginatedProcessedMail>(PROCESSED_MAIL_PATH, query);
}

export async function getProcessedMail(id: number): Promise<ProcessedMail> {
    return get<ProcessedMail>(`${PROCESSED_MAIL_PATH}${id}/`);
}
