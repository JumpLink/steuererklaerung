/**
 * Display texts + the refund-candidate ranking for the Doppelzahlung surfaces. Pure, so the
 * desktop dialog, the Absenden warning and the tests share one wording. Plain strings only — the
 * counterparty is bank data, so a UI must escape it before it reaches a markup label.
 */

import { _, _n, fmt } from '../lib/i18n.ts';
import { fmtDe } from '../lib/money.ts';
import { deDate } from '../lib/format.ts';

/** Headline of one suspicion: "2 payments received" is not shown, the surplus is. */
export function verdachtTitel(v: { txIds: string[]; zuViel: number; teilweise: boolean }): string {
    const n = v.txIds.length;
    const titel = fmt(
        _n('{n} payment too many received — {amount} €', '{n} payments too many received — {amount} €', n),
        {
            n,
            amount: fmtDe(v.zuViel),
        },
    );
    return v.teilweise ? `${titel} ${_('(partly too much)')}` : titel;
}

/** One credit as a row: date · amount on top, the payer underneath (empty when unknown). */
export function zahlungZeile(t: { bookingDate: string; amount: number; counterparty?: string }): {
    title: string;
    sub: string;
} {
    return { title: `${deDate(t.bookingDate)} · ${fmtDe(t.amount)} €`, sub: t.counterparty ?? '' };
}

/** The warning lines before a filing; empty when nothing is open. */
export function abgabeWarnungen(counts: { verdacht: number; rueckzahlungOffen: number }): string[] {
    const out: string[] = [];
    if (counts.verdacht > 0)
        out.push(
            fmt(
                _n(
                    '{n} payment possibly received twice — settle before filing',
                    '{n} payments possibly received twice — settle before filing',
                    counts.verdacht,
                ),
                { n: counts.verdacht },
            ),
        );
    if (counts.rueckzahlungOffen > 0)
        out.push(
            fmt(
                _n(
                    '{n} double payment not refunded yet',
                    '{n} double payments not refunded yet',
                    counts.rueckzahlungOffen,
                ),
                { n: counts.rueckzahlungOffen },
            ),
        );
    return out;
}

export interface RueckzahlungKandidat {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    accountKey?: string;
}

/**
 * Debits that may be the refund: an amount equal to the surplus first (to the cent), then the rest
 * newest first. Credits and zero bookings never qualify; the list is capped for a picker.
 */
export function rankRueckzahlungKandidaten<T extends RueckzahlungKandidat>(
    txs: readonly T[],
    amount: number,
    limit = 30,
): T[] {
    const cents = (n: number) => Math.round(Math.abs(n) * 100);
    const want = cents(amount);
    return txs
        .filter((t) => t.amount < 0)
        .sort((a, b) => {
            const ma = cents(a.amount) === want ? 0 : 1;
            const mb = cents(b.amount) === want ? 0 : 1;
            return ma - mb || b.bookingDate.localeCompare(a.bookingDate);
        })
        .slice(0, limit);
}
