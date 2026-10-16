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
    handlungInOrdnung,
    hinweisFingerprint,
    type AnlagegutVorbelegung,
    type Hinweis,
} from './hinweise.ts';
import { findeSerien, type SerienAbstand } from './serie.ts';
import { abstandText } from './laufende-kosten.ts';
import { _, _n, fmt as t } from '../lib/i18n.ts';

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
                title: _('Fixed-asset candidates: cannot be checked'),
                text: t(_('No low-value asset threshold on file for {year}.'), { year: i.year }),
                status: 'nicht_pruefbar',
                weil: _('the low-value asset threshold before 2018 is not in the source list'),
            },
        ];
    }
    const art = i.kleinunternehmer ? _('gross') : _('net');
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
        const name = erste.counterparty?.trim() || _('Retailer');
        const vorbelegung: AnlagegutVorbelegung = {
            bezeichnung: erste.purpose?.trim() || name,
            anschaffung: erste.bookingDate.slice(0, 10),
            ahk: wert,
            buchungIds: ids,
        };
        const was = gr.abstand
            ? t(_('{n} instalments to {name} ({interval}) totalling {amount} € {basis}'), {
                  n: gr.rows.length,
                  name,
                  interval: abstandText(gr.abstand),
                  amount: fmt(wert),
                  basis: art,
              })
            : t(_('One expense to {name} of {amount} € {basis}'), { name, amount: fmt(wert), basis: art });
        const sammel =
            wert <= g.sammelBis
                ? ' ' +
                  t(
                      _(
                          'Up to {limit} € a collective item is possible instead (§ 6 Abs. 2a EStG: one fifth per year, uniformly for all assets of the year above {from} €).',
                      ),
                      { limit: fmt(g.sammelBis), from: fmt(g.sammelVon) },
                  )
                : '';
        const ku = i.kleinunternehmer
            ? ' ' +
              _(
                  'Gross, because without input tax deduction the VAT is part of the acquisition cost (§ 9b Abs. 1 EStG).',
              )
            : '';
        out.push({
            ...basis,
            key: `anlagegut-kandidat:${ids[0]}`,
            level: 'tipp',
            title: t(_('Fixed asset? {name}, {amount} €'), { name, amount: fmt(wert) }),
            text:
                t(
                    _(
                        '{what} is above the low-value asset threshold of {limit} € and is not in the asset register. Probably a fixed asset: it is then depreciated over its useful life instead of deducted at once.',
                    ),
                    { what: was, limit: fmt(g.gwg) },
                ) +
                sammel +
                ku +
                ' ' +
                _('To clarify: add it to the asset register — or mark it as fine if it is consumables or a service.'),
            status: 'befund',
            ...capBetroffen(gr.rows.map((r) => ({ art: 'buchung' as const, id: r.id, zeile: buchungZeile(r) }))),
            handlungen: [
                {
                    id: 'anlagegut-erfassen',
                    label: _('Add to the asset register'),
                    target: { art: 'dialog', dialog: 'anlagegut-erfassen', ref: ids[0], vorbelegung },
                },
                {
                    id: 'buchung',
                    label: _('Open the transaction'),
                    target: { art: 'dialog', dialog: 'buchung', ref: ids[0] },
                },
                handlungInOrdnung(),
            ],
            fingerprint: hinweisFingerprint(ids),
        });
    }
    if (out.length) return out;
    return [
        {
            ...basis,
            title: _('Fixed-asset candidates: none'),
            text: t(
                _n(
                    '{n} expense from {year} checked in categories for acquisitions.',
                    '{n} expenses from {year} checked in categories for acquisitions.',
                    zeilen.length,
                ),
                { n: zeilen.length, year: i.year },
            ),
            status: 'ohne_befund',
            geprueft: t(
                _(
                    'office equipment, office supplies, other and unclassified against the low-value asset threshold of {limit} € {basis}, instalments to the same retailer as one asset; excluded: in the asset register ({registered}), confirmed recurring costs ({recurring})',
                ),
                { limit: fmt(g.gwg), basis: art, registered: imVerzeichnis, recurring: laufend },
            ),
        },
    ];
}
