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
import { _, fmt } from '../lib/i18n.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';

/** How long after a debit a credit of the same amount still counts as its return (SEPA: 8 weeks). */
export const RUECKLASTSCHRIFT_FENSTER_TAGE = 60;

/** An import older than this many days (against today) is reported as "no data since" once. */
export const DATEN_VERALTET_TAGE = 35;

/** A reminder this long before the latest notice date: calendar months or plain days. */
export type ReminderOffset = { months: number } | { days: number };

/** Staggered notice reminders: 3 months, 2 months and 14 days before the latest notice date. */
export const DEFAULT_NOTICE_REMINDERS: readonly ReminderOffset[] = [{ months: 3 }, { months: 2 }, { days: 14 }];

/**
 * A price increase may open a special right to cancel; the owner checks the notice and its deadline.
 * A FUNCTION, not a constant: a module-level constant is evaluated before a frontend can register
 * its translator, which would freeze the English text into the German build.
 */
export function priceIncreaseHint(): string {
    return _('Price increase: may open a special right to cancel — check the provider’s notice and its deadline.');
}

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
        return {
            kind: 'none',
            reason: c.endDate ? fmt(_('cancelled, ends {date}'), { date: c.endDate }) : _('cancelled'),
        };
    if (c.status === 'ended' || c.status === 'archived') return { kind: 'none', reason: _('ended') };
    if (!c.startDate) return { kind: 'none', reason: _('no start date') };
    if (c.noticeValue == null || !c.noticeUnit) return { kind: 'none', reason: _('no notice period') };

    const fixed = (termEnd: string): NoticeDeadline => {
        const latestNotice = minusNotice(termEnd, c);
        return { kind: 'fixed', termEnd, latestNotice, daysLeft: dayDiff(latestNotice, today) ?? 0 };
    };
    const anytime = (): NoticeDeadline => ({ kind: 'anytime', termEnd: plusNotice(today, c) });

    if (c.endDate && !c.autoRenewal) {
        return c.endDate >= today
            ? { kind: 'none', reason: fmt(_('ends {date} without notice'), { date: c.endDate }) }
            : { kind: 'none', reason: _('ended') };
    }
    if (!c.initialTermMonths) return anytime();

    let end = termEndFrom(c.startDate, c.initialTermMonths);
    if (minusNotice(end, c) >= today) return fixed(end);
    if (!c.autoRenewal)
        return end >= today
            ? { kind: 'none', reason: fmt(_('ends {date}, deadline passed'), { date: end }) }
            : { kind: 'none', reason: _('ended') };
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
 * Parses `3m,2m,14d` (months / days before the latest notice date) into reminder offsets. Throws on
 * anything else so a typo does not silently drop a reminder.
 */
export function parseReminderOffsets(spec: string): ReminderOffset[] {
    return spec
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const m = /^(\d+)([md])$/.exec(s);
            if (!m || Number(m[1]) <= 0)
                throw new Error(fmt(_("Invalid reminder '{spec}' — allowed: 3m (months), 14d (days)"), { spec: s }));
            return m[2] === 'm' ? { months: Number(m[1]) } : { days: Number(m[1]) };
        });
}

/**
 * Days before `latestNotice` for each reminder, largest first, without duplicates. Reminders that
 * already lie in the past (more than `daysLeft` days out) are dropped.
 */
export function noticeAlarmDays(
    latestNotice: string,
    daysLeft: number,
    reminders: readonly ReminderOffset[] = DEFAULT_NOTICE_REMINDERS,
): number[] {
    const days = reminders.map((r) =>
        'months' in r ? (dayDiff(latestNotice, minusMonths(latestNotice, r.months)) ?? 0) : r.days,
    );
    return [...new Set(days)].filter((d) => d > 0 && d <= Math.max(daysLeft, 0)).sort((a, b) => b - a);
}

/**
 * Calendar entries for the deadlines, as `buildFristenIcsEvents` does for tax deadlines. The uid holds
 * the contract and the date, so a re-export updates the entry and the next term gets a new one. One
 * entry carries one alarm per staggered reminder.
 */
export function buildContractIcsEvents(
    items: ReturnType<typeof upcomingDeadlines>,
    reminders: readonly ReminderOffset[] = DEFAULT_NOTICE_REMINDERS,
): IcsEvent[] {
    return items.map(({ contract, deadline }) => ({
        uid: `contract-${contract.id}-${deadline.latestNotice}`,
        date: deadline.latestNotice,
        summary: fmt(_('Notice deadline: {name}'), { name: contract.name }),
        description: [
            fmt(_('The notice must reach the provider today at the latest for the contract to end on {date}.'), {
                date: deadline.termEnd,
            }),
            contract.counterparty ? fmt(_('Provider: {name}'), { name: contract.counterparty }) : null,
            contract.contractNumber ? fmt(_('Contract number: {number}'), { number: contract.contractNumber }) : null,
        ]
            .filter(Boolean)
            .join('\n'),
        alarmsDaysBefore: noticeAlarmDays(deadline.latestNotice, deadline.daysLeft, reminders),
    }));
}

// ── matching ───────────────────────────────────────────────────────────

/**
 * Strongest first: a creditor ID, mandate reference or contract number names the contract itself, an
 * IBAN the payee.
 */
export type MatchVia = 'creditor_id' | 'mandate_reference' | 'contract_number' | 'iban' | 'name' | 'text';

/** These name the contract, so the booking belongs to it whichever account it was paid from. */
const STRONG_VIA: ReadonlySet<MatchVia> = new Set(['creditor_id', 'mandate_reference', 'contract_number']);

/** A contract number shorter than this is too likely to occur in an unrelated purpose text. */
const MIN_CONTRACT_NUMBER_LENGTH = 5;

export interface ContractCandidate {
    txId: string;
    bookingDate: string;
    amount: number;
    /** The account the booking was paid from — more than one means the mandate moved. */
    accountKey?: string;
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
    const number = compact(c.contractNumber);
    if (number.length >= MIN_CONTRACT_NUMBER_LENGTH && text.includes(number)) return 'contract_number';
    if (c.counterpartyIban && compact(t.counterpartyIban) === compact(c.counterpartyIban)) return 'iban';
    if (c.counterparty && gleichePartei(c.counterparty, t.counterparty)) return 'name';
    if (c.matchText) {
        const hay = `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''}`.toLowerCase();
        if (hay.includes(c.matchText.toLowerCase())) return 'text';
    }
    return undefined;
}

function onAccount(c: ContractRecord, t: ContractBooking, proven?: ReadonlySet<string>): boolean {
    return !c.accountKey || t.accountKey === c.accountKey || (t.accountKey != null && !!proven?.has(t.accountKey));
}

/**
 * The accounts on which the contract has proof of its own: a booking with a strong key or one the
 * owner linked. Older payments there may carry no purpose, so the weak keys are trusted on them too.
 */
export function provenAccounts(
    c: ContractRecord,
    bookings: readonly ContractBooking[],
    decisions: readonly ContractTransactionRecord[],
): Set<string> {
    const linked = new Set(decisions.filter((d) => d.contractId === c.id && d.status === 'linked').map((d) => d.txId));
    const out = new Set<string>();
    for (const t of bookings) {
        if (t.accountKey == null || t.amount >= 0) continue;
        const via = matchVia(c, t);
        if (linked.has(t.id) || (via && STRONG_VIA.has(via))) out.add(t.accountKey);
    }
    return out;
}

/**
 * How a booking belongs to the contract: a strong key (creditor ID, mandate reference, contract
 * number) holds on any account, so a debit that moved to another account stays with its contract; the
 * weak ones (IBAN, name, text) count on the contract's own account and on any `proven` account.
 */
export function contractMatch(
    c: ContractRecord,
    t: ContractBooking,
    proven?: ReadonlySet<string>,
): MatchVia | undefined {
    const via = matchVia(c, t);
    if (!via) return undefined;
    return STRONG_VIA.has(via) || onAccount(c, t, proven) ? via : undefined;
}

/** The accounts the candidates were paid from, oldest first — more than one means the mandate moved. */
export function paymentAccounts(
    candidates: readonly ContractCandidate[],
): { accountKey: string; payments: number; first: string; last: string }[] {
    const by = new Map<string, { accountKey: string; payments: number; first: string; last: string }>();
    for (const p of candidates) {
        if (!p.accountKey) continue;
        const a = by.get(p.accountKey);
        if (!a)
            by.set(p.accountKey, { accountKey: p.accountKey, payments: 1, first: p.bookingDate, last: p.bookingDate });
        else {
            a.payments++;
            if (p.bookingDate < a.first) a.first = p.bookingDate;
            if (p.bookingDate > a.last) a.last = p.bookingDate;
        }
    }
    return [...by.values()].sort((a, b) => a.first.localeCompare(b.first));
}

/**
 * The debits that may belong to the contract: not rejected, matched by a key — a strong key on any
 * account, the weaker ones on the contract's account and on accounts with proof (see
 * {@link provenAccounts}). A match by text alone must also hit the
 * amount window; a strong key or the name also proposes a booking with a changed amount. Linked
 * bookings are always included. Linking stays the owner's decision.
 */
export function contractCandidates(
    c: ContractRecord,
    bookings: readonly ContractBooking[],
    decisions: readonly ContractTransactionRecord[],
): ContractCandidate[] {
    const status = new Map(decisions.filter((d) => d.contractId === c.id).map((d) => [d.txId, d.status]));
    const proven = provenAccounts(c, bookings, decisions);
    const out: ContractCandidate[] = [];
    for (const t of bookings) {
        if (t.amount >= 0) continue;
        const s = status.get(t.id);
        if (s === 'rejected') continue;
        const via = contractMatch(c, t, proven);
        const win = inWindow(c, t.amount);
        if (s !== 'linked' && (!via || (via === 'text' && !win))) continue;
        out.push({
            txId: t.id,
            bookingDate: t.bookingDate,
            amount: t.amount,
            accountKey: t.accountKey,
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
    | {
          kind: 'changed';
          txId: string;
          date: string;
          amount: number;
          expectedAmount: number;
          direction: 'increase' | 'decrease';
          /** Set on an increase: it may open a special right to cancel. */
          hint?: string;
      }
    | {
          /** The newest import of the accounts involved is stale: reported once, not as missing months. */
          kind: 'no_data';
          since: string;
      };

/** First and last booking date per account: the span the bank data actually covers. */
function coverage(bookings: readonly ContractBooking[]): Map<string, { first: string; last: string }> {
    const by = new Map<string, { first: string; last: string }>();
    for (const t of bookings) {
        const key = t.accountKey ?? '';
        const s = by.get(key);
        if (!s) by.set(key, { first: t.bookingDate, last: t.bookingDate });
        else {
            if (t.bookingDate < s.first) s.first = t.bookingDate;
            if (t.bookingDate > s.last) s.last = t.bookingDate;
        }
    }
    return by;
}

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
 * - `missing`: an expected date without a payment near it, only within the span the imported bookings
 *   of the contract's account (and of any account its payments came from) cover — never before the
 *   first or after the last booking;
 * - `no_data`: with `today` given, the newest of those bookings is older than
 *   {@link DATEN_VERALTET_TAGE} days — reported once, instead of a finding per month;
 * - `returned`: a credit matching the contract with the amount of one of its debits, within
 *   {@link RUECKLASTSCHRIFT_FENSTER_TAGE} days after it (a Rücklastschrift);
 * - `changed`: a payment outside the amount window; an increase carries {@link priceIncreaseHint}.
 * Payments are the linked bookings plus the open candidates. Computed, never stored.
 */
export function contractFindings(
    c: ContractRecord,
    bookings: readonly ContractBooking[],
    decisions: readonly ContractTransactionRecord[],
    asOf: string,
    today?: string,
): ContractFinding[] {
    const payments = contractCandidates(c, bookings, decisions);
    const proven = provenAccounts(c, bookings, decisions);
    const out: ContractFinding[] = [];

    const spans = coverage(bookings);
    const involved = new Set(payments.map((p) => p.accountKey ?? ''));
    if (c.accountKey) involved.add(c.accountKey);
    else for (const key of spans.keys()) involved.add(key);
    const covering = [...involved].flatMap((key) => spans.get(key) ?? []);
    const covered = (d: string) =>
        covering.some(
            (s) =>
                (dayDiff(d, s.first) ?? -1) >= SERIE_TOLERANZ_TAGE && (dayDiff(s.last, d) ?? -1) > SERIE_TOLERANZ_TAGE,
        );
    const newest = covering.reduce<string | null>((max, s) => (max == null || s.last > max ? s.last : max), null);
    if (today && newest && (dayDiff(today, newest) ?? 0) > DATEN_VERALTET_TAGE)
        out.push({ kind: 'no_data', since: newest });

    const returnedOriginals = new Set<string>();
    const rejected = new Set(
        decisions.filter((d) => d.contractId === c.id && d.status === 'rejected').map((d) => d.txId),
    );
    for (const t of bookings) {
        if (t.amount <= 0 || rejected.has(t.id) || !contractMatch(c, t, proven)) continue;
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
        if ((dayDiff(asOf, d) ?? 0) <= SERIE_TOLERANZ_TAGE || !covered(d)) continue;
        const hit = payments.find(
            (p) => !used.has(p.txId) && Math.abs(dayDiff(p.bookingDate, d) ?? Infinity) <= SERIE_TOLERANZ_TAGE,
        );
        if (hit) used.add(hit.txId);
        else out.push({ kind: 'missing', expectedDate: d, expectedAmount: c.amount });
    }

    if (c.amount != null) {
        for (const p of payments) {
            if (p.inAmountWindow) continue;
            const increase = Math.abs(p.amount) > c.amount;
            out.push({
                kind: 'changed',
                txId: p.txId,
                date: p.bookingDate,
                amount: p.amount,
                expectedAmount: c.amount,
                direction: increase ? 'increase' : 'decrease',
                ...(increase ? { hint: priceIncreaseHint() } : {}),
            });
        }
    }

    const dateOf = (f: ContractFinding) =>
        f.kind === 'missing' ? f.expectedDate : f.kind === 'no_data' ? f.since : f.date;
    return out.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

/** Monthly cost of a contract (EUR, positive), the figure a list sums up. */
export function monthlyAmount(c: Pick<ContractRecord, 'amount' | 'cycle'>): number | null {
    if (c.amount == null || !c.cycle) return null;
    return Math.round((c.amount / ABSTAND_MONATE[c.cycle]) * 100) / 100;
}
