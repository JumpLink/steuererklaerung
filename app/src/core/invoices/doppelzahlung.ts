/**
 * Doppelzahlung detector — finds credits that look like a customer paid an outgoing invoice twice
 * or paid too much. The extra money belongs to the customer (a refund liability, not revenue), so
 * the owner has to hear about it before the EÜR is filed.
 *
 * PURE on purpose: invoices and credit transactions come in, suspicions go out — no store, no
 * config, no network. The actions layer loads the data and the owner's earlier decisions.
 * Amounts are EUR as plain numbers (like the store); comparisons run on integer cents.
 */

import { dayDiff, referenceMatches } from '../lib/transactions/reconcile.ts';
import { normalizeInvoiceStatus } from './status.ts';

/** The slice of an outgoing invoice the detector needs. */
export interface DoppelzahlungInvoice {
    id: string;
    number: string | null;
    customer: string | null;
    gross: number;
    issueDate: string | null;
    /** The transaction that settled it, when the invoice was marked paid with one. */
    paidTxId: string | null;
    /** Raw back-end status (normalised here). */
    status: string;
}

/** A credit (money in) from the entity's accounts. */
export interface DoppelzahlungCredit {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    reference?: string;
}

export type DoppelzahlungArt = 'zweiter_eingang' | 'ueberzahlung';

export interface DoppelzahlungVerdacht {
    /** Stable id: `<art>:<rechnungId>`. */
    key: string;
    art: DoppelzahlungArt;
    rechnungId: string;
    rechnungNummer: string;
    kunde?: string;
    /** The suspicious credits (never the tx that settled the invoice). */
    txIds: string[];
    /** Amount received beyond the invoice's gross (EUR, 2 decimals). */
    zuViel: number;
    /** True when a listed credit is not wholly surplus (e.g. 120 received on a 100 invoice). */
    teilweise: boolean;
}

export interface DoppelzahlungOptions {
    /** Tx ids the owner already decided (doppelzahlungen + zahlungen_geprueft) — never flagged. */
    ignoreTxIds?: ReadonlySet<string>;
    /** Max days between the paying tx and a same-amount repeat from the same payer (default 90). */
    maxDayGap?: number;
}

const cents = (n: number): number => Math.round(n * 100);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const TOLERANCE_CENTS = 1;

/** Whether a credit is entirely surplus — only then can it be neutralised without a split booking. */
export function istGanzZuViel(amount: number, zuViel: number): boolean {
    return cents(amount) <= cents(zuViel) + TOLERANCE_CENTS;
}

function norm(name: string | null | undefined): string {
    return (name ?? '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
}

function sameParty(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = norm(a);
    const y = norm(b);
    return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/** Detect double or excess payments. Returns at most one suspicion per (art, invoice). */
export function detectDoppelzahlungen(
    invoices: DoppelzahlungInvoice[],
    credits: DoppelzahlungCredit[],
    opts: DoppelzahlungOptions = {},
): DoppelzahlungVerdacht[] {
    const ignore = opts.ignoreTxIds ?? new Set<string>();
    const maxGap = opts.maxDayGap ?? 90;

    const live = invoices.filter((inv) => {
        const st = normalizeInvoiceStatus(inv.status);
        return (st === 'open' || st === 'paid') && inv.gross > 0 && !!inv.number;
    });
    const settlingTxIds = new Set(live.map((i) => i.paidTxId).filter((x): x is string => !!x));
    const creditById = new Map(credits.map((c) => [c.id, c]));
    const pool = credits
        .filter((c) => c.amount > 0 && !ignore.has(c.id) && !settlingTxIds.has(c.id))
        .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));

    // Credits per invoice: by number in the purpose. A credit naming several invoices is a
    // combined payment — ambiguous, so left alone.
    const byInvoice = new Map<string, DoppelzahlungCredit[]>();
    const assigned = new Set<string>();
    for (const c of pool) {
        const hits = live.filter((inv) => referenceMatches(inv.number ?? undefined, c));
        if (hits.length === 0) continue;
        assigned.add(c.id);
        if (hits.length > 1) continue;
        const list = byInvoice.get(hits[0].id) ?? [];
        list.push(c);
        byInvoice.set(hits[0].id, list);
    }

    const verdicts = new Map<string, DoppelzahlungVerdacht>();
    const add = (inv: DoppelzahlungInvoice, art: DoppelzahlungArt, txs: DoppelzahlungCredit[], zuViel: number) => {
        const key = `${art}:${inv.id}`;
        const cur = verdicts.get(key);
        if (cur) {
            cur.txIds.push(...txs.map((t) => t.id));
            cur.zuViel = round2(cur.zuViel + zuViel);
            return;
        }
        verdicts.set(key, {
            key,
            art,
            rechnungId: inv.id,
            rechnungNummer: inv.number ?? '',
            ...(inv.customer ? { kunde: inv.customer } : {}),
            txIds: txs.map((t) => t.id),
            zuViel: round2(zuViel),
            teilweise: false,
        });
    };

    for (const inv of live) {
        const refs = byInvoice.get(inv.id);
        if (!refs?.length) continue;
        const paying = inv.paidTxId ? creditById.get(inv.paidTxId) : undefined;
        const refSum = refs.reduce((s, c) => s + cents(c.amount), 0);
        if (inv.paidTxId) {
            // Already settled by another tx: whatever else quotes the number is a second receipt —
            // unless the settling tx was only a part and the rest completes the gross.
            const base = paying ? cents(paying.amount) : cents(inv.gross);
            const excess = base + refSum - cents(inv.gross);
            if (excess > TOLERANCE_CENTS) add(inv, 'zweiter_eingang', refs, excess / 100);
        } else {
            const excess = refSum - cents(inv.gross);
            if (excess > TOLERANCE_CENTS) add(inv, 'ueberzahlung', refs, excess / 100);
        }
    }

    // Repeat from the same payer for the same amount, quoting no invoice number at all.
    for (const c of pool) {
        if (assigned.has(c.id)) continue;
        const open = live.filter((i) => normalizeInvoiceStatus(i.status) === 'open');
        const hasOpenTwin = open.some(
            (i) =>
                Math.abs(cents(i.gross) - cents(c.amount)) <= TOLERANCE_CENTS &&
                (!i.customer || sameParty(i.customer, c.counterparty)),
        );
        if (hasOpenTwin) continue;
        let best: { inv: DoppelzahlungInvoice; gap: number } | undefined;
        for (const inv of live) {
            const paying = inv.paidTxId ? creditById.get(inv.paidTxId) : undefined;
            if (!paying || !sameParty(paying.counterparty, c.counterparty)) continue;
            if (Math.abs(cents(paying.amount) - cents(c.amount)) > TOLERANCE_CENTS) continue;
            if (c.bookingDate <= paying.bookingDate) continue;
            const gap = dayDiff(c.bookingDate, paying.bookingDate);
            if (gap == null || gap > maxGap) continue;
            if (!best || gap < best.gap) best = { inv, gap };
        }
        if (best) {
            assigned.add(c.id);
            add(best.inv, 'zweiter_eingang', [c], c.amount);
        }
    }

    const amountById = new Map(credits.map((c) => [c.id, c.amount]));
    return [...verdicts.values()].map((v) => ({
        ...v,
        teilweise: v.txIds.some((id) => !istGanzZuViel(amountById.get(id) ?? 0, v.zuViel)),
    }));
}
