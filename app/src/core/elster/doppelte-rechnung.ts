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
import { belegZeile, capBetroffen, HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import { findeSerien, parteiSchluessel } from './serie.ts';
import { istSerienPaar, type LaufendeKosten } from './laufende-kosten.ts';

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
                title: 'Doppelte Rechnung: nicht prüfbar',
                text: `Für ${i.year} liegt keine Eingangsrechnung mit Absender vor.`,
                status: 'nicht_pruefbar',
                weil:
                    eingang.length === 0
                        ? 'im Belegsystem für dieses Jahr keine Eingangsrechnung liegt'
                        : 'keiner Eingangsrechnung ein Absender zugeordnet ist',
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
                    grund = 'gleiche Rechnungsnummer';
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
                    grund = `gleicher Betrag binnen ${DOPPELTE_RECHNUNG_FENSTER_TAGE} Tagen`;
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
                title: 'Doppelte Rechnung: keine gefunden',
                text: `${mitAbsender.length} Eingangsrechnung(en) ${i.year} verglichen.`,
                status: 'ohne_befund',
                geprueft:
                    `gleicher Absender mit gleicher Rechnungsnummer oder mit gleichem Bruttobetrag binnen ${DOPPELTE_RECHNUNG_FENSTER_TAGE} Tagen; ` +
                    `ausgenommen: Serien wie Abos (mindestens drei im festen Abstand: ${serie} Paar(e); ` +
                    `bestätigte laufende Kosten: ${laufend} Paar(e))` +
                    (ohneAbsender ? `; ohne Absender nicht verglichen: ${ohneAbsender}` : ''),
            },
        ];
    }

    const out: Hinweis[] = [];
    for (const docs of groups.values()) {
        docs.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id));
        const name = docs[0].correspondent!.trim();
        const grund = [...new Set(docs.flatMap((d) => [...gruende.get(d.id)!]))].join(', ');
        const betrag = docs[0].gross != null ? ` über ${fmt(docs[0].gross)} €` : '';
        out.push({
            key: `doppelte-rechnung:${docs[0].id}`,
            level: 'warnung',
            title: `Doppelte Rechnung von ${name}?`,
            text:
                `${docs.length} Belege von ${name}${betrag} betreffen vermutlich dieselbe Forderung (${grund}). ` +
                'Zu klären, bevor beide bezahlt werden: ist einer davon eine Kopie, eine Mahnung oder eine Korrektur?',
            status: 'befund',
            ...capBetroffen(docs.map((d) => ({ art: 'beleg' as const, id: d.id, zeile: belegZeile(d) }))),
            handlungen: [
                { id: 'beleg', label: 'Beleg öffnen', target: { art: 'dialog', dialog: 'beleg', ref: docs[0].id } },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(docs.map((d) => d.id)),
        });
    }
    return out;
}
