/**
 * Verträge (ADR 0004) — the ledger side shared by the CLI and MCP: list, read, save and archive
 * contracts, record which bookings and documents belong to one, and derive what the pure rules in
 * core/contracts compute from them (candidates, findings, notice deadlines, the calendar export).
 *
 * Reads never create the ledger (no ledger yet = no contracts); writes go through the store's
 * audit-logged repo. Bookings come from the contract's account, else from all of its entity's.
 */

import {
    type ContractDocumentRecord,
    type ContractDocumentRole,
    type ContractInput,
    type ContractRecord,
    type ContractTransactionRecord,
    type ContractTxStatus,
    type LedgerDatabase,
    archiveContract,
    getContract,
    getContractDocuments,
    getContractTransactions,
    ledgerDbExists,
    ledgerDbPath,
    listContracts,
    migrate,
    openLedger,
    saveContract,
    searchAccountKeys,
    setContractDocument,
    setContractTransaction,
} from '@steuererklaerung/store';
import {
    buildContractIcsEvents,
    type ContractBooking,
    type ContractCandidate,
    contractCandidates,
    contractFindings,
    type ContractFinding,
    monthlyAmount,
    noticeDeadline,
    type NoticeDeadline,
    upcomingDeadlines,
} from '../contracts/contracts.ts';
import { buildIcs } from './ics.ts';
import { entityAccountKeys } from './invoice-payments.ts';
import { todayIso } from './recurring-invoices.ts';

function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

function readLedger<T>(fallback: T, fn: (db: LedgerDatabase) => T): T {
    if (!ledgerDbExists()) return fallback;
    return withLedger(fn);
}

const nowIso = () => new Date().toISOString();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject what the schema cannot hold sensibly; the enums are checked by the frontends' parsers. */
function validate(input: ContractInput): void {
    for (const f of ['startDate', 'endDate'] as const) {
        const v = input[f];
        if (v != null && !ISO_DATE.test(v)) throw new Error(`${f} muss JJJJ-MM-TT sein, nicht '${v}'`);
    }
    for (const f of ['amount', 'amountTolerance'] as const) {
        const v = input[f];
        if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error(`${f} muss ≥ 0 sein`);
    }
    for (const f of ['initialTermMonths', 'renewalMonths', 'noticeValue'] as const) {
        const v = input[f];
        if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error(`${f} muss eine ganze Zahl ≥ 0 sein`);
    }
}

export interface ContractSummary extends ContractRecord {
    monthlyAmount: number | null;
    deadline: NoticeDeadline;
}

/** Contracts with their monthly cost and next notice deadline. Archived ones only on request. */
export function loadContracts(
    opts: { entityId?: string; includeArchived?: boolean; today?: string } = {},
): ContractSummary[] {
    const today = opts.today ?? todayIso();
    return readLedger([], (db) => listContracts(db, opts)).map((c) => ({
        ...c,
        monthlyAmount: monthlyAmount(c),
        deadline: noticeDeadline(c, today),
    }));
}

export interface ContractDetail {
    contract: ContractSummary;
    transactions: ContractTransactionRecord[];
    documents: ContractDocumentRecord[];
}

export function loadContract(id: string, today = todayIso()): ContractDetail | undefined {
    return readLedger(undefined, (db) => {
        const c = getContract(db, id);
        if (!c) return undefined;
        return {
            contract: { ...c, monthlyAmount: monthlyAmount(c), deadline: noticeDeadline(c, today) },
            transactions: getContractTransactions(db, id),
            documents: getContractDocuments(db, id),
        };
    });
}

export function saveContractRecord(input: ContractInput): ContractRecord {
    validate(input);
    return withLedger((db) => saveContract(db, input, nowIso()));
}

/** False if the contract is unknown. */
export function archiveContractRecord(id: string): boolean {
    return withLedger((db) => archiveContract(db, id, nowIso()));
}

/** `linked`, `rejected`, or `null` to drop the decision. */
export function decideContractTransaction(
    contractId: string,
    txId: string,
    status: ContractTxStatus | null,
    decidedBy?: string | null,
): void {
    withLedger((db) => setContractTransaction(db, contractId, txId, status, nowIso(), decidedBy));
}

/** Attach a DMS document (`paperless:<id>` or a built-in ref) with a role, or detach it with `null`. */
export function linkContractDocument(contractId: string, documentRef: string, role: ContractDocumentRole | null): void {
    withLedger((db) => setContractDocument(db, contractId, documentRef, role, nowIso()));
}

export interface ContractMatch {
    contract: ContractRecord;
    /** Newest booking on the searched accounts — the date findings are measured against. */
    asOf: string | null;
    candidates: ContractCandidate[];
    findings: ContractFinding[];
}

function bookingsFor(c: ContractRecord): ContractBooking[] {
    const keys = c.accountKey ? [c.accountKey] : entityAccountKeys(c.entityId);
    return keys.length ? searchAccountKeys(keys) : [];
}

/**
 * Candidate bookings and findings (missing / returned / changed) of one contract. Read-only: linking
 * a candidate stays the owner's call ({@link decideContractTransaction}). `bookings` overrides the
 * store lookup (tests, a caller that already holds them).
 */
export function matchContract(id: string, bookings?: readonly ContractBooking[]): ContractMatch | undefined {
    const loaded = readLedger(undefined, (db) => {
        const contract = getContract(db, id);
        return contract ? { contract, decisions: getContractTransactions(db, id) } : undefined;
    });
    if (!loaded) return undefined;
    const { contract, decisions } = loaded;
    const txs = bookings ?? bookingsFor(contract);
    const asOf = txs.reduce<string | null>(
        (max, t) => (max == null || t.bookingDate > max ? t.bookingDate : max),
        null,
    );
    return {
        contract,
        asOf,
        candidates: contractCandidates(contract, txs, decisions),
        findings: asOf ? contractFindings(contract, txs, decisions, asOf) : [],
    };
}

/** Contracts whose latest notice date falls within `days` (default 90), soonest first. */
export function contractDeadlines(opts: { entityId?: string; days?: number; today?: string } = {}) {
    const today = opts.today ?? todayIso();
    const contracts = readLedger([], (db) => listContracts(db, { entityId: opts.entityId }));
    return upcomingDeadlines(contracts, today, opts.days ?? 90);
}

/** The deadlines as an iCalendar file (one all-day event with an alarm per contract). */
export function contractDeadlinesIcs(opts: { entityId?: string; days?: number; today?: string } = {}): string {
    const dtstamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    return buildIcs(buildContractIcsEvents(contractDeadlines(opts)), {
        dtstamp,
        calName: 'Verträge — Kündigungsfristen',
    });
}
