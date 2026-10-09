/**
 * „Anlagegut-Kandidat" — a Prüfung vor der Abgabe (Idee 10 in docs/ideen-nutzerfuehrung.md): an
 * expense above the GWG limit that is not in the Anlageverzeichnis (`afa.ts`).
 *
 * Above the limit an abnutzbares bewegliches Wirtschaftsgut is not deducted at once but depreciated
 * (§ 6 Abs. 2 EStG); between the Sammelposten bounds it may instead go into a Sammelposten (§ 6 Abs. 2a
 * EStG), which the hint mentions. The limit applies to the cost WITHOUT a deductible Vorsteuer (§ 9b
 * Abs. 1 EStG) — net for a business with Vorsteuerabzug, gross for a Kleinunternehmer. Exactly at the
 * limit is still a GWG („nicht übersteigen"). Values: docs/references/tax-sources.md, „Prüfungen vor
 * der Abgabe".
 *
 * Only categories an equipment purchase lands in are looked at (Büroeinrichtung/GWG, Bürobedarf,
 * Sonstige, unklassifiziert) — rent or a trade-fair stand above 800 € is no asset. Instalments to the
 * same dealer (a `serie.ts` series: same party, same amount, fixed interval) count as ONE asset with
 * their sum. Confirmed laufende Kosten (Idee 8) are subscriptions, not assets. An expense counts as
 * captured when an asset lists one of its bookings, or has about its cost and date.
 *
 * Pure — the caller passes the year's EÜR rows, the Anlageverzeichnis and the laufende-Kosten ids.
 */

import { fmtDe as fmt, round2 } from '../lib/money.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';
import type { EuerKind } from './euer-aggregate.ts';
import {
    buchungZeile,
    capBetroffen,
    HANDLUNG_IN_ORDNUNG,
    hinweisFingerprint,
    type AnlagegutVorbelegung,
    type Hinweis,
} from './hinweise.ts';
import { findeSerien, type SerienAbstand } from './serie.ts';

/**
 * GWG limit and Sammelposten band for a Wirtschaftsjahr — § 6 Abs. 2 and 2a EStG in the version since
 * 1.1.2018. Earlier years are not on file (null → „nicht prüfbar").
 */
export function abschreibungsGrenzen(year: number): { gwg: number; sammelVon: number; sammelBis: number } | null {
    return year >= 2018 ? { gwg: 800, sammelVon: 250, sammelBis: 1000 } : null;
}

/** Categories an equipment purchase is booked under. App choice. */
export const ANLAGE_KATEGORIEN: ReadonlySet<string> = new Set([
    '0420 Büroeinrichtung/GWG',
    '4930 Bürobedarf',
    '4650 Sonstige Betriebsausgaben',
    '(unklassifiziert)',
]);
/** An asset matches an expense by cost when it is within 1 % (at least 1 €)… App choice. */
export const ANLAGE_ABGLEICH_ANTEIL = 0.01;
/** …and its Anschaffung lies within this many days of the first payment. App choice. */
export const ANLAGE_ABGLEICH_TAGE = 90;

export interface AnlageZeile {
    id: string;
    accountKey?: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    kind: EuerKind;
    category: string;
    /** Signed EÜR contribution; positive for a debit expense. */
    net: number;
    gross: number;
}

/** An Anlageverzeichnis entry as the check needs it. */
export interface AnlageEintrag {
    anschaffung: string;
    ahk: number;
    buchungIds?: readonly string[];
}

export interface AnlagegutInput {
    year: number;
    zeilen: readonly AnlageZeile[];
    anlagen: readonly AnlageEintrag[];
    /** Payment ids of the confirmed laufende Kosten (`laufendeKostenIds`). */
    laufendeKostenIds?: ReadonlySet<string>;
    /** Without Vorsteuerabzug the VAT belongs to the cost (§ 9b Abs. 1 EStG). */
    kleinunternehmer?: boolean;
}

const ABSTAND_TEXT: Record<SerienAbstand, string> = {
    monatlich: 'monatlich',
    vierteljaehrlich: 'vierteljährlich',
    halbjaehrlich: 'halbjährlich',
    jaehrlich: 'jährlich',
};

function erfasst(anlagen: readonly AnlageEintrag[], ids: readonly string[], wert: number, datum: string): boolean {
    return anlagen.some(
        (a) =>
            (a.buchungIds ?? []).some((id) => ids.includes(id)) ||
            (Math.abs(a.ahk - wert) <= Math.max(1, wert * ANLAGE_ABGLEICH_ANTEIL) &&
                Math.abs(dayDiff(a.anschaffung, datum) ?? Infinity) <= ANLAGE_ABGLEICH_TAGE),
    );
}

export function pruefeAnlagegutKandidaten(i: AnlagegutInput): Hinweis[] {
    const basis = {
        key: 'anlagegut-kandidat',
        level: 'info' as const,
        ref: '§ 6 Abs. 2 EStG',
        begriff: 'anlagegut-kandidat',
    };
    const g = abschreibungsGrenzen(i.year);
    if (!g) {
        return [
            {
                ...basis,
                title: 'Anlagegut-Kandidaten: nicht prüfbar',
                text: `Für ${i.year} ist keine GWG-Grenze hinterlegt.`,
                status: 'nicht_pruefbar',
                weil: `die GWG-Grenze vor 2018 nicht in der Quellenliste steht`,
            },
        ];
    }
    const art = i.kleinunternehmer ? 'brutto' : 'netto';
    let laufend = 0;
    const zeilen = i.zeilen.filter((r) => {
        if (r.kind !== 'expense' || r.amount >= 0 || r.accountKey === 'adjustment') return false;
        if (!r.bookingDate.startsWith(String(i.year)) || !ANLAGE_KATEGORIEN.has(r.category)) return false;
        if (i.laufendeKostenIds?.has(r.id)) {
            laufend++;
            return false;
        }
        return true;
    });
    const wertVon = (r: AnlageZeile) => (i.kleinunternehmer ? r.gross : r.net);

    // Instalments first: a series is one asset; what is left stands alone.
    const gruppen: { rows: AnlageZeile[]; abstand?: SerienAbstand }[] = [];
    const inSerie = new Set<string>();
    const byId = new Map(zeilen.map((r) => [r.id, r]));
    for (const s of findeSerien(
        zeilen.map((r) => ({ id: r.id, datum: r.bookingDate, betrag: r.amount, partei: r.counterparty ?? '' })),
    )) {
        gruppen.push({ rows: s.ids.map((id) => byId.get(id)!), abstand: s.abstand });
        s.ids.forEach((id) => inSerie.add(id));
    }
    for (const r of zeilen) if (!inSerie.has(r.id)) gruppen.push({ rows: [r] });

    let imVerzeichnis = 0;
    const out: Hinweis[] = [];
    for (const gr of gruppen) {
        gr.rows.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
        const wert = round2(gr.rows.reduce((s, r) => s + wertVon(r), 0));
        if (wert <= g.gwg) continue;
        const ids = gr.rows.map((r) => r.id);
        const erste = gr.rows[0];
        if (erfasst(i.anlagen, ids, wert, erste.bookingDate)) {
            imVerzeichnis++;
            continue;
        }
        const name = erste.counterparty?.trim() || 'Händler';
        const vorbelegung: AnlagegutVorbelegung = {
            bezeichnung: erste.purpose?.trim() || name,
            anschaffung: erste.bookingDate.slice(0, 10),
            ahk: wert,
            buchungIds: ids,
        };
        const was = gr.abstand
            ? `${gr.rows.length} Raten an ${name} (${ABSTAND_TEXT[gr.abstand]}) über zusammen ${fmt(wert)} € ${art}`
            : `Eine Ausgabe an ${name} über ${fmt(wert)} € ${art}`;
        const sammel =
            wert <= g.sammelBis
                ? ` Bis ${fmt(g.sammelBis)} € geht statt dessen ein Sammelposten (§ 6 Abs. 2a EStG: ein Fünftel je Jahr, ` +
                  `einheitlich für alle Güter des Jahres über ${fmt(g.sammelVon)} €).`
                : '';
        const ku = i.kleinunternehmer
            ? ' Brutto, weil ohne Vorsteuerabzug die USt zu den Anschaffungskosten gehört (§ 9b Abs. 1 EStG).'
            : '';
        out.push({
            ...basis,
            key: `anlagegut-kandidat:${ids[0]}`,
            level: 'tipp',
            title: `Anlagegut? ${name}, ${fmt(wert)} €`,
            text:
                `${was} liegt über der GWG-Grenze von ${fmt(g.gwg)} € und steht nicht im Anlageverzeichnis. Vermutlich ein ` +
                `Anlagegut: dann wird es über die Nutzungsdauer abgeschrieben statt sofort abgezogen.${sammel}${ku} Zu klären: ` +
                'ins Anlageverzeichnis aufnehmen — oder als in Ordnung markieren, wenn es Verbrauchsmaterial oder eine Dienstleistung ist.',
            status: 'befund',
            ...capBetroffen(gr.rows.map((r) => ({ art: 'buchung' as const, id: r.id, zeile: buchungZeile(r) }))),
            handlungen: [
                {
                    id: 'anlagegut-erfassen',
                    label: 'Ins Anlageverzeichnis',
                    target: { art: 'dialog', dialog: 'anlagegut-erfassen', ref: ids[0], vorbelegung },
                },
                { id: 'buchung', label: 'Buchung öffnen', target: { art: 'dialog', dialog: 'buchung', ref: ids[0] } },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(ids),
        });
    }
    if (out.length) return out;
    return [
        {
            ...basis,
            title: 'Anlagegut-Kandidaten: keine',
            text: `${zeilen.length} Ausgabe(n) ${i.year} in Kategorien für Anschaffungen geprüft.`,
            status: 'ohne_befund',
            geprueft:
                `Büroeinrichtung, Bürobedarf, Sonstiges und Unklassifiziertes gegen die GWG-Grenze von ${fmt(g.gwg)} € ${art}, ` +
                `Raten an denselben Händler als ein Gut; ausgenommen: im Anlageverzeichnis (${imVerzeichnis}), bestätigte ` +
                `laufende Kosten (${laufend})`,
        },
    ];
}
