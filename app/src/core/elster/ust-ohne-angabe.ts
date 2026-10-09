/**
 * „Buchungen ohne USt-Angabe" — a Prüfung vor der Abgabe (Idee 10 in docs/ideen-nutzerfuehrung.md):
 * expenses whose linked receipt names neither a VAT amount nor a net amount.
 *
 * The Vorsteuer that comes from receipts (the USt-VA, and the EÜR for receipt-classified bookings)
 * then misses whatever VAT those receipts contain — it is a lower bound, never too high. A receipt that
 * states 0 € VAT is an answer, not a gap. Bookings without any receipt are the Beleg-Lücke's matter,
 * unclassified ones the Unklassifiziert hint's; VAT-exempt categories (rent, insurance, fees) have no
 * Vorsteuer to miss; and a booking the §13b check already lists is left to that one.
 *
 * Pure — the caller passes the year's EÜR rows and documents.
 */

import { fmtDe as fmt, round2 } from '../lib/money.ts';
import type { EuerKind } from './euer-aggregate.ts';
import { impliedRate } from './euer-classify.ts';
import { buchungZeile, capBetroffen, HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis } from './hinweise.ts';

export interface OhneUstZeile {
    id: string;
    accountKey?: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    kind: EuerKind;
    category: string;
}

export interface OhneUstBeleg {
    id: string;
    direction: 'incoming' | 'outgoing' | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
    linkedTxIds: string[];
}

export interface OhneUstInput {
    year: number;
    zeilen: readonly OhneUstZeile[];
    belege: readonly OhneUstBeleg[];
    /** Bookings another check already reports (§ 13b-Kandidaten). */
    ausgenommen?: ReadonlySet<string>;
    /** Without Vorsteuerabzug there is no Vorsteuer to miss. */
    kleinunternehmer?: boolean;
}

const UNKLASSIFIZIERT = '(unklassifiziert)';

/** Whether a receipt says something about its VAT: an amount, or net and gross to derive it from. */
export function belegNenntUst(d: Pick<OhneUstBeleg, 'net' | 'gross' | 'vat'>): boolean {
    return d.vat != null || (d.net != null && d.gross != null);
}

export function pruefeBuchungenOhneUst(i: OhneUstInput): Hinweis[] {
    const basis = { key: 'ust-ohne-angabe', level: 'info' as const, ref: '§ 15 Abs. 1 Satz 1 Nr. 1 UStG' };
    if (i.kleinunternehmer) {
        return [
            {
                ...basis,
                title: 'Buchungen ohne USt-Angabe: entfällt',
                text: 'Als Kleinunternehmer ziehst du keine Vorsteuer ab — eine fehlende USt-Angabe am Beleg ändert nichts.',
                status: 'ohne_befund',
                geprueft: 'entfällt ohne Vorsteuerabzug (§ 15 Abs. 2 Satz 1 Nr. 1 UStG)',
            },
        ];
    }
    const belegeJeBuchung = new Map<string, OhneUstBeleg[]>();
    for (const d of i.belege) {
        if (d.direction === 'outgoing') continue;
        for (const id of d.linkedTxIds) belegeJeBuchung.set(id, [...(belegeJeBuchung.get(id) ?? []), d]);
    }
    let mitBeleg = 0;
    let ustFrei = 0;
    let anderswo = 0;
    const treffer: { r: OhneUstZeile; beleg: OhneUstBeleg }[] = [];
    for (const r of i.zeilen) {
        if (r.kind !== 'expense' || r.amount >= 0 || r.accountKey === 'adjustment' || r.category === UNKLASSIFIZIERT) {
            continue;
        }
        const belege = belegeJeBuchung.get(r.id);
        if (!belege?.length) continue;
        mitBeleg++;
        if (impliedRate(r.category, 'expense') === 0) {
            ustFrei++;
            continue;
        }
        if (belege.some(belegNenntUst)) continue;
        if (i.ausgenommen?.has(r.id)) {
            anderswo++;
            continue;
        }
        treffer.push({ r, beleg: belege[0] });
    }

    if (treffer.length === 0) {
        if (mitBeleg === 0) {
            return [
                {
                    ...basis,
                    title: 'Buchungen ohne USt-Angabe: nicht prüfbar',
                    text: `Keine Ausgabe ${i.year} hat einen verknüpften Beleg.`,
                    status: 'nicht_pruefbar',
                    weil: 'keine Ausgabe des Jahres mit einem Beleg verknüpft ist',
                },
            ];
        }
        return [
            {
                ...basis,
                title: 'Buchungen ohne USt-Angabe: keine',
                text: `${mitBeleg} Ausgabe(n) ${i.year} mit Beleg geprüft.`,
                status: 'ohne_befund',
                geprueft:
                    'jeder verknüpfte Beleg nennt USt-Betrag oder Netto und Brutto; ausgenommen: USt-freie Kategorien ' +
                    `(${ustFrei}), § 13b-Kandidaten (${anderswo})`,
            },
        ];
    }

    treffer.sort((a, b) => a.r.bookingDate.localeCompare(b.r.bookingDate) || a.r.id.localeCompare(b.r.id));
    const summe = round2(treffer.reduce((s, t) => s - t.r.amount, 0));
    return [
        {
            ...basis,
            level: 'tipp',
            title: `${treffer.length} Buchung(en) ohne USt-Angabe auf dem Beleg`,
            text:
                `Für ${treffer.length === 1 ? 'diese Ausgabe' : 'diese Ausgaben'} über zusammen ${fmt(summe)} € nennt der Beleg weder ` +
                'USt-Betrag noch Nettobetrag. Die Vorsteuer aus den Belegen ist darum eine Untergrenze: steckt darin ' +
                'Umsatzsteuer, fehlt ihr Abzug. Zu klären: am Beleg den USt-Betrag eintragen — oder als in Ordnung ' +
                'markieren, wenn er keine ausweist.',
            status: 'befund',
            ...capBetroffen(treffer.map(({ r }) => ({ art: 'buchung' as const, id: r.id, zeile: buchungZeile(r) }))),
            handlungen: [
                {
                    id: 'beleg',
                    label: 'Beleg öffnen',
                    target: { art: 'dialog', dialog: 'beleg', ref: treffer[0].beleg.id },
                },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(treffer.map(({ r }) => r.id)),
        },
    ];
}
