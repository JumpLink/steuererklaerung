/**
 * „USt-Abweichung" — a Prüfung vor der Abgabe (Idee 10 in docs/ideen-nutzerfuehrung.md): the
 * USt-Zahllast of each Voranmeldungszeitraum against the earlier ones.
 *
 * Every period's Zahllast is the DECLARED value from the filings register where the app knows one,
 * else what the EÜR bookings yield (vereinnahmte USt − Vorsteuer by payment date). A period of the year
 * is compared with the median of up to {@link UST_VERGLEICH_PERIODEN} periods before it, across the
 * year boundary. The hint marks a large deviation and does not judge it: a big order, a big purchase
 * or missing bookings all look the same from here.
 *
 * Thresholds are app choices, not legal numbers (docs/references/tax-sources.md, „Prüfungen vor der
 * Abgabe"). Pure — the caller passes the rows and the register entries.
 */

import { fmtDe as fmt, round2 } from '../lib/money.ts';
import type { EuerKind } from './euer-aggregate.ts';
import {
    buchungZeile,
    capBetroffen,
    HANDLUNG_IN_ORDNUNG,
    hinweisFingerprint,
    type Hinweis,
    type HinweisBetroffen,
} from './hinweise.ts';

/** Share of the reference a Zahllast may deviate by before it is marked. App choice. */
export const UST_ABWEICHUNG_ANTEIL = 0.5;
/** …and at least this many euros, so small quarters do not flicker. App choice. */
export const UST_ABWEICHUNG_MIN_EUR = 250;
/** How many earlier periods form the reference (their median). */
export const UST_VERGLEICH_PERIODEN = 4;
/** Fewer earlier periods than this: the period is not checked. */
export const UST_VERGLEICH_MIN = 2;
/** Largest USt items listed per marked period. */
const POSTEN_JE_ZEITRAUM = 5;

export type UstRhythmus = 'monat' | 'quartal';

/** One EÜR row as the check needs it (`EuerTxDetailRow`). */
export interface UstZeile {
    id: string;
    accountKey?: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    kind: EuerKind;
    /** Signed VAT contribution: + for collected USt on income, + for Vorsteuer on an expense. */
    vat: number;
}

/** A filed Voranmeldung from the register: period `2026-Q2` or `2026-03`, declared Zahllast. */
export interface ErklaerteVoranmeldung {
    period: string;
    zahllast: number;
}

export interface UstZeitraum {
    /** `2026-Q2` or `2026-03` — the register's period key. */
    key: string;
    /** First and last day. */
    von: string;
    bis: string;
    zahllast: number;
    quelle: 'erklaert' | 'berechnet';
    /** The rows that fall into the period. */
    ids: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The period a date belongs to, as the register keys it. */
export function zeitraumVon(date: string, rhythmus: UstRhythmus): string {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    return rhythmus === 'quartal' ? `${y}-Q${Math.ceil(m / 3)}` : `${y}-${pad(m)}`;
}

/** `2026-Q2` → „Q2/2026", `2026-03` → „03/2026". */
export function zeitraumLabel(key: string): string {
    const [y, p] = key.split('-');
    return `${p}/${y}`;
}

function grenzen(key: string): { von: string; bis: string } {
    const y = Number(key.slice(0, 4));
    const q = /-Q(\d)$/.exec(key);
    const ersterMonat = q ? (Number(q[1]) - 1) * 3 + 1 : Number(key.slice(5, 7));
    const letzterMonat = q ? ersterMonat + 2 : ersterMonat;
    const letzterTag = new Date(Date.UTC(y, letzterMonat, 0)).getUTCDate();
    return { von: `${y}-${pad(ersterMonat)}-01`, bis: `${y}-${pad(letzterMonat)}-${pad(letzterTag)}` };
}

/**
 * The periods with data: every period a row falls into or the register holds a filing for. Year-end
 * adjustments (AfA, Privatanteile) are no Voranmeldung matter and stay out.
 */
export function ustZeitraeume(i: {
    zeilen: readonly UstZeile[];
    erklaert: readonly ErklaerteVoranmeldung[];
    rhythmus: UstRhythmus;
}): UstZeitraum[] {
    const byKey = new Map<string, UstZeitraum>();
    const get = (key: string): UstZeitraum => {
        let z = byKey.get(key);
        if (!z) {
            z = { key, ...grenzen(key), zahllast: 0, quelle: 'berechnet', ids: [] };
            byKey.set(key, z);
        }
        return z;
    };
    for (const r of i.zeilen) {
        if (r.accountKey === 'adjustment' || r.kind === 'neutral' || !/^\d{4}-\d{2}/.test(r.bookingDate)) continue;
        const z = get(zeitraumVon(r.bookingDate, i.rhythmus));
        z.ids.push(r.id);
        z.zahllast = round2(z.zahllast + (r.kind === 'income' ? r.vat : -r.vat));
    }
    const muster = i.rhythmus === 'quartal' ? /^\d{4}-Q[1-4]$/ : /^\d{4}-\d{2}$/;
    for (const f of i.erklaert) {
        if (!muster.test(f.period)) continue;
        const z = get(f.period);
        z.zahllast = round2(f.zahllast);
        z.quelle = 'erklaert';
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : round2((s[m - 1] + s[m]) / 2);
}

export interface UstAbweichungInput {
    year: number;
    /** Periods of this AND earlier years ({@link ustZeitraeume}). */
    zeitraeume: readonly UstZeitraum[];
    /** The rows behind them — the largest USt items of a marked period become `betroffen`. */
    zeilen: readonly UstZeile[];
    /** YYYY-MM-DD: a period that has not ended by then is still running and not checked. */
    today: string;
    /** Collects no USt (Kleinunternehmer): no Voranmeldungen to compare. */
    kleinunternehmer?: boolean;
}

export function pruefeUstAbweichung(i: UstAbweichungInput): Hinweis[] {
    const basis = { key: 'ust-abweichung', level: 'info' as const, ref: '§ 18 Abs. 1 UStG' };
    if (i.kleinunternehmer) {
        return [
            {
                ...basis,
                title: 'USt-Abweichung: nicht prüfbar',
                text: 'Die Entität weist keine Umsatzsteuer aus.',
                status: 'nicht_pruefbar',
                weil: 'als Kleinunternehmer keine regelmäßigen Voranmeldungen zum Vergleich vorliegen',
            },
        ];
    }
    const jahr = String(i.year);
    const zuPruefen = i.zeitraeume.filter((z) => z.key.startsWith(jahr) && z.bis <= i.today);
    const geprueft: { z: UstZeitraum; ref: number; n: number }[] = [];
    for (const z of zuPruefen) {
        const davor = i.zeitraeume.filter((x) => x.key < z.key).slice(-UST_VERGLEICH_PERIODEN);
        if (davor.length < UST_VERGLEICH_MIN) continue;
        geprueft.push({ z, ref: median(davor.map((x) => x.zahllast)), n: davor.length });
    }
    if (geprueft.length === 0) {
        return [
            {
                ...basis,
                title: 'USt-Abweichung: nicht prüfbar',
                text: zuPruefen.length
                    ? `${zuPruefen.length} abgeschlossene(r) Zeitraum/Zeiträume ${i.year}, aber zu wenig Verlauf davor.`
                    : `Kein abgeschlossener Voranmeldungszeitraum ${i.year} mit Buchungen oder Register-Eintrag.`,
                status: 'nicht_pruefbar',
                weil: `weniger als ${UST_VERGLEICH_MIN} frühere Voranmeldungszeiträume zum Vergleich vorliegen`,
            },
        ];
    }

    const auffaellig = geprueft.filter(({ z, ref }) => {
        const abw = Math.abs(z.zahllast - ref);
        return abw > Math.max(UST_ABWEICHUNG_ANTEIL * Math.abs(ref), UST_ABWEICHUNG_MIN_EUR);
    });
    if (auffaellig.length === 0) {
        return [
            {
                ...basis,
                title: 'USt-Abweichung: nichts auffällig',
                text: `${geprueft.length} Voranmeldungszeitraum/-zeiträume ${i.year} mit den früheren verglichen.`,
                status: 'ohne_befund',
                geprueft:
                    `Zahllast je Zeitraum gegen den Median der bis zu ${UST_VERGLEICH_PERIODEN} Zeiträume davor; markiert ab ` +
                    `${UST_ABWEICHUNG_ANTEIL * 100} % und mindestens ${fmt(UST_ABWEICHUNG_MIN_EUR)} € Abweichung; erklärte ` +
                    'Werte aus dem Register vor berechneten',
            },
        ];
    }

    const byId = new Map(i.zeilen.map((r) => [r.id, r]));
    const betroffen: HinweisBetroffen[] = [];
    const zeilen: string[] = [];
    for (const { z, ref, n } of auffaellig) {
        const abw = round2(z.zahllast - ref);
        zeilen.push(
            `${zeitraumLabel(z.key)}: ${fmt(z.zahllast)} € (${z.quelle === 'erklaert' ? 'erklärt' : 'berechnet'}), ` +
                `sonst um ${fmt(ref)} € (Median aus ${n} Zeiträumen davor) — ${abw > 0 ? '+' : ''}${fmt(abw)} €`,
        );
        const posten = z.ids
            .map((id) => byId.get(id))
            .filter((r): r is UstZeile => r != null && Math.abs(r.vat) > 0.005)
            .sort((a, b) => Math.abs(b.vat) - Math.abs(a.vat) || a.id.localeCompare(b.id))
            .slice(0, POSTEN_JE_ZEITRAUM);
        for (const r of posten) {
            betroffen.push({ art: 'buchung', id: r.id, zeile: `${buchungZeile(r)} · USt ${fmt(r.vat)} €` });
        }
    }
    return [
        {
            ...basis,
            level: 'tipp',
            title: `USt-Zahllast weicht ab: ${auffaellig.map(({ z }) => zeitraumLabel(z.key)).join(', ')}`,
            text:
                `${zeilen.join('. ')}. Vermutlich ein großer Auftrag, eine große Anschaffung oder fehlende Buchungen — ` +
                'zu klären, ob der Zeitraum vollständig ist. Die App bewertet die Abweichung nicht; darunter die größten USt-Posten.',
            status: 'befund',
            ...capBetroffen(betroffen),
            handlungen: [
                { id: 'buchungen', label: 'Buchungen öffnen', target: { art: 'ansicht', ansicht: 'buchungen' } },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(auffaellig.map(({ z }) => `${z.key}:${Math.round(z.zahllast * 100)}`)),
        },
    ];
}
