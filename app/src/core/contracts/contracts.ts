/**
 * Verträge (ADR 0004) — the pure rules: when the next notice deadline is, which bookings match a
 * contract, and what is wrong with its payments. Contracts and bookings in, deadlines, candidates and
 * findings out; nothing here reads the ledger or the clock (the caller passes `today` / `asOf`).
 *
 * Matching and the payment calendar reuse the series helpers of the Laufende Kosten (`serie.ts`):
 * the same intervals, the same month-end clamp and the same ± {@link SERIE_TOLERANZ_TAGE} days.
 */

import type { ContractRecord, ContractTransactionRecord, UnifiedTransaction } from '@steuererklaerung/store';
import type { IcsEvent } from '../actions/ics.ts';
import { ABSTAND_MONATE, gleichePartei, plusMonate, SERIE_TOLERANZ_TAGE } from '../elster/serie.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';

/** How long after a debit a credit of the same amount still counts as its return (SEPA: 8 weeks). */
export const RUECKLASTSCHRIFT_FENSTER_TAGE = 60;

/** Days before the latest notice date at which the calendar alarm fires. */
export const KUENDIGUNG_ALARM_TAGE = 14;

/** A cent: the window when a contract names an amount but no tolerance. */
const CENT = 0.005;

export type ContractBooking = Pick<
    UnifiedTransaction,
    'id' | 'bookingDate' | 'amount' | 'accountKey' | 'counterparty' | 'counterpartyIban' | 'purpose' | 'reference'
>;

// ── dates ──────────────────────────────────────────────────────────────

function lastOfMonth(iso: string): boolean {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCDate() === 1;
}

export function plusDays(iso: string, n: number): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * `iso` minus `n` months the way a notice period is counted back (§ 188 BGB): from the last day of a
 * month to the last day of the target month (30 Apr − 3 → 31 Jan), else the day clamped.
 */
export function minusMonths(iso: string, n: number): string {
    const back = plusMonate(iso, -n);
    if (!lastOfMonth(iso)) return back;
    return plusDays(plusMonate(`${back.slice(0, 7)}-01`, 1), -1);
}

/** Term end of `months` from `start`: the day before the same date `months` later. */
function termEndFrom(start: string, months: number): string {
    return plusDays(plusMonate(start, months), -1);
}

function minusNotice(end: string, c: Pick<ContractRecord, 'noticeValue' | 'noticeUnit'>): string {
    const v = c.noticeValue ?? 0;
    if (c.noticeUnit === 'days') return plusDays(end, -v);
    if (c.noticeUnit === 'weeks') return plusDays(end, -7 * v);
    return minusMonths(end, v);
}

function plusNotice(start: string, c: Pick<ContractRecord, 'noticeValue' | 'noticeUnit'>): string {
    const v = c.noticeValue ?? 0;
    if (c.noticeUnit === 'days') return plusDays(start, v);
    if (c.noticeUnit === 'weeks') return plusDays(start, 7 * v);
    return plusMonate(start, v);
}

// ── notice deadlines ───────────────────────────────────────────────────

export type NoticeDeadline =
    | {
          /** A fixed term: notice must arrive by `latestNotice` to end the contract on `termEnd`. */
          kind: 'fixed';
          termEnd: string;
          latestNotice: string;
          /** From `today`; negative never happens (a passed deadline rolls to the next term). */
          daysLeft: number;
      }
    | {
          /** Indefinite: cancellable at any time; notice given today ends it on `termEnd`. */
          kind: 'anytime';
          termEnd: string;
      }
    | {
          kind: 'none';
          /** Why there is no deadline — the contract says so instead of showing nothing. */
          reason: string;
      };

/**
 * The next notice deadline of a contract as of `today`. Derived on every read, never stored: term end
 * = start + initial term, rolled forward by the renewal period while its notice date has passed; with
 * no renewal period the contract runs indefinitely after the initial term. Not shifted for weekends.
 */
export function noticeDeadline(c: ContractRecord, today: string): NoticeDeadline {
    if (c.status === 'cancelled')
        return { kind: 'none', reason: `gekündigt${c.endDate ? `, endet ${c.endDate}` : ''}` };
    if (c.status === 'ended' || c.status === 'archived') return { kind: 'none', reason: 'beendet' };
    if (!c.startDate) return { kind: 'none', reason: 'kein Vertragsbeginn' };
    if (c.noticeValue == null || !c.noticeUnit) return { kind: 'none', reason: 'keine Kündigungsfrist' };

    const fixed = (termEnd: string): NoticeDeadline => {
        const latestNotice = minusNotice(termEnd, c);
        return { kind: 'fixed', termEnd, latestNotice, daysLeft: dayDiff(latestNotice, today) ?? 0 };
    };
    const anytime = (): NoticeDeadline => ({ kind: 'anytime', termEnd: plusNotice(today, c) });

    if (c.endDate && !c.autoRenewal) {
        return c.endDate >= today
            ? { kind: 'none', reason: `endet ${c.endDate} ohne Kündigung` }
            : { kind: 'none', reason: 'beendet' };
    }
    if (!c.initialTermMonths) return anytime();

    let end = termEndFrom(c.startDate, c.initialTermMonths);
    if (minusNotice(end, c) >= today) return fixed(end);
    if (!c.autoRenewal)
        return end >= today
            ? { kind: 'none', reason: `endet ${end}, Frist verstrichen` }
            : { kind: 'none', reason: 'beendet' };
    if (!c.renewalMonths) return anytime();
    while (minusNotice(end, c) < today) end = termEndFrom(plusDays(end, 1), c.renewalMonths);
    return fixed(end);
}

/** Contracts whose latest notice date lies within `days` of `today`, soonest first. */
export function upcomingDeadlines(
    contracts: readonly ContractRecord[],
    today: string,
    days: number,
): { contract: ContractRecord; deadline: Extract<NoticeDeadline, { kind: 'fixed' }> }[] {
    const out: { contract: ContractRecord; deadline: Extract<NoticeDeadline, { kind: 'fixed' }> }[] = [];
    for (const contract of contracts) {
        const deadline = noticeDeadline(contract, today);
        if (deadline.kind === 'fixed' && deadline.daysLeft <= days) out.push({ contract, deadline });
    }
    return out.sort((a, b) => a.deadline.latestNotice.localeCompare(b.deadline.latestNotice));
}

/**
 * Calendar entries for the deadlines, as `buildFristenIcsEvents` does for tax deadlines. The uid holds
 * the contract and the date, so a re-export updates the entry and the next term gets a new one.
 */
export function buildContractIcsEvents(items: ReturnType<typeof upcomingDeadlines>): IcsEvent[] {
    return items.map(({ contract, deadline }) => ({
        uid: `contract-${contract.id}-${deadline.latestNotice}`,
        date: deadline.latestNotice,
        summary: `Kündigungsfrist: ${contract.name}`,
        description: [
            `Spätestens heute muss die Kündigung beim Anbieter eingehen, damit der Vertrag am ${deadline.termEnd} endet.`,
            contract.counterparty ? `Anbieter: ${contract.counterparty}` : null,
            contract.contractNumber ? `Vertragsnummer: ${contract.contractNumber}` : null,
        ]
            .filter(Boolean)
            .join('\n'),
        alarmDaysBefore: KUENDIGUNG_ALARM_TAGE,
    }));
}

// ── matching ───────────────────────────────────────────────────────────

/** Strongest first: a creditor ID or mandate reference names the mandate, an IBAN the payee. */
export type MatchVia = 'creditor_id' | 'mandate_reference' | 'iban' | 'name' | 'text';

export interface ContractCandidate {
    txId: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    via: MatchVia;
    /** Within amount ± tolerance (always true when the contract names no amount). */
    inAmountWindow: boolean;
    /** Already linked to this contract. */
    linked: boolean;
}

const compact = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toUpperCase();

function inWindow(c: ContractRecord, amount: number): boolean {
    if (c.amount == null) return true;
    return Math.abs(Math.abs(amount) - c.amount) <= (c.amountTolerance ?? 0) + CENT;
}

/** How a booking matches the contract, ignoring the amount and the sign; undefined = not at all. */
export function matchVia(c: ContractRecord, t: ContractBooking): MatchVia | undefined {
    const text = compact(`${t.purpose ?? ''}${t.reference ?? ''}`);
    if (c.creditorId && text.includes(compact(c.creditorId))) return 'creditor_id';
    if (c.mandateReference && text.includes(compact(c.mandateReference))) return 'mandate_reference';
    if (c.counterpartyIban && compact(t.counterpartyIban) === compact(c.counterpartyIban)) return 'iban';
    if (c.counterparty && gleichePartei(c.counterparty, t.counterparty)) return 'name';
    if (c.matchText) {
        const hay = `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''}`.toLowerCase();
        if (hay.includes(c.matchText.toLowerCase())) return 'text';
    }
    return undefined;
}

function onAccount(c: ContractRecord, t: ContractBooking): boolean {
    return !c.accountKey || t.accountKey === c.accountKey;
}

/**
 * The debits that may belong to the contract: on its account, not rejected, matched by a key. A match
 * by text alone must also hit the amount window; a strong key or the name also proposes a booking
 * with a changed amount. Linked bookings are always included. Linking stays the owner's decision.
 */
export function contractCandidates(
    c: ContractRecord,
    bookings: readonly ContractBooking[],
    decisions: readonly ContractTransactionRecord[],
): ContractCandidate[] {
    const status = new Map(decisions.filter((d) => d.contractId === c.id).map((d) => [d.txId, d.status]));
    const out: ContractCandidate[] = [];
    for (const t of bookings) {
        if (t.amount >= 0 || !onAccount(c, t)) continue;
        const s = status.get(t.id);
        if (s === 'rejected') continue;
        const via = matchVia(c, t);
        const win = inWindow(c, t.amount);
        if (s !== 'linked' && (!via || (via === 'text' && !win))) continue;
        out.push({
            txId: t.id,
            bookingDate: t.bookingDate,
            amount: t.amount,
            counterparty: t.counterparty,
            via: via ?? 'name',
            inAmountWindow: win,
            linked: s === 'linked',
        });
    }
    return out.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.txId.localeCompare(b.txId));
}

// ── findings ───────────────────────────────────────────────────────────

export type ContractFinding =
    | { kind: 'missing'; expectedDate: string; expectedAmount: number | null }
    | { kind: 'returned'; txId: string; date: string; amount: number; originalTxId: string }
    | { kind: 'changed'; txId: string; date: string; amount: number; expectedAmount: number };

/** The payment dates the contract expects up to `asOf`: start stepped by the cycle, until its end. */
export function expectedDates(c: ContractRecord, asOf: string): string[] {
    if (!c.startDate || !c.cycle) return [];
    const step = ABSTAND_MONATE[c.cycle];
    const until = c.endDate && c.endDate < asOf ? c.endDate : asOf;
    const out: string[] = [];
    for (let k = 0; ; k++) {
        const d = plusMonate(c.startDate, k * step);
        if (d > until) break;
        out.push(d);
    }
    return out;
}

/**
 * What is wrong with the contract's payments, measured against `asOf` — the newest booking of the
 * account, not today, so a lagging import does not report every recent date as missing:
 * - `missing`: an expected date more than the tolerance before `asOf` without a payment near it;
 * - `returned`: a credit matching the contract with the amount of one of its debits, within
 *   {@link RUECKLASTSCHRIFT_FENSTER_TAGE} days after it (a Rücklastschrift);
 * - `changed`: a payment outside the amount window.
 * Payments are the linked bookings plus the open candidates. Computed, never stored.
 */
export function contractFindings(
    c: ContractRecord,
    bookings: readonly ContractBooking[],
    decisions: readonly ContractTransactionRecord[],
    asOf: string,
): ContractFinding[] {
    const payments = contractCandidates(c, bookings, decisions);
    const out: ContractFinding[] = [];

    const returnedOriginals = new Set<string>();
    const rejected = new Set(
        decisions.filter((d) => d.contractId === c.id && d.status === 'rejected').map((d) => d.txId),
    );
    for (const t of bookings) {
        if (t.amount <= 0 || !onAccount(c, t) || rejected.has(t.id) || !matchVia(c, t)) continue;
        // The nearest earlier debit of the same amount: a return follows its debit within days.
        const original = payments
            .filter((p) => {
                const age = dayDiff(t.bookingDate, p.bookingDate);
                return (
                    !returnedOriginals.has(p.txId) &&
                    Math.abs(Math.abs(p.amount) - t.amount) <= CENT &&
                    age != null &&
                    age >= 0 &&
                    age <= RUECKLASTSCHRIFT_FENSTER_TAGE
                );
            })
            .at(-1);
        if (!original) continue;
        returnedOriginals.add(original.txId);
        out.push({ kind: 'returned', txId: t.id, date: t.bookingDate, amount: t.amount, originalTxId: original.txId });
    }

    const used = new Set<string>();
    for (const d of expectedDates(c, asOf)) {
        if ((dayDiff(asOf, d) ?? 0) <= SERIE_TOLERANZ_TAGE) continue;
        const hit = payments.find(
            (p) => !used.has(p.txId) && Math.abs(dayDiff(p.bookingDate, d) ?? Infinity) <= SERIE_TOLERANZ_TAGE,
        );
        if (hit) used.add(hit.txId);
        else out.push({ kind: 'missing', expectedDate: d, expectedAmount: c.amount });
    }

    if (c.amount != null) {
        for (const p of payments) {
            if (p.inAmountWindow) continue;
            out.push({
                kind: 'changed',
                txId: p.txId,
                date: p.bookingDate,
                amount: p.amount,
                expectedAmount: c.amount,
            });
        }
    }

    const dateOf = (f: ContractFinding) => (f.kind === 'missing' ? f.expectedDate : f.date);
    return out.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

/** Monthly cost of a contract (EUR, positive), the figure a list sums up. */
export function monthlyAmount(c: Pick<ContractRecord, 'amount' | 'cycle'>): number | null {
    if (c.amount == null || !c.cycle) return null;
    return Math.round((c.amount / ABSTAND_MONATE[c.cycle]) * 100) / 100;
}
