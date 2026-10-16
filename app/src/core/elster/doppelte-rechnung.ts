/**
 * „Doppelte Rechnung" — two different incoming documents for the same claim (Idee 7 in
 * docs/ideen-nutzerfuehrung.md): the same sender with the same invoice number, or the same sender with
 * the same gross within {@link DOPPELTE_RECHNUNG_FENSTER_TAGE}. Paying both is the expensive mistake;
 * the hint comes before the payment.
 *
 * Not `paperless/find-duplicates.ts`: that one finds the same FILE twice in Paperless and merges +
 * trashes it. Here two documents may differ in every byte (a copy, a reminder, a corrected invoice)
 * and nothing is touched. Works on the DMS-neutral document shape, so the built-in DMS and Paperless
 * are checked alike.
 *
 * Not a finding: a series — at least {@link SERIE_MIN_TREFFER} documents of the sender with the same
 * amount at a fixed interval (`serie.ts`), i.e. a subscription; both documents of a pair must belong to
 * the same series. Nor two invoices one interval apart from a sender whose debits the owner confirmed
 * as laufende Kosten (Idee 8) — that catches a subscription before its third invoice. Credit notes and
 * documents without amount are not compared by amount; documents without sender cannot be compared at
 * all.
 *
 * Pure — the caller passes the year's documents.
 */

import { fmtDe as fmt } from '../lib/money.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';
import { belegZeile, capBetroffen, handlungInOrdnung, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import { findeSerien, parteiSchluessel } from './serie.ts';
import { istSerienPaar, type LaufendeKosten } from './laufende-kosten.ts';
import { _, _n, fmt as t } from '../lib/i18n.ts';

/**
 * Days within which two invoices of one sender over the same gross count as one claim. An app
 * threshold, not a legal number: long enough for a copy or a reminder sent as a new invoice, short
 * enough that a monthly subscription mostly falls out — the series rule catches the rest. Registered in
 * docs/references/tax-sources.md, „Geld-Prüfungen".
 */
export const DOPPELTE_RECHNUNG_FENSTER_TAGE = 30;

/** The slice of a DMS document (structurally `DmsDocument`) the money checks read. */
export interface RechnungsBeleg {
    id: string;
    direction: 'incoming' | 'outgoing' | null;
    correspondent: string | null;
    invoiceNumber: string | null;
    gross: number | null;
    /** Document date YYYY-MM-DD. */
    created: string | null;
    linkedTxIds: string[];
}

export interface DoppelteRechnungInput {
    year: number;
    belege: readonly RechnungsBeleg[];
    /** The entity's confirmed laufende Kosten. */
    laufendeKosten?: readonly LaufendeKosten[];
}

const nummer = (n: string | null | undefined) => (n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function pruefeDoppelteRechnungen(i: DoppelteRechnungInput): Hinweis[] {
    const eingang = i.belege.filter((d) => d.direction === 'incoming');
    const mitAbsender = eingang.filter((d) => parteiSchluessel(d.correspondent));
    const ohneAbsender = eingang.length - mitAbsender.length;
    if (mitAbsender.length === 0) {
        return [
            {
                key: 'doppelte-rechnung',
                level: 'info',
                title: _('Duplicate invoice: cannot be checked'),
                text: t(_('No incoming invoice with a sender on file for {year}.'), { year: i.year }),
                status: 'nicht_pruefbar',
                weil:
                    eingang.length === 0
                        ? _('the document system holds no incoming invoice for this year')
                        : _('no incoming invoice has a sender assigned'),
            },
        ];
    }

    const serieVon = new Map<string, number>();
    findeSerien(
        mitAbsender
            .filter((d) => d.created && d.gross != null && d.gross > 0)
            .map((d) => ({ id: d.id, datum: d.created!, betrag: d.gross!, partei: d.correspondent! })),
    ).forEach((s, n) => s.ids.forEach((id) => serieVon.set(id, n)));

    // Pairs per sender, joined into groups (a copy of a copy is one group of three).
    const gruppe = new Map<string, string>();
    const wurzel = (id: string): string => {
        let r = id;
        while (gruppe.get(r) && gruppe.get(r) !== r) r = gruppe.get(r)!;
        return r;
    };
    const gruende = new Map<string, Set<string>>();
    let serie = 0;
    let laufend = 0;
    const bySender = new Map<string, RechnungsBeleg[]>();
    for (const d of mitAbsender) {
        const k = parteiSchluessel(d.correspondent);
        bySender.set(k, [...(bySender.get(k) ?? []), d]);
    }
    for (const docs of bySender.values()) {
        for (let a = 0; a < docs.length; a++) {
            for (let b = a + 1; b < docs.length; b++) {
                const x = docs[a];
                const y = docs[b];
                let grund: string | null = null;
                if (nummer(x.invoiceNumber) && nummer(x.invoiceNumber) === nummer(y.invoiceNumber)) {
                    grund = _('same invoice number');
                } else if (
                    x.gross != null &&
                    y.gross != null &&
                    x.gross > 0 &&
                    Math.round(x.gross * 100) === Math.round(y.gross * 100) &&
                    Math.abs(dayDiff(x.created ?? undefined, y.created ?? undefined) ?? Infinity) <=
                        DOPPELTE_RECHNUNG_FENSTER_TAGE
                ) {
                    const sx = serieVon.get(x.id);
                    if (sx != null && sx === serieVon.get(y.id)) {
                        serie++;
                        continue;
                    }
                    if (
                        i.laufendeKosten?.length &&
                        istSerienPaar(i.laufendeKosten, x.correspondent, x.gross, x.created ?? '', y.created ?? '')
                    ) {
                        laufend++;
                        continue;
                    }
                    grund = t(_('same amount within {days} days'), { days: DOPPELTE_RECHNUNG_FENSTER_TAGE });
                }
                if (!grund) continue;
                const rx = wurzel(x.id);
                const ry = wurzel(y.id);
                gruppe.set(rx, rx);
                gruppe.set(ry, rx);
                gruende.set(x.id, (gruende.get(x.id) ?? new Set()).add(grund));
                gruende.set(y.id, (gruende.get(y.id) ?? new Set()).add(grund));
            }
        }
    }

    const groups = new Map<string, RechnungsBeleg[]>();
    for (const d of mitAbsender) {
        if (!gruende.has(d.id)) continue;
        const r = wurzel(d.id);
        groups.set(r, [...(groups.get(r) ?? []), d]);
    }

    if (groups.size === 0) {
        return [
            {
                key: 'doppelte-rechnung',
                level: 'info',
                title: _('Duplicate invoice: none found'),
                text: t(
                    _n(
                        '{n} incoming invoice from {year} compared.',
                        '{n} incoming invoices from {year} compared.',
                        mitAbsender.length,
                    ),
                    { n: mitAbsender.length, year: i.year },
                ),
                status: 'ohne_befund',
                geprueft:
                    t(
                        _(
                            'same sender with the same invoice number, or with the same gross amount within {days} days; excluded: series such as subscriptions (at least three at a fixed interval: {series} pair(s); confirmed recurring costs: {recurring} pair(s))',
                        ),
                        { days: DOPPELTE_RECHNUNG_FENSTER_TAGE, series: serie, recurring: laufend },
                    ) + (ohneAbsender ? t(_('; not compared without a sender: {n}'), { n: ohneAbsender }) : ''),
            },
        ];
    }

    const out: Hinweis[] = [];
    for (const docs of groups.values()) {
        docs.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id));
        const name = docs[0].correspondent!.trim();
        const grund = [...new Set(docs.flatMap((d) => [...gruende.get(d.id)!]))].join(', ');
        const betrag = docs[0].gross != null ? t(_(' for {amount} €'), { amount: fmt(docs[0].gross) }) : '';
        out.push({
            key: `doppelte-rechnung:${docs[0].id}`,
            level: 'warnung',
            title: t(_('Duplicate invoice from {name}?'), { name }),
            text:
                t(_('{n} documents from {name}{amount} probably concern the same claim ({reason}).'), {
                    n: docs.length,
                    name,
                    amount: betrag,
                    reason: grund,
                }) +
                ' ' +
                _('To clarify before both are paid: is one of them a copy, a reminder or a correction?'),
            status: 'befund',
            ...capBetroffen(docs.map((d) => ({ art: 'beleg' as const, id: d.id, zeile: belegZeile(d) }))),
            handlungen: [
                {
                    id: 'beleg',
                    label: _('Open the document'),
                    target: { art: 'dialog', dialog: 'beleg', ref: docs[0].id },
                },
                handlungInOrdnung(),
            ],
            fingerprint: hinweisFingerprint(docs.map((d) => d.id)),
        });
    }
    return out;
}
