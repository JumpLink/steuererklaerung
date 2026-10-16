/**
 * „§ 13b-Kandidat nicht erkannt" — a Prüfung vor der Abgabe (Idee 10 in docs/ideen-nutzerfuehrung.md).
 *
 * `reverse-charge.ts` books § 13b from a linked receipt that names a foreign supplier country or carries
 * the reverse-charge flag. This check catches only what falls through it: an expense WITHOUT VAT on a
 * receipt (or without a receipt at all) that was not booked as § 13b, while something else says the
 * supplier sits abroad —
 *   - the counterparty IBAN has a non-German country code,
 *   - the receipt names a non-German USt-IdNr,
 *   - a contact of that name has a non-German country or USt-IdNr,
 *   - another booking to the same party WAS booked as § 13b (one month linked, the others not).
 *
 * Not reported: receipts that show VAT (a foreign supplier registered in Germany), VAT-exempt categories
 * (§ 13b needs a taxable supply), rows already booked or held for review by `reverse-charge.ts`, and a
 * receipt that names Germany as the supplier country. Kleinunternehmer are checked too: they owe the
 * tax as recipients as well, only without Vorsteuerabzug (docs/references/tax-sources.md, „Prüfungen vor
 * der Abgabe").
 *
 * Pure — the caller passes the year's EÜR rows, documents and contacts.
 */

import { fmtDe as fmt, round2 } from '../lib/money.ts';
import type { EuerKind } from './euer-aggregate.ts';
import { impliedRate } from './euer-classify.ts';
import { buchungZeile, capBetroffen, handlungInOrdnung, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import { isEuCountry } from './reverse-charge.ts';
import { gleichePartei, parteiSchluessel } from './serie.ts';
import { _, _n, fmt as t } from '../lib/i18n.ts';

export interface RcZeile {
    id: string;
    accountKey?: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    kind: EuerKind;
    category: string;
    counterpartyIban?: string;
    reverseCharge?: 'gebucht' | 'pruefen';
    lieferantLand?: string;
    lieferantUstId?: string;
}

export interface RcBeleg {
    id: string;
    vat: number | null;
    linkedTxIds: string[];
}

/** A known party (a contact) with what it says about its seat. */
export interface RcPartei {
    name: string | null;
    land?: string | null;
    ustId?: string | null;
    iban?: string | null;
}

export interface RcKandidatInput {
    year: number;
    zeilen: readonly RcZeile[];
    belege: readonly RcBeleg[];
    parteien?: readonly RcPartei[];
    kleinunternehmer?: boolean;
}

/** Country code of an IBAN (`DK50…` → `DK`), or null for anything that is not one. */
export function landAusIban(iban: string | null | undefined): string | null {
    const s = (iban ?? '').replace(/\s+/g, '').toUpperCase();
    return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s) ? s.slice(0, 2) : null;
}

/** Country prefix of a USt-IdNr (`ATU12345678` → `AT`, Greece's `EL` stays `EL`). */
export function landAusUstId(id: string | null | undefined): string | null {
    const s = (id ?? '').replace(/\s+/g, '').toUpperCase();
    return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(s) ? s.slice(0, 2) : null;
}

const UNKLASSIFIZIERT = '(unklassifiziert)';
const auslaendisch = (land: string | null | undefined): land is string => !!land && land !== 'DE';

interface Grund {
    land: string | null;
    satz: string;
}

function grundFuer(r: RcZeile, zeilen: readonly RcZeile[], parteien: readonly RcPartei[]): Grund | null {
    const ibanLand = landAusIban(r.counterpartyIban);
    if (auslaendisch(ibanLand))
        return { land: ibanLand, satz: t(_('counter account in {country}'), { country: ibanLand }) };
    const ustLand = landAusUstId(r.lieferantUstId);
    if (auslaendisch(ustLand))
        return { land: ustLand, satz: t(_('VAT ID on the receipt from {country}'), { country: ustLand }) };
    const iban = (r.counterpartyIban ?? '').replace(/\s+/g, '').toUpperCase();
    for (const p of parteien) {
        const passt =
            gleichePartei(p.name, r.counterparty) ||
            (!!iban && (p.iban ?? '').replace(/\s+/g, '').toUpperCase() === iban);
        if (!passt) continue;
        const land = auslaendisch(p.land?.toUpperCase()) ? p.land!.toUpperCase() : landAusUstId(p.ustId);
        if (auslaendisch(land))
            return { land, satz: t(_('contact “{name}” based in {country}'), { name: p.name ?? '—', country: land }) };
    }
    const frueher = zeilen.find(
        (x) => x.id !== r.id && x.reverseCharge === 'gebucht' && gleichePartei(x.counterparty, r.counterparty),
    );
    if (frueher) {
        const land = auslaendisch(frueher.lieferantLand) ? frueher.lieferantLand : null;
        return { land, satz: _('other bookings to this counterparty are classified as § 13b') };
    }
    return null;
}

function absatz(land: string | null): string {
    if (!land) return _('Abs. 1 or Abs. 2 Nr. 1');
    return isEuCountry(land) ? _('Abs. 1: supply from the EU') : _('Abs. 2 Nr. 1: non-EU country');
}

export function pruefeReverseChargeKandidaten(i: RcKandidatInput): Hinweis[] {
    return reverseChargeKandidaten(i).hinweise;
}

/** The hints plus every booking they list (uncapped) — the other checks leave those to these. */
export function reverseChargeKandidaten(i: RcKandidatInput): { hinweise: Hinweis[]; ids: Set<string> } {
    const basis = {
        key: 'reverse-charge-kandidat',
        level: 'info' as const,
        ref: '§ 13b UStG',
        begriff: 'reverse-charge',
    };
    const parteien = i.parteien ?? [];
    const ustJeBuchung = new Map<string, boolean>();
    for (const d of i.belege) {
        for (const id of d.linkedTxIds) ustJeBuchung.set(id, (ustJeBuchung.get(id) ?? false) || (d.vat ?? 0) > 0.005);
    }
    const ausgaben = i.zeilen.filter(
        (r) =>
            r.kind === 'expense' &&
            r.amount < 0 &&
            r.accountKey !== 'adjustment' &&
            r.bookingDate.startsWith(String(i.year)),
    );
    const gebucht = ausgaben.filter((r) => r.reverseCharge === 'gebucht').length;
    const zurPruefung = ausgaben.filter((r) => r.reverseCharge === 'pruefen').length;
    let ohneUst = 0;
    const gruppen = new Map<string, { name: string; land: string | null; satz: string; rows: RcZeile[] }>();
    for (const r of ausgaben) {
        if (r.reverseCharge) continue;
        if (r.category !== UNKLASSIFIZIERT && impliedRate(r.category, 'expense') === 0) continue;
        if (ustJeBuchung.get(r.id)) continue;
        if (r.lieferantLand === 'DE') continue;
        ohneUst++;
        const g = grundFuer(r, i.zeilen, parteien);
        if (!g) continue;
        const key = parteiSchluessel(r.counterparty) || r.id;
        const gruppe = gruppen.get(key) ?? { name: r.counterparty?.trim() || 'Lieferant', ...g, rows: [] };
        gruppe.rows.push(r);
        gruppen.set(key, gruppe);
    }

    if (gruppen.size === 0) {
        const signale =
            ausgaben.some((r) => landAusIban(r.counterpartyIban) || r.lieferantLand || r.lieferantUstId) ||
            parteien.some((p) => p.land || p.ustId) ||
            gebucht > 0;
        if (!signale) {
            return {
                ids: new Set(),
                hinweise: [
                    {
                        ...basis,
                        title: _('§ 13b candidates: cannot be checked'),
                        text: t(_('For {year} the app knows where none of the suppliers is based.'), {
                            year: i.year,
                        }),
                        status: 'nicht_pruefbar',
                        weil: _(
                            'no booking carries a counter account IBAN or a supplier country and no contact names a country',
                        ),
                    },
                ],
            };
        }
        return {
            ids: new Set(),
            hinweise: [
                {
                    ...basis,
                    title: _('§ 13b candidates: none missed'),
                    text: t(
                        _n(
                            '{n} expense from {year} without declared VAT checked for foreign suppliers.',
                            '{n} expenses from {year} without declared VAT checked for foreign suppliers.',
                            ohneUst,
                        ),
                        { n: ohneUst, year: i.year },
                    ),
                    status: 'ohne_befund',
                    geprueft: t(
                        _(
                            'IBAN country, VAT ID on the receipt, contacts and earlier § 13b bookings of the same counterparty; classified as § 13b: {booked}, flagged for review: {review}',
                        ),
                        { booked: gebucht, review: zurPruefung },
                    ),
                },
            ],
        };
    }

    const ku = i.kleinunternehmer
        ? ' ' +
          _(
              'As a small business this applies too — only without input tax deduction, so the tax is a real burden and has to be declared for that period in an advance return (§ 18 Abs. 4a UStG).',
          )
        : ' ' + _('With a full input tax deduction the input tax offsets it, but it still has to be declared.');
    const out: Hinweis[] = [];
    for (const [key, g] of [...gruppen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        g.rows.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
        const summe = round2(g.rows.reduce((s, r) => s - r.amount, 0));
        out.push({
            ...basis,
            key: `reverse-charge-kandidat:${key}`,
            level: 'warnung',
            title: t(_('§ 13b not recognised? {name}'), { name: g.name }),
            text:
                t(
                    _n(
                        'One expense to {name} of {amount} € without declared VAT, not classified as reverse charge — {signal}.',
                        '{n} expenses to {name} totalling {amount} € without declared VAT, not classified as reverse charge — {signal}.',
                        g.rows.length,
                    ),
                    { n: g.rows.length, name: g.name, amount: fmt(summe), signal: g.satz },
                ) +
                ' ' +
                t(_('Probably a foreign supplier: then you owe the VAT under § 13b Abs. 5 UStG ({paragraph}).'), {
                    paragraph: absatz(g.land),
                }) +
                ku +
                ' ' +
                _('To clarify: assign the invoice with a supplier country, then the app classifies § 13b itself.'),
            status: 'befund',
            ...capBetroffen(g.rows.map((r) => ({ art: 'buchung' as const, id: r.id, zeile: buchungZeile(r) }))),
            handlungen: [
                {
                    id: 'beleg-zuordnen',
                    label: _('Assign a document'),
                    target: { art: 'dialog', dialog: 'beleg-zuordnen', ref: g.rows[0].id },
                },
                {
                    id: 'buchung',
                    label: _('Open the transaction'),
                    target: { art: 'dialog', dialog: 'buchung', ref: g.rows[0].id },
                },
                handlungInOrdnung(),
            ],
            fingerprint: hinweisFingerprint(g.rows.map((r) => r.id)),
        });
    }
    return { hinweise: out, ids: new Set([...gruppen.values()].flatMap((g) => g.rows.map((r) => r.id))) };
}
