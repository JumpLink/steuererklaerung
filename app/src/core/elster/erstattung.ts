/**
 * „Erstattungen verknüpfen" (Idee 9 in docs/ideen-nutzerfuehrung.md): which earlier debit an incoming
 * refund belongs to, and what the refund inherits once the owner says „Ja".
 *
 * A candidate is an earlier debit of the same entity to the same party (`gleichePartei`, as in the
 * Geld-Prüfungen) within {@link ERSTATTUNG_FENSTER_TAGE}, classified as an expense, with at least the
 * refund's amount still unrefunded — several refunds may point at one debit, but never more than it
 * paid. Exact amounts rank first, then a shared invoice/order number in the purpose, then the most
 * recent debit.
 *
 * The tax side — a linked refund reduces the original's category and its Vorsteuer in the refund's own
 * year and period — lives in the aggregate (`EuerErstattung` in euer-transactions.ts); the reasoning
 * and sources are in docs/references/tax-sources.md, „Erstattungen".
 *
 * Pure: classified bookings and stored decisions in, candidates out.
 */

import type { ClassSource, MatchedRule } from './euer-classify.ts';
import type { EuerKind } from './euer-aggregate.ts';
import { gleichePartei } from './serie.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';
import { round2 } from '../lib/money.ts';
import { hauptTeil } from './splitbuchung.ts';

/** How far back a refund looks for its debit — an app threshold, not a legal number
 *  (docs/references/tax-sources.md, „Geld-Prüfungen"). A year covers a refunded annual fee. */
export const ERSTATTUNG_FENSTER_TAGE = 365;

/** The subset of an EÜR detail row the matching needs. */
export interface ErstattungBuchung {
    id: string;
    bookingDate: string;
    /** Signed, EUR: a refund is positive, its original negative. */
    amount: number;
    counterparty?: string;
    purpose?: string;
    reference?: string;
    kind: EuerKind;
    source: ClassSource;
    category: string;
    /** Signed contributions as in the aggregate (a normal expense is positive). */
    net: number;
    vat: number;
    matchedRule?: MatchedRule;
    documentId?: number;
    /** The parts of a split original (Idee 13): a refund then belongs to its largest business part. */
    aufteilung?: Array<{ category: string; kind: EuerKind; betrag: number; vatRate: number; betrieblich: boolean }>;
}

/**
 * What of an original a refund can refer to: the whole booking, or — when it is split — its largest
 * business part (a refund of private items is no business matter; docs/references/tax-sources.md,
 * „Splitbuchung").
 */
function erstattbar(o: ErstattungBuchung): number {
    return o.aufteilung ? hauptTeil(o.aufteilung).betrag : Math.abs(o.amount);
}

/** A stored decision, with the refund's amount (the refund may lie outside the loaded years). */
export interface ErstattungEntscheidung {
    refundTxId: string;
    originalTxId: string;
    status: 'linked' | 'rejected';
    /** |amount| of the refund booking; needed for the rest an original can still take. */
    betrag?: number;
}

export interface ErstattungKandidat {
    original: ErstattungBuchung;
    /** The refund equals what is still open on the original. */
    exakt: boolean;
    /** Purpose or reference share an invoice/order number or a long word. */
    zweckTreffer: boolean;
    /** What the original can still take, before this refund. */
    offen: number;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Whether a booking is an incoming payment the question „Gehört das zu einer Zahlung?" applies to.
 * Not: a booking with a receipt, an Umbuchung or an earlier link (the owner already said what it is),
 * a confirmed double payment (Idee 5), neutral money (own transfers, private, tax), and income a rule
 * recognised by its payer (a customer named in `erloes_gegenseiten`, say) — that is revenue. A credit
 * only an Auffangregel guessed, a credit a supplier rule booked as expense, and an unclassified one
 * stay in.
 */
export function istErstattungsEingang(b: ErstattungBuchung): boolean {
    if (b.amount <= 0) return false;
    if (b.source === 'document' || b.source === 'manual') return false;
    const art = b.matchedRule?.art;
    if (art === 'doppelzahlung' || art === 'erstattung' || art === 'beleg') return false;
    if (b.kind === 'neutral') return false;
    if (b.kind === 'income' && b.source === 'rule' && !b.matchedRule?.auffang) return false;
    return true;
}

/** Whether a booking can be the original of a refund: a debit booked as an expense. */
export function istUrsprung(b: ErstattungBuchung): boolean {
    return b.amount < 0 && b.kind === 'expense' && b.source !== 'unclassified';
}

/** Invoice/order numbers (a token with a digit, ≥ 4 chars) and long words (≥ 6 letters) of a text. */
function merkmale(b: Pick<ErstattungBuchung, 'purpose' | 'reference'>): Set<string> {
    const text = `${b.purpose ?? ''} ${b.reference ?? ''}`.toLowerCase();
    const out = new Set<string>();
    for (const t of text.split(/[^a-z0-9äöüß-]+/)) {
        const tok = t.replace(/^-+|-+$/g, '');
        if ((/\d/.test(tok) && tok.length >= 4) || (/^[a-zäöüß]+$/.test(tok) && tok.length >= 6)) out.add(tok);
    }
    return out;
}

function zweckUeberlappt(a: ErstattungBuchung, b: ErstattungBuchung): boolean {
    const x = merkmale(a);
    for (const t of merkmale(b)) if (x.has(t)) return true;
    return false;
}

/** Σ of the refunds already linked to each original, without `ohneRefund` (the one being decided). */
export function bereitsErstattet(
    entscheidungen: readonly ErstattungEntscheidung[],
    ohneRefund?: string,
): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of entscheidungen) {
        if (e.status !== 'linked' || e.refundTxId === ohneRefund) continue;
        out.set(e.originalTxId, round2((out.get(e.originalTxId) ?? 0) + Math.abs(e.betrag ?? 0)));
    }
    return out;
}

/**
 * The ranked candidates for one refund. Rejected pairs are left out; `fensterTage` defaults to
 * {@link ERSTATTUNG_FENSTER_TAGE}. An empty list for a booking that is no refund candidate at all.
 */
export function erstattungKandidaten(
    refund: ErstattungBuchung,
    buchungen: readonly ErstattungBuchung[],
    entscheidungen: readonly ErstattungEntscheidung[],
    opts: { fensterTage?: number } = {},
): ErstattungKandidat[] {
    if (!istErstattungsEingang(refund)) return [];
    const fenster = opts.fensterTage ?? ERSTATTUNG_FENSTER_TAGE;
    const abgelehnt = new Set(
        entscheidungen.filter((e) => e.refundTxId === refund.id && e.status === 'rejected').map((e) => e.originalTxId),
    );
    const erstattet = bereitsErstattet(entscheidungen, refund.id);
    const betrag = cents(refund.amount);
    const out: ErstattungKandidat[] = [];
    for (const o of buchungen) {
        if (o.id === refund.id || !istUrsprung(o) || abgelehnt.has(o.id)) continue;
        const tage = dayDiff(refund.bookingDate, o.bookingDate);
        if (tage == null || tage < 0 || tage > fenster) continue;
        if (!gleichePartei(o.counterparty, refund.counterparty)) continue;
        const offen = round2(erstattbar(o) - (erstattet.get(o.id) ?? 0));
        if (cents(offen) < betrag) continue;
        out.push({ original: o, exakt: cents(offen) === betrag, zweckTreffer: zweckUeberlappt(refund, o), offen });
    }
    return out.sort(
        (a, b) =>
            Number(b.exakt) - Number(a.exakt) ||
            Number(b.zweckTreffer) - Number(a.zweckTreffer) ||
            (a.original.bookingDate < b.original.bookingDate
                ? 1
                : a.original.bookingDate > b.original.bookingDate
                  ? -1
                  : 0) ||
            a.offen - b.offen,
    );
}

/** The VAT rate a refund inherits: the original's VAT over its net, snapped to 0/7/19 % when that close. */
export function geerbterSteuersatz(original: Pick<ErstattungBuchung, 'net' | 'vat'>): number {
    const net = Math.abs(original.net);
    const vat = Math.abs(original.vat);
    if (net < 0.005 || vat < 0.005) return 0;
    const rate = vat / net;
    for (const known of [0.07, 0.19]) if (Math.abs(rate - known) < 0.005) return known;
    return Math.round(rate * 10000) / 10000;
}

/** What a refund inherits from its original at „Ja": category, VAT rate and the Vorsteuer receipt. */
export function erbeVonUrsprung(original: ErstattungBuchung): {
    category: string;
    vatRate: number;
    originalDocumentId: number | null;
} {
    if (original.aufteilung) {
        const teil = hauptTeil(original.aufteilung);
        return {
            category: teil.category,
            vatRate: teil.vatRate,
            originalDocumentId: original.documentId ?? null,
        };
    }
    return {
        category: original.category,
        vatRate: geerbterSteuersatz(original),
        originalDocumentId: original.source === 'document' ? (original.documentId ?? null) : null,
    };
}

const deDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** How an original reads after „via Erstattung zu …": „Buchung vom 10.03.2026 (Büromöbel Kranich GmbH)". */
export function ursprungLabel(original: Pick<ErstattungBuchung, 'bookingDate' | 'counterparty'>): string {
    const who = original.counterparty?.trim();
    return `Buchung vom ${deDate(original.bookingDate)}${who ? ` (${who})` : ''}`;
}

/** One incoming payment with its candidates — a row of „N Erstattungen zuordnen". */
export interface OffeneErstattung<T extends ErstattungBuchung = ErstattungBuchung> {
    buchung: T;
    kandidaten: Array<ErstattungKandidat & { original: T }>;
}

/**
 * Every incoming payment of `year` that has at least one candidate and no link yet, newest first.
 * `buchungen` should cover the window before the year too (the previous year's debits).
 */
export function offeneErstattungen<T extends ErstattungBuchung>(
    buchungen: readonly T[],
    entscheidungen: readonly ErstattungEntscheidung[],
    year: number,
    opts: { fensterTage?: number } = {},
): Array<OffeneErstattung<T>> {
    const verknuepft = new Set(entscheidungen.filter((e) => e.status === 'linked').map((e) => e.refundTxId));
    const prefix = `${year}-`;
    const out: Array<OffeneErstattung<T>> = [];
    for (const b of buchungen) {
        if (!b.bookingDate.startsWith(prefix) || verknuepft.has(b.id)) continue;
        const kandidaten = erstattungKandidaten(b, buchungen, entscheidungen, opts) as Array<
            ErstattungKandidat & { original: T }
        >;
        if (kandidaten.length > 0) out.push({ buchung: b, kandidaten });
    }
    return out.sort((a, b) => (a.buchung.bookingDate < b.buchung.bookingDate ? 1 : -1));
}

/** „N Erstattungen zuordnen" — singular-aware, for the Übersicht task. */
export function erstattungenTitel(n: number): string {
    return n === 1 ? '1 Erstattung zuordnen' : `${n} Erstattungen zuordnen`;
}
