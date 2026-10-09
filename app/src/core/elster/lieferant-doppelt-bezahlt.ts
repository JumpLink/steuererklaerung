/**
 * „Lieferant doppelt bezahlt" — the counterpart of the customer's Doppelzahlung (Idee 5): more money
 * left for one incoming invoice than it asks for (Idee 7 in docs/ideen-nutzerfuehrung.md).
 *
 * The payments of an invoice are the debits linked to its document plus the debits from the same
 * recipient that quote its invoice number (a debit quoting several invoices is a combined payment and
 * stays out). A finding when their sum exceeds the gross — two full payments, or one too large.
 *
 * Not a finding: partial payments and Anzahlung + Rest (sum ≤ gross), a later credit from the same
 * supplier over the surplus (the Erstattung already came), payments that all belong to one series
 * (`serie.ts` — a subscription quoting a contract number) or all to confirmed laufende Kosten (Idee 8,
 * `laufende-kosten.ts` — the owner said it is a subscription, even with a price change).
 *
 * The hint only points; it neutralises nothing. Vorsteuer is due once per invoice (§ 15 Abs. 1 Satz 1
 * Nr. 1 UStG — tied to the supply and the invoice, not to the payment). How the second debit itself
 * belongs in an EÜR is not settled by a primary source (see docs/references/tax-sources.md,
 * „Geld-Prüfungen"), so there is no booking action like Idee 5's „Ist eine Doppelzahlung".
 *
 * Pure — the caller passes the year's documents and the entity's bookings (all years).
 */

import { fmtDe as fmt } from '../lib/money.ts';
import { referenceMatches } from '../lib/transactions/reconcile.ts';
import type { RechnungsBeleg } from './doppelte-rechnung.ts';
import {
    belegZeile,
    buchungZeile,
    capBetroffen,
    HANDLUNG_IN_ORDNUNG,
    hinweisFingerprint,
    type Hinweis,
    type HinweisBetroffen,
} from './hinweise.ts';
import { findeSerien, gleichePartei } from './serie.ts';

export interface ZahlBuchung {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    reference?: string;
}

export interface LieferantDoppeltInput {
    year: number;
    belege: readonly RechnungsBeleg[];
    /** The entity's bookings, all years — a payment may fall into the next year, a refund later still. */
    buchungen: readonly ZahlBuchung[];
    /** Payment ids of the confirmed laufende Kosten (`laufendeKostenIds`). */
    laufendeKostenIds?: ReadonlySet<string>;
}

const cents = (n: number) => Math.round(n * 100);
const TOLERANZ_CENT = 1;

export function pruefeLieferantDoppeltBezahlt(i: LieferantDoppeltInput): Hinweis[] {
    const rechnungen = i.belege.filter((d) => d.direction === 'incoming' && d.gross != null && d.gross > 0);
    const debits = i.buchungen.filter((t) => t.amount < 0);
    const credits = i.buchungen.filter((t) => t.amount > 0);
    const serieVon = new Map<string, number>();
    findeSerien(
        debits.map((t) => ({ id: t.id, datum: t.bookingDate, betrag: t.amount, partei: t.counterparty ?? '' })),
    ).forEach((s, n) => s.ids.forEach((id) => serieVon.set(id, n)));

    // A debit quoting several of the invoices is a combined payment: ambiguous, left alone.
    const perDebit = new Map<string, RechnungsBeleg[]>();
    for (const d of rechnungen) {
        for (const t of debits) {
            if (referenceMatches(d.invoiceNumber ?? undefined, t) && gleichePartei(d.correspondent, t.counterparty)) {
                perDebit.set(t.id, [...(perDebit.get(t.id) ?? []), d]);
            }
        }
    }

    let geprueft = 0;
    let teil = 0;
    let erstattet = 0;
    let serie = 0;
    let laufend = 0;
    const out: Hinweis[] = [];
    for (const d of rechnungen) {
        const linked = new Set(d.linkedTxIds);
        const zahlungen = debits
            .filter((t) => linked.has(t.id) || (perDebit.get(t.id)?.length === 1 && perDebit.get(t.id)![0] === d))
            .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
        if (zahlungen.length === 0) continue;
        geprueft++;
        const summe = zahlungen.reduce((s, t) => s - cents(t.amount), 0);
        const zuViel = summe - cents(d.gross!);
        if (zuViel <= TOLERANZ_CENT) {
            if (zahlungen.length > 1) teil++;
            continue;
        }
        const s0 = serieVon.get(zahlungen[0].id);
        if (zahlungen.length > 1 && s0 != null && zahlungen.every((t) => serieVon.get(t.id) === s0)) {
            serie++;
            continue;
        }
        if (zahlungen.length > 1 && i.laufendeKostenIds && zahlungen.every((t) => i.laufendeKostenIds!.has(t.id))) {
            laufend++;
            continue;
        }
        const name = d.correspondent?.trim() || zahlungen[0].counterparty?.trim() || 'Lieferant';
        const erstattung = credits.find(
            (c) =>
                c.bookingDate >= zahlungen[0].bookingDate &&
                Math.abs(cents(c.amount) - zuViel) <= TOLERANZ_CENT &&
                gleichePartei(name, c.counterparty),
        );
        if (erstattung) {
            erstattet++;
            continue;
        }
        const nr = d.invoiceNumber ? `Rechnung ${d.invoiceNumber}` : 'Rechnung';
        const betroffen: HinweisBetroffen[] = [
            { art: 'beleg', id: d.id, zeile: belegZeile(d) },
            ...zahlungen.map((t) => ({ art: 'buchung' as const, id: t.id, zeile: buchungZeile(t) })),
        ];
        out.push({
            key: `lieferant-doppelt-bezahlt:${d.id}`,
            level: 'warnung',
            title: `Lieferant doppelt bezahlt? ${name}, ${nr}`,
            text:
                `Zur ${nr} über ${fmt(d.gross!)} € gingen ${zahlungen.length === 1 ? 'eine Zahlung' : `${zahlungen.length} Zahlungen`} ` +
                `über zusammen ${fmt(summe / 100)} € hinaus — vermutlich ${fmt(zuViel / 100)} € zu viel. Zu klären: beim Lieferanten ` +
                'die Erstattung anfordern oder mit der nächsten Rechnung verrechnen lassen. Vorsteuer steht je Rechnung nur einmal zu; ' +
                'die App rechnet die zweite Abbuchung nicht heraus.',
            ref: '§ 15 Abs. 1 UStG',
            status: 'befund',
            ...capBetroffen(betroffen),
            handlungen: [
                { id: 'rechnung', label: 'Rechnung öffnen', target: { art: 'dialog', dialog: 'beleg', ref: d.id } },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint([d.id, ...zahlungen.map((t) => t.id)]),
        });
    }
    if (out.length) return out;

    if (geprueft === 0) {
        return [
            {
                key: 'lieferant-doppelt-bezahlt',
                level: 'info',
                title: 'Lieferant doppelt bezahlt: nicht prüfbar',
                text: `${rechnungen.length} Eingangsrechnung(en) ${i.year} mit Betrag, aber keiner ist eine Zahlung zugeordnet.`,
                status: 'nicht_pruefbar',
                weil: 'keine Eingangsrechnung eine verknüpfte oder per Rechnungsnummer erkennbare Zahlung hat',
            },
        ];
    }
    return [
        {
            key: 'lieferant-doppelt-bezahlt',
            level: 'info',
            title: 'Lieferant doppelt bezahlt: nichts gefunden',
            text: `${geprueft} Eingangsrechnung(en) ${i.year} mit ihren Zahlungen verglichen.`,
            status: 'ohne_befund',
            geprueft:
                'Summe der verknüpften und per Rechnungsnummer erkannten Abbuchungen gegen den Bruttobetrag; ausgenommen: ' +
                `Teilzahlungen sowie Anzahlung + Rest (${teil}), später erstattet (${erstattet}), Serien wie Abos (${serie}), ` +
                `bestätigte laufende Kosten (${laufend})`,
        },
    ];
}
