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
import { buchungZeile, capBetroffen, HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import { isEuCountry } from './reverse-charge.ts';
import { gleichePartei, parteiSchluessel } from './serie.ts';

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
    if (auslaendisch(ibanLand)) return { land: ibanLand, satz: `Gegenkonto in ${ibanLand}` };
    const ustLand = landAusUstId(r.lieferantUstId);
    if (auslaendisch(ustLand)) return { land: ustLand, satz: `USt-IdNr. auf dem Beleg aus ${ustLand}` };
    const iban = (r.counterpartyIban ?? '').replace(/\s+/g, '').toUpperCase();
    for (const p of parteien) {
        const passt =
            gleichePartei(p.name, r.counterparty) ||
            (!!iban && (p.iban ?? '').replace(/\s+/g, '').toUpperCase() === iban);
        if (!passt) continue;
        const land = auslaendisch(p.land?.toUpperCase()) ? p.land!.toUpperCase() : landAusUstId(p.ustId);
        if (auslaendisch(land)) return { land, satz: `Kontakt „${p.name ?? '—'}" mit Sitz in ${land}` };
    }
    const frueher = zeilen.find(
        (x) => x.id !== r.id && x.reverseCharge === 'gebucht' && gleichePartei(x.counterparty, r.counterparty),
    );
    if (frueher) {
        const land = auslaendisch(frueher.lieferantLand) ? frueher.lieferantLand : null;
        return { land, satz: 'andere Buchungen an diese Gegenseite sind als § 13b eingeordnet' };
    }
    return null;
}

function absatz(land: string | null): string {
    if (!land) return 'Abs. 1 oder Abs. 2 Nr. 1';
    return isEuCountry(land) ? 'Abs. 1: Leistung aus der EU' : 'Abs. 2 Nr. 1: Drittland';
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
                        title: '§ 13b-Kandidaten: nicht prüfbar',
                        text: `Für ${i.year} weiß die App bei keinem Lieferanten, wo er sitzt.`,
                        status: 'nicht_pruefbar',
                        weil: 'keine Buchung eine Gegenkonto-IBAN oder ein Lieferantenland trägt und kein Kontakt ein Land nennt',
                    },
                ],
            };
        }
        return {
            ids: new Set(),
            hinweise: [
                {
                    ...basis,
                    title: '§ 13b-Kandidaten: keine übersehenen',
                    text: `${ohneUst} Ausgabe(n) ${i.year} ohne ausgewiesene USt auf ausländische Lieferanten geprüft.`,
                    status: 'ohne_befund',
                    geprueft:
                        'IBAN-Land, USt-IdNr. am Beleg, Kontakte und frühere § 13b-Buchungen derselben Gegenseite; ' +
                        `als § 13b eingeordnet: ${gebucht}, zur Prüfung vorgemerkt: ${zurPruefung}`,
                },
            ],
        };
    }

    const ku = i.kleinunternehmer
        ? ' Als Kleinunternehmer gilt das auch — nur ohne Vorsteuerabzug, die Steuer ist dann eine echte Last und für ' +
          'diesen Zeitraum in einer Voranmeldung anzumelden (§ 18 Abs. 4a UStG).'
        : ' Bei vollem Vorsteuerabzug gleicht die Vorsteuer sie aus, anzumelden ist sie trotzdem.';
    const out: Hinweis[] = [];
    for (const [key, g] of [...gruppen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        g.rows.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
        const summe = round2(g.rows.reduce((s, r) => s - r.amount, 0));
        out.push({
            ...basis,
            key: `reverse-charge-kandidat:${key}`,
            level: 'warnung',
            title: `§ 13b nicht erkannt? ${g.name}`,
            text:
                `${g.rows.length === 1 ? 'Eine Ausgabe' : `${g.rows.length} Ausgaben`} an ${g.name} über ` +
                `${g.rows.length === 1 ? '' : 'zusammen '}${fmt(summe)} € ohne ausgewiesene USt, nicht als Reverse Charge ` +
                `eingeordnet — ${g.satz}. Vermutlich ein ausländischer Lieferant: dann schuldest du die Umsatzsteuer nach ` +
                `§ 13b Abs. 5 UStG (${absatz(g.land)}).${ku} Zu klären: ` +
                'die Rechnung mit Lieferantenland zuordnen, dann ordnet die App § 13b selbst ein.',
            status: 'befund',
            ...capBetroffen(g.rows.map((r) => ({ art: 'buchung' as const, id: r.id, zeile: buchungZeile(r) }))),
            handlungen: [
                {
                    id: 'beleg-zuordnen',
                    label: 'Beleg zuordnen',
                    target: { art: 'dialog', dialog: 'beleg-zuordnen', ref: g.rows[0].id },
                },
                {
                    id: 'buchung',
                    label: 'Buchung öffnen',
                    target: { art: 'dialog', dialog: 'buchung', ref: g.rows[0].id },
                },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(g.rows.map((r) => r.id)),
        });
    }
    return { hinweise: out, ids: new Set([...gruppen.values()].flatMap((g) => g.rows.map((r) => r.id))) };
}
