/**
 * PDF account statements from the bank (FinTS HKEKA/HIEKA) into the DMS.
 *
 * Dry run by default: the bank is asked (decoupled TAN as everywhere else), the plan says which
 * statements the DMS lacks. Writes happen only with `apply`, and only through the entity's
 * {@link DmsProvider} (never raw Paperless).
 *
 * Dedupe: the DMS has no generic custom-field surface, so the identity of a statement is a
 * deterministic title `Kontoauszug <config name> <account number> <year>/<number>` ({@link statementTitle}).
 * It is read back with {@link parseStatementTitle}; documents of type "Kontoauszug" whose title
 * does not parse are ignored. Identical bytes are additionally caught by the DMS (checksum) and
 * count as "already there".
 */

import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';
import type { ElectronicStatement } from 'lib-fints';
import { defaultEntityFor } from '../config/entities.ts';
import { getAccountConfig, loadFinTSConfig, loadManifest } from '../config/index.ts';
import { getAccounts, getElectronicStatements } from '../clients/fints/index.ts';
import { _ } from '../lib/i18n.ts';
import { resolveEntityDms } from './link-candidates.ts';

export const STATEMENT_DOCUMENT_TYPE = 'Kontoauszug';
export const STATEMENT_INBOX_TAG = 'Neu';

export interface StatementKey {
    account: string;
    accountNumber: string;
    year: number;
    number: number;
}

export function statementTitle(k: StatementKey): string {
    return `${STATEMENT_DOCUMENT_TYPE} ${k.account} ${k.accountNumber} ${k.year}/${String(k.number).padStart(3, '0')}`;
}

const TITLE_RE = new RegExp(`^${STATEMENT_DOCUMENT_TYPE} (.+) (\\S+) (\\d{4})/(\\d+)$`);

export function parseStatementTitle(title: string | null): StatementKey | null {
    const m = title ? TITLE_RE.exec(title) : null;
    return m ? { account: m[1], accountNumber: m[2], year: Number(m[3]), number: Number(m[4]) } : null;
}

const keyId = (k: StatementKey) => `${k.account}|${k.accountNumber}|${k.year}|${k.number}`;
const isoDay = (d?: Date) => (d ? d.toISOString().slice(0, 10) : undefined);

export type StatementDecision = 'upload' | 'exists' | 'no-number' | 'error';

export interface StatementPlanEntry {
    account: string;
    accountNumber: string;
    year?: number;
    number?: number;
    from?: string;
    to?: string;
    date?: string;
    title?: string;
    decision: StatementDecision;
    documentId?: string;
    /** Set after an apply run when the document was written (or found by checksum). */
    applied?: boolean;
    error?: string;
}

export interface StatementGap {
    account: string;
    accountNumber: string;
    year: number;
    missing: number[];
}

export interface FintsStatementsResult {
    dryRun: boolean;
    bank?: string;
    toUpload: number;
    applied: number;
    notes: string[];
    entries: StatementPlanEntry[];
}

/** One account's fetched statements, or the reason the bank would not give them. */
export interface FetchedAccount {
    account: string;
    accountNumber: string;
    bankName?: string;
    statements: ElectronicStatement[];
    error?: string;
}

export interface StatementsDeps {
    provider: DmsProvider;
    fetch: (accountName?: string, accountNumber?: string) => Promise<FetchedAccount[]>;
}

/** Gaps = numbers missing between 1 and the highest number seen, per account and year. */
export function findGaps(titles: Array<string | null>): StatementGap[] {
    const seen = new Map<string, { key: StatementKey; numbers: Set<number> }>();
    for (const k of titles.map(parseStatementTitle)) {
        if (!k) continue;
        const id = `${k.account}|${k.accountNumber}|${k.year}`;
        const slot = seen.get(id) ?? { key: k, numbers: new Set<number>() };
        slot.numbers.add(k.number);
        seen.set(id, slot);
    }
    const gaps: StatementGap[] = [];
    for (const { key, numbers } of seen.values()) {
        const max = Math.max(...numbers);
        const missing: number[] = [];
        for (let n = 1; n <= max; n++) if (!numbers.has(n)) missing.push(n);
        if (missing.length > 0)
            gaps.push({ account: key.account, accountNumber: key.accountNumber, year: key.year, missing });
    }
    return gaps.sort((a, b) => a.account.localeCompare(b.account) || a.year - b.year);
}

async function fetchFromBank(accountName?: string, accountNumber?: string): Promise<FetchedAccount[]> {
    const account = getAccountConfig(loadFinTSConfig(), accountName);
    const numbers = accountNumber ? [accountNumber] : getAccounts(account).map((a) => a.accountNumber);
    const out: FetchedAccount[] = [];
    for (const number of numbers) {
        try {
            const batch = await getElectronicStatements(account, number);
            out.push({
                account: account.name,
                accountNumber: number,
                bankName: batch.bankName,
                statements: batch.statements,
            });
        } catch (err) {
            out.push({
                account: account.name,
                accountNumber: number,
                statements: [],
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return out;
}

function defaultDeps(entityId: string): StatementsDeps {
    return { provider: resolveEntityDms(entityId).provider, fetch: fetchFromBank };
}

export function defaultStatementsEntity(entityId?: string): string {
    return entityId ?? defaultEntityFor(loadManifest()).id;
}

async function existingStatements(provider: DmsProvider): Promise<DmsDocument[]> {
    if (!provider.listByDocumentType) throw new Error(_('This DMS cannot list documents by type.'));
    return provider.listByDocumentType(STATEMENT_DOCUMENT_TYPE);
}

export interface StatementsOptions {
    entityId: string;
    account?: string;
    accountNumber?: string;
    /** YYYY-MM-DD: skip statements that end before this day. */
    from?: string;
    apply?: boolean;
    acknowledge?: boolean;
}

export async function fintsStatements(
    options: StatementsOptions,
    deps: StatementsDeps = defaultDeps(options.entityId),
): Promise<FintsStatementsResult> {
    if (options.acknowledge) {
        // lib-fints 1.5.x can fetch but has no receipt call (HKEKQ); say so instead of ignoring the flag.
        throw new Error(_('Acknowledging receipt is not supported by the FinTS library yet.'));
    }
    const apply = options.apply === true;
    const { provider } = deps;
    const notes: string[] = [];
    const known = new Set(
        (await existingStatements(provider))
            .map((d) => parseStatementTitle(d.title))
            .filter((k): k is StatementKey => k !== null)
            .map(keyId),
    );
    const fetched = await deps.fetch(options.account, options.accountNumber);
    const bank = fetched.find((f) => f.bankName)?.bankName;

    let correspondent: string | undefined;
    let tags: string[] | undefined;
    if (apply) {
        const vocab = async (kind: 'correspondent' | 'tag' | 'documentType') =>
            (await provider.listVocabulary?.(kind)) ?? [];
        if (!(await vocab('documentType')).some((e) => e.name === STATEMENT_DOCUMENT_TYPE))
            throw new Error(_('The document type "Kontoauszug" does not exist in the DMS.'));
        if (bank && (await vocab('correspondent')).some((e) => e.name === bank)) correspondent = bank;
        else notes.push(_('No correspondent with the bank name exists in the DMS; uploaded without one.'));
        if ((await vocab('tag')).some((e) => e.name === STATEMENT_INBOX_TAG)) tags = [STATEMENT_INBOX_TAG];
        else notes.push(_('The tag "Neu" does not exist in the DMS; uploaded without it.'));
    }

    const entries: StatementPlanEntry[] = [];
    for (const f of fetched) {
        if (f.error) {
            entries.push({ account: f.account, accountNumber: f.accountNumber, decision: 'error', error: f.error });
            continue;
        }
        for (const s of f.statements) {
            if (options.from && (isoDay(s.to) ?? isoDay(s.date) ?? '9999') < options.from) continue;
            const base = {
                account: f.account,
                accountNumber: f.accountNumber,
                year: s.year,
                number: s.number,
                from: isoDay(s.from),
                to: isoDay(s.to),
                date: isoDay(s.date),
            };
            if (s.year == null || s.number == null) {
                entries.push({ ...base, decision: 'no-number' });
                continue;
            }
            const key: StatementKey = {
                account: f.account,
                accountNumber: f.accountNumber,
                year: s.year,
                number: s.number,
            };
            const title = statementTitle(key);
            if (known.has(keyId(key))) {
                entries.push({ ...base, title, decision: 'exists' });
                continue;
            }
            const entry: StatementPlanEntry = { ...base, title, decision: 'upload' };
            entries.push(entry);
            if (!apply) continue;
            try {
                if (!provider.ingest) throw new Error(_('This DMS cannot ingest documents.'));
                const res = await provider.ingest({
                    bytes: s.document,
                    filename: `${title.replaceAll(/[^\w.-]+/g, '_')}.pdf`,
                    mimeType: 'application/pdf',
                    title,
                    created: base.to ?? base.date,
                    documentType: STATEMENT_DOCUMENT_TYPE,
                    correspondent,
                    tags,
                });
                entry.documentId = res.document.id;
                entry.applied = true;
                if (!res.created) entry.decision = 'exists';
                known.add(keyId(key));
            } catch (err) {
                entry.decision = 'error';
                entry.error = err instanceof Error ? err.message : String(err);
            }
        }
    }
    return {
        dryRun: !apply,
        bank,
        toUpload: entries.filter((e) => e.decision === 'upload').length,
        applied: entries.filter((e) => e.applied && e.decision === 'upload').length,
        notes,
        entries,
    };
}

/** Which statement numbers are missing per account and year, from the DMS alone (no bank call). */
export async function fintsStatementGaps(
    entityId: string,
    provider: DmsProvider = defaultDeps(entityId).provider,
): Promise<StatementGap[]> {
    return findGaps((await existingStatements(provider)).map((d) => d.title));
}
