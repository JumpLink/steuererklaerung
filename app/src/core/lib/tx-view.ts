/**
 * View-layer enrichment for the Transaktionen list (display only — the EÜR figures are
 * untouched): resolve a friendly account label per row, pair the two legs of an internal
 * transfer (−X on one own account / +X on another) into one group, and attach the matched
 * PayPal source (merchant + item) to a PayPal-routed bank charge. Pure functions.
 */

import type { EuerTxDetailRow } from '../elster/euer-transactions.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { buildPaypalRefMap } from './transactions/paypal-enrich.ts';

/** SKR03 category the classifier assigns to an own-account transfer. */
const INTERNAL_TRANSFER = '1360 Interne Überweisung';

export interface TxViewExtras {
    /** Friendly account label, e.g. "Hauptkonto" (falls back to source + IBAN tail). */
    account: string;
    /** Set on both legs of a paired internal transfer. */
    transfer?: { groupId: string; partner: string; direction: 'out' | 'in' };
    /** The matched PayPal source for a PayPal-routed charge. */
    paypal?: { merchant: string; item: string };
    /** Raw bank fields (not used in the EÜR) — surfaced in the transaction detail view. */
    raw?: {
        source: string;
        valueDate?: string;
        currency?: string;
        counterpartyIban?: string;
        reference?: string;
        type?: string;
        iban?: string;
        qontoCategory?: string;
    };
}

/** Map an accountKey (`camt:DE…`, `qonto:…`) to a label; fall back to source + IBAN tail. */
export function accountLabel(accountKey: string, labels?: Record<string, string>): string {
    if (labels?.[accountKey]) return labels[accountKey];
    // Synthetic year-end rows (AfA, Privatanteil, §24) carry a non-account key.
    if (!accountKey.includes(':')) return accountKey === 'adjustment' ? 'Jahresabschluss' : accountKey;
    const [src, rest = ''] = accountKey.split(':');
    const tail = rest.replace(/[^0-9A-Za-z]/g, '').slice(-4);
    return tail ? `${src} …${tail}` : accountKey;
}

/** The PayPal reference embedded in a bank purpose (a 12–15 digit run), if any. */
function bankRef(purpose: string | undefined): string | undefined {
    return /(\d{12,15})/.exec(purpose ?? '')?.[1];
}

/**
 * Return copies of `rows` enriched with the account label, internal-transfer pairing, and
 * the matched PayPal source. Transfer legs are paired by booking date + absolute amount
 * across two different own accounts (greedy when several share a date+amount).
 */
export function enrichViewRows<T extends EuerTxDetailRow>(
    rows: T[],
    opts: {
        labels?: Record<string, string>;
        paypalTxs?: UnifiedTransaction[];
        rawById?: Map<string, UnifiedTransaction>;
    } = {},
): Array<T & TxViewExtras> {
    const out = rows.map((r): T & TxViewExtras => {
        const row: T & TxViewExtras = { ...r, account: accountLabel(r.accountKey, opts.labels) };
        const raw = opts.rawById?.get(r.id);
        if (raw)
            row.raw = {
                source: raw.source,
                valueDate: raw.valueDate,
                currency: raw.currency,
                counterpartyIban: raw.counterpartyIban,
                reference: raw.reference,
                type: raw.type,
                iban: raw.iban,
                qontoCategory: raw.category,
            };
        return row;
    });

    // Pair internal transfers: bucket by date+|amount|, then match an out-leg to an in-leg
    // on a different account.
    const byKey = new Map<string, Array<T & TxViewExtras>>();
    for (const r of out) {
        if (r.category !== INTERNAL_TRANSFER) continue;
        const key = `${r.bookingDate}|${Math.abs(r.amount).toFixed(2)}`;
        const bucket = byKey.get(key);
        if (bucket) bucket.push(r);
        else byKey.set(key, [r]);
    }
    let g = 0;
    for (const bucket of byKey.values()) {
        const outs = bucket.filter((r) => r.amount < 0);
        const ins = bucket.filter((r) => r.amount > 0);
        for (let i = 0; i < Math.min(outs.length, ins.length); i++) {
            const o = outs[i];
            const inn = ins[i];
            if (o.accountKey === inn.accountKey) continue;
            const groupId = `tf-${g++}`;
            o.transfer = { groupId, partner: inn.account, direction: 'out' };
            inn.transfer = { groupId, partner: o.account, direction: 'in' };
        }
    }

    // Attach the matched PayPal source (merchant + item) to PayPal-routed charges.
    if (opts.paypalTxs?.length) {
        const map = buildPaypalRefMap(opts.paypalTxs);
        for (const r of out) {
            const ref = bankRef(r.purpose);
            const pp = ref ? map.get(ref) : undefined;
            if (pp) r.paypal = { merchant: pp.counterparty ?? '', item: pp.purpose ?? '' };
        }
    }
    return out;
}
