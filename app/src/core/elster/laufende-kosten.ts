/**
 * Laufende Kosten (Idee 8 in docs/ideen-nutzerfuehrung.md) — debits at a fixed interval (rent,
 * software, insurance), detected from an entity's bookings of ALL years and presented for
 * confirmation. Not the „wiederkehrenden Rechnungen" (`recurring-schedules.ts`): those are the
 * entity's own outgoing invoices.
 *
 * Detection reuses the series chains of `serie.ts` ({@link findeSerienMitDrift}): grouped by the
 * normalised counterparty ({@link parteiSchluessel}, as in Idee 7), ± {@link SERIE_TOLERANZ_TAGE} days
 * per hit, the amount may move by {@link LAUFENDE_KOSTEN_DRIFT_ANTEIL} from one hit to the next (a price
 * change, reported with its date). A series is „beendet?" when the newest booking of the entity lies
 * more than {@link LAUFENDE_KOSTEN_STOP_FAKTOR} intervals after its last payment — measured against
 * the data, not today, so a bank import that is a few weeks behind does not end every series.
 *
 * The owner decides per series (confirmed, optionally corrected · „keine laufenden Kosten" · ended);
 * only confirmed, active series feed Frei verfügbar and the Idee-7 exclusion. Pure: bookings and
 * decisions in, candidates out.
 */

import { fmtDe, round2 } from '../lib/money.ts';
import { dayDiff } from '../lib/transactions/reconcile.ts';
import { buchungZeile, HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import {
    ABSTAND_MONATE,
    findeSerienMitDrift,
    gleichePartei,
    parteiSchluessel,
    plusMonate,
    SERIE_TOLERANZ_TAGE,
    type SerienAbstand,
} from './serie.ts';

export type { SerienAbstand } from './serie.ts';

/**
 * Hits per interval before a series is proposed. App choice, not a legal number
 * (docs/references/tax-sources.md, „Geld-Prüfungen"). Monthly and quarterly need three, as in Idee 7.
 * Half-yearly and yearly need TWO — one observed interval: three yearly hits take two full years of
 * history, so an insurance would only show in its third year. Two hits of one party, ± 5 days, with
 * nearly the same amount are rarely chance; and a proposal changes nothing until it is confirmed.
 */
export const LAUFENDE_KOSTEN_MIN_TREFFER: Record<SerienAbstand, number> = {
    monatlich: 3,
    vierteljaehrlich: 3,
    halbjaehrlich: 2,
    jaehrlich: 2,
};

/** How far the amount may move from one hit to the next (share of the previous amount) and still be
 *  the same series — a price change, not a different product. App choice, see tax-sources.md. */
export const LAUFENDE_KOSTEN_DRIFT_ANTEIL = 0.25;

/** A series without a payment for more than this many intervals (against the newest booking) is
 *  „beendet?". App choice, see tax-sources.md. */
export const LAUFENDE_KOSTEN_STOP_FAKTOR = 1.5;

export const ABSTAND_TEXT: Record<SerienAbstand, string> = {
    monatlich: 'monatlich',
    vierteljaehrlich: 'vierteljährlich',
    halbjaehrlich: 'halbjährlich',
    jaehrlich: 'jährlich',
};

/** The slice of a booking detection reads (structurally a store transaction). */
export interface LkBuchung {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
}

export type LkStatus = 'vorschlag' | 'bestaetigt' | 'abgelehnt' | 'beendet';

/** The owner's decision on one series, stored per entity (`laufende_kosten` in the manifest). */
export interface LkEntscheidung {
    key: string;
    status: 'bestaetigt' | 'abgelehnt' | 'beendet';
    /** Corrected interval (only with `bestaetigt`). */
    abstand?: SerienAbstand;
    /** Corrected amount in EUR, positive (only with `bestaetigt`). */
    betrag?: number;
    /** ISO date of the decision. */
    entschieden_am?: string;
}

export interface LkZahlung {
    id: string;
    datum: string;
    /** EUR, positive. */
    betrag: number;
}

export interface LaufendeKosten {
    /** Stable id of the series: normalised party + interval (+ first amount when one party has two). */
    key: string;
    /** As the newest booking spells it. */
    empfaenger: string;
    /** As detected. */
    erkannterAbstand: SerienAbstand;
    /** In effect: the correction, else the detected one. */
    abstand: SerienAbstand;
    /** Median of the payments, EUR positive. */
    typischerBetrag: number;
    letzterBetrag: number;
    /** What the next payment is expected to be: the correction, else the last amount. */
    betrag: number;
    /** The newest change of amount between two consecutive payments. */
    preisaenderung?: { von: number; auf: number; datum: string; id: string };
    zuletzt: string;
    /** `zuletzt` + one interval. */
    naechste: string;
    zahlungen: LkZahlung[];
    /** False = no payment for more than {@link LAUFENDE_KOSTEN_STOP_FAKTOR} intervals („beendet?"). */
    aktiv: boolean;
    status: LkStatus;
    entschiedenAm?: string;
    /** Set when the owner corrected interval or amount. */
    korrigiert?: true;
}

export interface LaufendeKostenUebersicht {
    /** Newest booking of the entity — what „aktiv" is measured against. */
    datenstand: string | null;
    vorschlaege: LaufendeKosten[];
    bestaetigt: LaufendeKosten[];
    abgelehnt: LaufendeKosten[];
    beendet: LaufendeKosten[];
}

const cents = (n: number) => Math.round(n * 100);

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** The newest booking date — the „Datenstand" a series' activity is measured against. */
export function neuesteBuchung(buchungen: readonly { bookingDate: string }[]): string | null {
    return buchungen.reduce<string | null>((m, t) => (!m || t.bookingDate > m ? t.bookingDate : m), null);
}

/** Whether a series last paid on `zuletzt` has stopped, measured against `datenstand`. */
export function istBeendet(zuletzt: string, abstand: SerienAbstand, datenstand: string | null): boolean {
    if (!datenstand) return false;
    const intervall = dayDiff(plusMonate(zuletzt, ABSTAND_MONATE[abstand]), zuletzt) ?? 0;
    return (dayDiff(datenstand, zuletzt) ?? 0) > LAUFENDE_KOSTEN_STOP_FAKTOR * intervall;
}

/**
 * Every series of debits among the bookings, as proposals (status `vorschlag`). `datenstand` defaults
 * to the newest booking date in `buchungen` (credits included).
 */
export function erkenneLaufendeKosten(
    buchungen: readonly LkBuchung[],
    opts: { datenstand?: string | null } = {},
): LaufendeKosten[] {
    const datenstand = opts.datenstand !== undefined ? opts.datenstand : neuesteBuchung(buchungen);
    const byId = new Map(buchungen.map((t) => [t.id, t]));
    const serien = findeSerienMitDrift(
        buchungen
            .filter((t) => t.amount < 0 && t.counterparty?.trim())
            .map((t) => ({ id: t.id, datum: t.bookingDate, betrag: t.amount, partei: t.counterparty! })),
        { driftAnteil: LAUFENDE_KOSTEN_DRIFT_ANTEIL, minTreffer: (a) => LAUFENDE_KOSTEN_MIN_TREFFER[a] },
    );
    const basis = serien.map((s) => `${s.partei}:${s.abstand}`);
    const out = serien.map((s, i): LaufendeKosten => {
        const zahlungen = s.posten.map((p) => ({ id: p.id, datum: p.datum, betrag: round2(-p.betrag) }));
        const letzte = zahlungen[zahlungen.length - 1];
        let preisaenderung: LaufendeKosten['preisaenderung'];
        for (let n = zahlungen.length - 1; n > 0; n--) {
            if (cents(zahlungen[n].betrag) !== cents(zahlungen[n - 1].betrag)) {
                const z = zahlungen[n];
                preisaenderung = { von: zahlungen[n - 1].betrag, auf: z.betrag, datum: z.datum, id: z.id };
                break;
            }
        }
        const doppelt = basis.filter((b) => b === basis[i]).length > 1;
        return {
            key: doppelt ? `${basis[i]}:${cents(zahlungen[0].betrag)}` : basis[i],
            empfaenger: byId.get(letzte.id)?.counterparty?.trim() ?? s.partei,
            erkannterAbstand: s.abstand,
            abstand: s.abstand,
            typischerBetrag: median(zahlungen.map((z) => z.betrag)),
            letzterBetrag: letzte.betrag,
            betrag: letzte.betrag,
            preisaenderung,
            zuletzt: letzte.datum,
            naechste: plusMonate(letzte.datum, ABSTAND_MONATE[s.abstand]),
            zahlungen,
            aktiv: !istBeendet(letzte.datum, s.abstand, datenstand),
            status: 'vorschlag',
        };
    });
    return out.sort((a, b) => a.empfaenger.localeCompare(b.empfaenger, 'de') || a.key.localeCompare(b.key));
}

/** Apply the owner's decisions: status, corrected interval/amount, and what follows from them. */
export function mitEntscheidungen(
    kandidaten: readonly LaufendeKosten[],
    entscheidungen: readonly LkEntscheidung[],
    datenstand: string | null,
): LaufendeKosten[] {
    const byKey = new Map(entscheidungen.map((e) => [e.key, e]));
    return kandidaten.map((k) => {
        const e = byKey.get(k.key);
        if (!e) return k;
        const out: LaufendeKosten = { ...k, status: e.status, entschiedenAm: e.entschieden_am };
        if (e.status === 'bestaetigt' && (e.abstand || e.betrag != null)) {
            out.abstand = e.abstand ?? k.abstand;
            out.betrag = e.betrag != null ? round2(e.betrag) : k.betrag;
            out.naechste = plusMonate(k.zuletzt, ABSTAND_MONATE[out.abstand]);
            out.aktiv = !istBeendet(k.zuletzt, out.abstand, datenstand);
            if (out.abstand !== k.erkannterAbstand || cents(out.betrag) !== cents(k.letzterBetrag))
                out.korrigiert = true;
        }
        return out;
    });
}

/** Detection + decisions, split the way every surface shows them. */
export function laufendeKostenUebersicht(
    buchungen: readonly LkBuchung[],
    entscheidungen: readonly LkEntscheidung[],
    opts: { datenstand?: string | null } = {},
): LaufendeKostenUebersicht {
    const datenstand = opts.datenstand !== undefined ? opts.datenstand : neuesteBuchung(buchungen);
    const alle = mitEntscheidungen(erkenneLaufendeKosten(buchungen, { datenstand }), entscheidungen, datenstand);
    return {
        datenstand,
        vorschlaege: alle.filter((k) => k.status === 'vorschlag'),
        bestaetigt: alle.filter((k) => k.status === 'bestaetigt'),
        abgelehnt: alle.filter((k) => k.status === 'abgelehnt'),
        beendet: alle.filter((k) => k.status === 'beendet'),
    };
}

/** „N laufende Kosten zu bestätigen" — the Als-Nächstes task and the CLI headline. */
export function zuBestaetigenTitel(n: number): string {
    return n === 1 ? '1 laufende Kosten zu bestätigen' : `${n} laufende Kosten zu bestätigen`;
}

export interface ErwarteteZahlung {
    key: string;
    empfaenger: string;
    datum: string;
    betrag: number;
    abstand: SerienAbstand;
    /** Expected on or before the newest booking, yet not booked — missed, or paid another way. */
    ueberfaellig: boolean;
    /** Expected after the newest booking but before the Stichtag: the import is older than the
     *  Stichtag, so the balance cannot contain it either way. */
    nachDatenstand: boolean;
}

/**
 * The payments a series is expected to make after its last one, up to `stichtag + fensterTage` —
 * the earlier ones included, since the balance (the sum of the imported bookings) does not contain
 * them. `datenstand` (the newest booking) tells a missed payment from one the import cannot know
 * yet. Counted from the last payment in whole intervals, so a 31st stays the month's last day.
 */
export function erwarteteZahlungen(
    lk: LaufendeKosten,
    stichtag: string,
    fensterTage: number,
    datenstand: string | null = null,
): ErwarteteZahlung[] {
    const bis = new Date(`${stichtag}T00:00:00Z`);
    bis.setUTCDate(bis.getUTCDate() + fensterTage);
    const ende = bis.toISOString().slice(0, 10);
    const out: ErwarteteZahlung[] = [];
    const m = ABSTAND_MONATE[lk.abstand];
    for (let n = 1; n <= 400; n++) {
        const datum = plusMonate(lk.zuletzt, n * m);
        if (datum > ende) break;
        out.push({
            key: lk.key,
            empfaenger: lk.empfaenger,
            datum,
            betrag: lk.betrag,
            abstand: lk.abstand,
            ueberfaellig: datum < stichtag && (!datenstand || datum <= datenstand),
            nachDatenstand: datum < stichtag && !!datenstand && datum > datenstand,
        });
    }
    return out;
}

/** The ids of every payment of the given series — the Idee-7 exclusion for „Lieferant doppelt bezahlt". */
export function laufendeKostenIds(serien: readonly LaufendeKosten[]): Set<string> {
    return new Set(serien.flatMap((s) => s.zahlungen.map((z) => z.id)));
}

/**
 * Whether two documents of `partei` over `betrag`, dated `a` and `b`, are two invoices of a confirmed
 * series: same party, the amount within the drift of the series' amount, and `b` one interval after
 * `a` (± {@link SERIE_TOLERANZ_TAGE}). Two copies a few days apart still are a finding.
 */
export function istSerienPaar(
    serien: readonly LaufendeKosten[],
    partei: string | null | undefined,
    betrag: number,
    a: string,
    b: string,
): boolean {
    const [frueh, spaet] = a <= b ? [a, b] : [b, a];
    return serien.some(
        (s) =>
            (gleichePartei(partei, s.empfaenger) || parteiSchluessel(partei) === s.key.split(':')[0]) &&
            Math.abs(Math.abs(betrag) - s.betrag) <= s.betrag * LAUFENDE_KOSTEN_DRIFT_ANTEIL + 0.005 &&
            Math.abs(dayDiff(spaet, plusMonate(frueh, ABSTAND_MONATE[s.abstand])) ?? Infinity) <= SERIE_TOLERANZ_TAGE,
    );
}

const deDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * „Preisänderung bei <Empfänger>" — a confirmed series whose amount changed AFTER it was confirmed (a
 * change before it was on screen when the owner confirmed). One hint per series in the year of the
 * change, bound to the changed payment, so „Als in Ordnung markieren" holds until the next change.
 */
export function preisaenderungHinweise(bestaetigt: readonly LaufendeKosten[], year: number): Hinweis[] {
    const out: Hinweis[] = [];
    for (const lk of bestaetigt) {
        const p = lk.preisaenderung;
        if (!p || Number(p.datum.slice(0, 4)) !== year) continue;
        if (lk.entschiedenAm && p.datum <= lk.entschiedenAm) continue;
        const richtung = p.auf > p.von ? 'teurer' : 'günstiger';
        out.push({
            key: `laufende-kosten-preis:${lk.key}`,
            level: 'tipp',
            title: `Preisänderung bei ${lk.empfaenger}`,
            text:
                `Die laufenden Kosten bei ${lk.empfaenger} (${ABSTAND_TEXT[lk.abstand]}) sind seit ${deDate(p.datum)} ${richtung}: ` +
                `${fmtDe(p.auf)} € statt ${fmtDe(p.von)} €. Zu klären, ob die Änderung vereinbart ist.`,
            status: 'befund',
            betroffen: [
                {
                    art: 'buchung',
                    id: p.id,
                    zeile: buchungZeile({ bookingDate: p.datum, amount: -p.auf, counterparty: lk.empfaenger }),
                },
            ],
            handlungen: [
                { id: 'buchung', label: 'Buchung öffnen', target: { art: 'dialog', dialog: 'buchung', ref: p.id } },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint([lk.key, p.id]),
            begriff: 'laufende-kosten',
        });
    }
    return out;
}
