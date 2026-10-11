/**
 * Verträge presenter (ADR 0004) — the READ/DERIVE seam of the contracts surface: the list with its
 * monthly total, the findings per contract, the notice-deadline urgency a badge is styled by, and one
 * contract's detail together with its candidate bookings.
 *
 * Reads and derives only — the writes (save / archive / decide a booking / link a document / the
 * calendar export) stay in `core/actions/contracts.ts` and are re-exported here so a frontend imports
 * one module. The rules themselves live in `core/contracts/contracts.ts`; nothing is computed twice.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on
 * GJS in every frontend. Entity-scoped by `entityId` (a string), not the desktop's AppEntity.
 */

import {
    archiveContractRecord,
    contractDeadlines,
    contractDeadlinesIcs,
    decideContractTransaction,
    linkContractDocument,
    loadContract,
    loadContracts,
    matchContract,
    saveContractRecord,
    type ContractDetail,
    type ContractMatch,
    type ContractSummary,
} from '../actions/contracts.ts';
import { entityAccountKeys } from '../actions/invoice-payments.ts';
import type { ContractFinding, NoticeDeadline } from '../contracts/contracts.ts';

export {
    archiveContractRecord,
    contractDeadlines,
    contractDeadlinesIcs,
    decideContractTransaction,
    linkContractDocument,
    saveContractRecord,
};
export type { ContractDetail, ContractMatch, ContractSummary };
export type { ContractFinding, NoticeDeadline } from '../contracts/contracts.ts';

const today0 = () => new Date().toISOString().slice(0, 10);

/** Which contracts a list shows. `deadline` = the notice date is near enough to act on. */
export type ContractFilter = 'all' | 'active' | 'deadline' | 'archived';

/** How close the next notice deadline is — what a badge is coloured by. */
export type DeadlineUrgency = 'none' | 'later' | 'soon' | 'urgent';

/** Less than this many days to the latest notice date: act now, the deadline is the hard one. */
export const DEADLINE_URGENT_DAYS = 14;

/** Within this many days the deadline is worth showing as its own filter. */
export const DEADLINE_SOON_DAYS = 60;

/** The findings of one contract, keyed by contract id — absent means none were derivable. */
export type ContractFindings = Record<string, ContractFinding[]>;

export interface ContractOverview {
    /** Every contract of the entity including the archived ones; {@link filterContracts} narrows. */
    contracts: ContractSummary[];
    findings: ContractFindings;
    /** EUR per month over the active contracts. */
    monthlyTotal: number;
}

/**
 * The contracts of an entity with their findings and monthly total. One `matchContract` per contract
 * (each opens the ledger), fail-soft: a contract whose bookings cannot be read is still listed, just
 * without findings.
 */
export function loadContractOverview(
    opts: { entityId?: string; includeArchived?: boolean; today?: string } = {},
): ContractOverview {
    const today = opts.today ?? today0();
    const contracts = loadContracts({
        entityId: opts.entityId,
        includeArchived: opts.includeArchived ?? true,
        today,
    });
    const findings: ContractFindings = {};
    for (const c of contracts) {
        try {
            const m = matchContract(c.id, undefined, today);
            if (m) findings[c.id] = m.findings;
        } catch {
            /* bookings unreadable — the contract is listed without findings */
        }
    }
    return { contracts, findings, monthlyTotal: monthlyTotal(contracts) };
}

export interface ContractDetailView {
    detail: ContractDetail;
    /** Candidate bookings, the accounts they came from and the findings; absent if unreadable. */
    match?: ContractMatch;
}

/** One contract with its linked bookings, documents and candidates. Undefined if the id is unknown. */
export function loadContractDetail(id: string, today: string = today0()): ContractDetailView | undefined {
    const detail = loadContract(id, today);
    if (!detail) return undefined;
    let match: ContractMatch | undefined;
    try {
        match = matchContract(id, undefined, today);
    } catch {
        /* bookings unreadable — detail without candidates */
    }
    return match ? { detail, match } : { detail };
}

/** EUR per month over the ACTIVE contracts of the list — a cancelled one no longer costs. */
export function monthlyTotal(list: readonly ContractSummary[]): number {
    const sum = list.reduce((s, c) => s + (c.status === 'active' ? (c.monthlyAmount ?? 0) : 0), 0);
    return Math.round(sum * 100) / 100;
}

/** How urgent the deadline is; everything without a fixed notice date is `none`. */
export function deadlineUrgency(d: NoticeDeadline): DeadlineUrgency {
    if (d.kind !== 'fixed') return 'none';
    if (d.daysLeft <= DEADLINE_URGENT_DAYS) return 'urgent';
    if (d.daysLeft <= DEADLINE_SOON_DAYS) return 'soon';
    return 'later';
}

/** The date a finding is about — what the list sorts and dates them by. */
export function findingDate(f: ContractFinding): string {
    if (f.kind === 'missing') return f.expectedDate;
    if (f.kind === 'no_data') return f.since;
    return f.date;
}

/**
 * The newest finding — the one line a list row has room for. `no_data` ranks last regardless of
 * date: it is a property of the ACCOUNT, not of the contract, so it is identical on every contract
 * paid from that account and would otherwise mask what is actually wrong with this one. It still
 * wins when it is all there is.
 */
export function latestFinding(findings: readonly ContractFinding[] | undefined): ContractFinding | undefined {
    if (!findings?.length) return undefined;
    const specific = findings.filter((f) => f.kind !== 'no_data');
    const pool = specific.length ? specific : findings;
    return pool.reduce((newest, f) => (findingDate(f) > findingDate(newest) ? f : newest));
}

/**
 * The accounts a contract may be paid from, for the form's picker. Fail-soft: without transaction
 * data the form offers "any account" only instead of refusing to open.
 */
export function contractAccountKeys(entityId: string): string[] {
    try {
        return entityAccountKeys(entityId);
    } catch {
        return [];
    }
}

/** The filter chips over a loaded list. `all` hides the archived ones; `archived` shows only those. */
export function filterContracts(list: readonly ContractSummary[], filter: ContractFilter): ContractSummary[] {
    if (filter === 'archived') return list.filter((c) => c.status === 'archived');
    const live = list.filter((c) => c.status !== 'archived');
    if (filter === 'active') return live.filter((c) => c.status === 'active');
    if (filter === 'deadline') {
        const urgent = (c: ContractSummary) => {
            const u = deadlineUrgency(c.deadline);
            return u === 'soon' || u === 'urgent';
        };
        return live.filter(urgent);
    }
    return live;
}
