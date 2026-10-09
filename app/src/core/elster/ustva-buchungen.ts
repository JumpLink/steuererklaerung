/**
 * USt-VA from the bookings — for an entity whose receipts live in the built-in DMS, where the
 * Paperless aggregate ({@link aggregateUstvaFromPaperlessWithDetails}) has nothing to read.
 *
 * The rows are the transaction-driven EÜR's (`euerReportByTransactions` with `detail`), so the period
 * figures are the same bookings, categories, linked refunds (Idee 9) and split parts (Idee 13) the
 * Anlage EÜR and the USt-Jahreserklärung are built from — the four quarters add up to the year's
 * vereinnahmte USt and Vorsteuer. Ist-Versteuerung: a row counts in the period its payment falls in.
 *
 * Not covered here: § 13b (the Kz 46/47/84/85/67 need the receipt's supplier country) and steuerfreie
 * Umsätze (no Kennzahl of their own in {@link UstvaAggregate}); both stay with the Paperless path.
 * Pure — the caller passes the rows.
 */

import { round2 } from '../lib/money.ts';
import { NEUTRAL_MIT_VORSTEUER } from './euer-aggregate.ts';
import { beitragsZeilen, type EuerTxDetailRow } from './euer-transactions.ts';
import type { UstvaAggregate } from './ustva-aggregate.ts';

/** The VAT rate of an income row, read from its own net and VAT. */
function satz(net: number, vat: number): number | undefined {
    if (Math.abs(net) < 0.005) return undefined;
    const rate = vat / net;
    return [0.19, 0.07].find((r) => Math.abs(r - rate) < 0.005);
}

/** The USt-VA aggregate of the EÜR rows booked from `von` to `bis` (both inclusive, YYYY-MM-DD). */
export function ustvaAusBuchungen(rows: readonly EuerTxDetailRow[], von: string, bis: string): UstvaAggregate {
    let net19 = 0;
    let net7 = 0;
    let vatOut = 0;
    let vatIn = 0;
    let einnahmen = 0;
    let ausgaben = 0;
    const imZeitraum = rows.filter(
        (r) => r.accountKey !== 'adjustment' && r.bookingDate >= von && r.bookingDate <= bis,
    );
    for (const r of beitragsZeilen(imZeitraum)) {
        if (r.kind === 'income') {
            const rate = satz(r.net, r.vat);
            if (rate === 0.19) net19 += r.net;
            else if (rate === 0.07) net7 += r.net;
            vatOut += r.vat;
            einnahmen++;
        } else if (r.kind === 'expense' || NEUTRAL_MIT_VORSTEUER.has(r.category)) {
            vatIn += r.vat;
            ausgaben++;
        }
    }
    return {
        net_19: round2(net19),
        net_7: round2(net7),
        vat_out: round2(vatOut),
        vat_in: round2(vatIn),
        outgoing_count: einnahmen,
        incoming_count: ausgaben,
    };
}
