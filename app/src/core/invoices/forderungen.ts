/**
 * Offene Forderungen (Idee 12) — what customers owe and how they pay, from the app's OWN data only:
 * the outgoing invoices and the credits already matched to them.
 *
 *  - {@link zahlungsverhalten}: per customer, payment date − due date over the paid invoices.
 *  - {@link offenePosten} + {@link altersUebersicht}: the open items by age.
 *  - Mahnstufe: how far an invoice has been reminded (the owner confirms every „versandt").
 *  - {@link verjaehrung}: the regular three-year limitation, „Handeln bis 31.12.YYYY".
 *
 * PURE on purpose: invoices, payments and reminder records come in, figures go out — no store, no
 * config, no network, no clock (`today` is a parameter). Amounts are EUR as plain numbers (like the
 * store); comparisons run on integer cents. The thresholds are App-Wahl and listed in
 * docs/references/tax-sources.md, „Offene Forderungen"; the limitation rule is law (§§ 195, 199 BGB)
 * and sourced there with its retrieval date.
 */

import { normalizeInvoiceStatus } from './status.ts';

/** The slice of an outgoing invoice the Forderungen need. */
export interface ForderungRechnung {
    id: string;
    number: string | null;
    /** Customer display name; invoices without one are grouped under „Ohne Kunde". */
    customer: string | null;
    gross: number;
    currency: string;
    issueDate: string | null;
    dueDate: string | null;
    /** Raw back-end status (normalised here). */
    status: string;
    /** The date the invoice was marked paid, when the back-end records one. */
    paidOn: string | null;
}

/** A credit (money in) the matcher assigned to ONE invoice. */
export interface ForderungZahlung {
    rechnungId: string;
    date: string;
    amount: number;
}

export type Mahnstufe = 0 | 1 | 2 | 3;

/** What the ledger holds per (invoice, stage). */
export interface ForderungMahnung {
    rechnungId: string;
    stufe: 1 | 2 | 3;
    /** ISO timestamp of the last draft. */
    entworfenAm: string | null;
    /** YYYY-MM-DD the owner confirmed it as sent. */
    versandtAm: string | null;
}

// ── App-Wahl (docs/references/tax-sources.md, „Offene Forderungen") ───────────────────────────────

/** Trend: the last 2 paid invoices of a customer are compared with all earlier ones … */
export const TREND_LETZTE = 2;
/** … but only when at least 2 earlier ones exist (so ≥ 4 paid invoices), else „zu wenig Zahlungen". */
export const TREND_FRUEHER_MIN = 2;
/** The recent mean must differ from the earlier mean by at least this many days to count as a trend. */
export const TREND_SCHWELLE_TAGE = 3;
/** Between two reminders at least this many days must pass before the next stage is due. */
export const MAHNUNG_ABSTAND_TAGE = 14;
/** The payment deadline a reminder draft sets, counted from the draft date. */
export const MAHNUNG_FRIST_TAGE = 7;
/** Verjährung is flagged this many days before 31 December of the deadline year (≈ 6 months). */
export const VERJAEHRUNG_WARNFENSTER_TAGE = 180;
/** Regular limitation period in years — § 195 BGB (law, not App-Wahl). */
export const VERJAEHRUNG_JAHRE = 3;

const cents = (n: number): number => Math.round(n * 100);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const TOLERANCE_CENTS = 1;

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function tageZwischen(from: string, to: string): number {
    const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
    return Math.round((b - a) / 86_400_000);
}

// ── Zahlungsverhalten ─────────────────────────────────────────────────────────────────────────────

export type ZahlungsTrend = 'langsamer' | 'schneller' | 'gleich';

/** One paid invoice with the days it was paid after (negative: before) its due date. */
export interface Zahlungsdauer {
    rechnungId: string;
    nummer: string | null;
    /** YYYY-MM-DD the invoice counts as settled. */
    bezahltAm: string;
    tage: number;
    /** True when the settling date came from partial payments adding up, not from a „bezahlt" date. */
    ausTeilzahlungen: boolean;
}

export interface KundenVerhalten {
    kunde: string;
    anzahl: number;
    /** Mean days after the due date (1 decimal); negative = on average early. */
    mittel: number;
    /** The longest delay (most days after the due date); the least early one when nobody was late. */
    schlimmster: number;
    /** Null while there are too few paid invoices to compare (see {@link TREND_FRUEHER_MIN}). */
    trend: ZahlungsTrend | null;
    /** Mean of the {@link TREND_LETZTE} latest, when a trend exists. */
    mittelLetzte: number | null;
    /** Mean of the earlier ones, when a trend exists. */
    mittelFrueher: number | null;
}

const OHNE_KUNDE = 'Ohne Kunde';

function kundenName(customer: string | null): string {
    return customer?.trim() || OHNE_KUNDE;
}

function kundenSchluessel(customer: string | null): string {
    return kundenName(customer).toLowerCase();
}

function zahlungenJeRechnung(zahlungen: readonly ForderungZahlung[]): Map<string, ForderungZahlung[]> {
    const map = new Map<string, ForderungZahlung[]>();
    for (const z of zahlungen) {
        const list = map.get(z.rechnungId) ?? [];
        list.push(z);
        map.set(z.rechnungId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    return map;
}

/** Σ of the payments in cents. */
function summeCents(list: readonly ForderungZahlung[] | undefined): number {
    return (list ?? []).reduce((s, z) => s + cents(z.amount), 0);
}

/**
 * The date a PAID invoice counts as settled. An explicit „bezahlt" date wins (the owner said so);
 * without one, the payment that brought the sum of the matched credits up to the invoice amount —
 * a partial payment alone never settles an invoice; if the credits never reach it, the latest one.
 * Null when nothing dates it (the invoice is then left out of the statistics).
 */
function abschlussdatum(
    inv: ForderungRechnung,
    zahlungen: readonly ForderungZahlung[] | undefined,
): Pick<Zahlungsdauer, 'bezahltAm' | 'ausTeilzahlungen'> | null {
    if (inv.paidOn) return { bezahltAm: inv.paidOn.slice(0, 10), ausTeilzahlungen: false };
    if (!zahlungen?.length) return null;
    const gross = cents(inv.gross);
    let running = 0;
    for (const z of zahlungen) {
        running += cents(z.amount);
        if (running >= gross - TOLERANCE_CENTS) return { bezahltAm: z.date.slice(0, 10), ausTeilzahlungen: true };
    }
    return { bezahltAm: zahlungen[zahlungen.length - 1].date.slice(0, 10), ausTeilzahlungen: true };
}

/** Days after the due date for every paid invoice that has both a due date and a settling date. */
export function zahlungsdauern(
    rechnungen: readonly ForderungRechnung[],
    zahlungen: readonly ForderungZahlung[],
): Map<string, Zahlungsdauer[]> {
    const jeRechnung = zahlungenJeRechnung(zahlungen);
    const out = new Map<string, Zahlungsdauer[]>();
    for (const inv of rechnungen) {
        if (normalizeInvoiceStatus(inv.status) !== 'paid' || !inv.dueDate) continue;
        const done = abschlussdatum(inv, jeRechnung.get(inv.id));
        if (!done) continue;
        const key = kundenSchluessel(inv.customer);
        const list = out.get(key) ?? [];
        list.push({
            rechnungId: inv.id,
            nummer: inv.number,
            bezahltAm: done.bezahltAm,
            tage: tageZwischen(inv.dueDate, done.bezahltAm),
            ausTeilzahlungen: done.ausTeilzahlungen,
        });
        out.set(key, list);
    }
    return out;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Per customer: mean, worst case and trend of the payment delay. Slowest mean first. */
export function zahlungsverhalten(
    rechnungen: readonly ForderungRechnung[],
    zahlungen: readonly ForderungZahlung[],
): KundenVerhalten[] {
    const names = new Map<string, string>();
    for (const inv of rechnungen) {
        const key = kundenSchluessel(inv.customer);
        if (!names.has(key)) names.set(key, kundenName(inv.customer));
    }
    const out: KundenVerhalten[] = [];
    for (const [key, liste] of zahlungsdauern(rechnungen, zahlungen)) {
        const sortiert = [...liste].sort(
            (a, b) => a.bezahltAm.localeCompare(b.bezahltAm) || a.rechnungId.localeCompare(b.rechnungId),
        );
        const tage = sortiert.map((d) => d.tage);
        let trend: ZahlungsTrend | null = null;
        let mittelLetzte: number | null = null;
        let mittelFrueher: number | null = null;
        if (tage.length >= TREND_LETZTE + TREND_FRUEHER_MIN) {
            const letzte = tage.slice(-TREND_LETZTE);
            const frueher = tage.slice(0, -TREND_LETZTE);
            mittelLetzte = round1(mean(letzte));
            mittelFrueher = round1(mean(frueher));
            const diff = mean(letzte) - mean(frueher);
            trend = diff >= TREND_SCHWELLE_TAGE ? 'langsamer' : diff <= -TREND_SCHWELLE_TAGE ? 'schneller' : 'gleich';
        }
        out.push({
            kunde: names.get(key) ?? key,
            anzahl: tage.length,
            mittel: round1(mean(tage)),
            schlimmster: Math.max(...tage),
            trend,
            mittelLetzte,
            mittelFrueher,
        });
    }
    return out.sort((a, b) => b.mittel - a.mittel || a.kunde.localeCompare(b.kunde));
}

// ── Verjährung ────────────────────────────────────────────────────────────────────────────────────

export type VerjaehrungStatus = 'laufend' | 'bald' | 'verjaehrt';

export interface Verjaehrung {
    /** The year the claim is taken to have arisen in (see {@link verjaehrung}). */
    anspruchsjahr: number;
    /** „Handeln bis" — 31 December of the third year after, YYYY-MM-DD. */
    handelnBis: string;
    /** Days from today until `handelnBis` (negative once it has passed). */
    tageBis: number;
    status: VerjaehrungStatus;
}

/**
 * The regular limitation of an invoice claim: three years (§ 195 BGB), starting at the END of the
 * year in which the claim arose (§ 199 Abs. 1 BGB) — so a claim of any day in 2023 runs out with
 * 31.12.2026, and that day itself is still „Handeln bis".
 *
 * The year of arising is the EARLIER of issue date and due date: that can only bring the date
 * forward, never push it past the real one (a December invoice due in January is the case where the
 * law may allow a year more). Without either date there is nothing to compute. Hemmung and Neubeginn
 * (§§ 203 ff., 212 BGB) are not tracked, so the date is „vermutlich".
 */
export function verjaehrung(
    rechnung: Pick<ForderungRechnung, 'issueDate' | 'dueDate'>,
    today: string,
): Verjaehrung | null {
    const jahre = [rechnung.issueDate, rechnung.dueDate]
        .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d))
        .map((d) => Number(d.slice(0, 4)));
    if (jahre.length === 0) return null;
    const anspruchsjahr = Math.min(...jahre);
    const handelnBis = `${anspruchsjahr + VERJAEHRUNG_JAHRE}-12-31`;
    const tageBis = tageZwischen(today, handelnBis);
    const status: VerjaehrungStatus =
        tageBis < 0 ? 'verjaehrt' : tageBis <= VERJAEHRUNG_WARNFENSTER_TAGE ? 'bald' : 'laufend';
    return { anspruchsjahr, handelnBis, tageBis, status };
}

// ── Offene Posten nach Alter ──────────────────────────────────────────────────────────────────────

export type AlterKlasse = 'nicht_faellig' | 'tage_1_30' | 'tage_31_60' | 'tage_61_90' | 'ueber_90';

export const ALTER_KLASSEN: { key: AlterKlasse; label: string }[] = [
    { key: 'nicht_faellig', label: 'Noch nicht fällig' },
    { key: 'tage_1_30', label: '1–30 Tage überfällig' },
    { key: 'tage_31_60', label: '31–60 Tage überfällig' },
    { key: 'tage_61_90', label: '61–90 Tage überfällig' },
    { key: 'ueber_90', label: 'Über 90 Tage überfällig' },
];

/** `tage` = days past the due date; ≤ 0 (or no due date at all) is „noch nicht fällig". */
export function alterKlasse(tage: number | null): AlterKlasse {
    if (tage == null || tage <= 0) return 'nicht_faellig';
    if (tage <= 30) return 'tage_1_30';
    if (tage <= 60) return 'tage_31_60';
    if (tage <= 90) return 'tage_61_90';
    return 'ueber_90';
}

export interface OffenerPosten {
    rechnungId: string;
    nummer: string | null;
    kunde: string;
    currency: string;
    /** The invoice amount. */
    brutto: number;
    /** Received so far on credits matched to the invoice (partial payments). */
    bezahlt: number;
    /** What is still owed: `brutto − bezahlt`. Ageing and sums run on this. */
    offen: number;
    issueDate: string | null;
    dueDate: string | null;
    /** Days past the due date; ≤ 0 = not yet due; null without a due date. */
    tageUeberfaellig: number | null;
    alter: AlterKlasse;
    /** The highest stage the owner confirmed as sent; 0 = none. */
    mahnstufe: Mahnstufe;
    /** YYYY-MM-DD of that confirmation. */
    letzteMahnungAm: string | null;
    /** The stage drafted but not (yet) confirmed, if any. */
    entworfenStufe: 1 | 2 | 3 | null;
    /** The stage a new draft would be; null once the last stage went out. */
    naechsteStufe: 1 | 2 | 3 | null;
    /** Overdue, a next stage exists, and the gap to the last reminder has passed. */
    mahnungFaellig: boolean;
    verjaehrung: Verjaehrung | null;
}

export interface Forderungen {
    heute: string;
    posten: OffenerPosten[];
    /** Open invoices whose matched credits already cover the amount but which nobody marked paid. */
    vermutlichBezahlt: { rechnungId: string; nummer: string | null; kunde: string; brutto: number }[];
}

const nextStage = (m: Mahnstufe): 1 | 2 | 3 | null => (m >= 3 ? null : ((m + 1) as 1 | 2 | 3));

/**
 * The open invoices with age, reminder state and Verjährung. Open means status `open` (drafts and
 * cancelled invoices are no claim) with a positive amount. Credits matched to an invoice reduce what
 * is owed — a PARTIAL payment keeps the invoice open for the rest and is named in the reminder; if
 * the credits cover the whole amount, the invoice goes to `vermutlichBezahlt` instead of being
 * chased. Most overdue first.
 */
export function offenePosten(
    rechnungen: readonly ForderungRechnung[],
    zahlungen: readonly ForderungZahlung[],
    mahnungen: readonly ForderungMahnung[],
    today: string,
): Forderungen {
    const jeRechnung = zahlungenJeRechnung(zahlungen);
    const posten: OffenerPosten[] = [];
    const vermutlichBezahlt: Forderungen['vermutlichBezahlt'] = [];
    for (const inv of rechnungen) {
        if (normalizeInvoiceStatus(inv.status) !== 'open' || !(inv.gross > 0)) continue;
        const bezahltCents = summeCents(jeRechnung.get(inv.id));
        if (bezahltCents >= cents(inv.gross) - TOLERANCE_CENTS) {
            vermutlichBezahlt.push({
                rechnungId: inv.id,
                nummer: inv.number,
                kunde: kundenName(inv.customer),
                brutto: inv.gross,
            });
            continue;
        }
        const tage = inv.dueDate ? tageZwischen(inv.dueDate, today) : null;
        const eigene = mahnungen.filter((m) => m.rechnungId === inv.id);
        const versandt = eigene.filter((m) => m.versandtAm).sort((a, b) => b.stufe - a.stufe);
        const mahnstufe = (versandt[0]?.stufe ?? 0) as Mahnstufe;
        const letzte =
            versandt
                .map((m) => m.versandtAm as string)
                .sort()
                .pop() ?? null;
        const entworfen = eigene
            .filter((m) => !m.versandtAm && m.entworfenAm && m.stufe > mahnstufe)
            .sort((a, b) => b.stufe - a.stufe)[0];
        const naechste = nextStage(mahnstufe);
        const ueberfaellig = tage != null && tage > 0;
        const abstandOk = letzte == null || tageZwischen(letzte, today) >= MAHNUNG_ABSTAND_TAGE;
        posten.push({
            rechnungId: inv.id,
            nummer: inv.number,
            kunde: kundenName(inv.customer),
            currency: inv.currency,
            brutto: round2(inv.gross),
            bezahlt: round2(bezahltCents / 100),
            offen: round2((cents(inv.gross) - bezahltCents) / 100),
            issueDate: inv.issueDate,
            dueDate: inv.dueDate,
            tageUeberfaellig: tage,
            alter: alterKlasse(tage),
            mahnstufe,
            letzteMahnungAm: letzte,
            entworfenStufe: entworfen ? entworfen.stufe : null,
            naechsteStufe: naechste,
            mahnungFaellig: ueberfaellig && naechste != null && abstandOk,
            verjaehrung: verjaehrung(inv, today),
        });
    }
    posten.sort(
        (a, b) =>
            (b.tageUeberfaellig ?? -1e9) - (a.tageUeberfaellig ?? -1e9) ||
            (a.nummer ?? '').localeCompare(b.nummer ?? ''),
    );
    return { heute: today, posten, vermutlichBezahlt };
}

export interface AlterSumme {
    key: AlterKlasse;
    label: string;
    anzahl: number;
    summe: number;
}

export interface AlterJeKunde {
    kunde: string;
    summen: Record<AlterKlasse, number>;
    gesamt: number;
}

export interface AltersUebersicht {
    klassen: AlterSumme[];
    kunden: AlterJeKunde[];
    gesamt: { anzahl: number; summe: number };
}

const leereSummen = (): Record<AlterKlasse, number> => ({
    nicht_faellig: 0,
    tage_1_30: 0,
    tage_31_60: 0,
    tage_61_90: 0,
    ueber_90: 0,
});

/** Sums per age bucket, per customer within each bucket, and in total. Customers by what they owe, most first. */
export function altersUebersicht(posten: readonly OffenerPosten[]): AltersUebersicht {
    const klassen: AlterSumme[] = ALTER_KLASSEN.map((k) => ({ ...k, anzahl: 0, summe: 0 }));
    const jeKunde = new Map<string, AlterJeKunde>();
    let anzahl = 0;
    let summe = 0;
    for (const p of posten) {
        const klasse = klassen.find((k) => k.key === p.alter) as AlterSumme;
        klasse.anzahl += 1;
        klasse.summe = round2(klasse.summe + p.offen);
        const zeile = jeKunde.get(p.kunde) ?? { kunde: p.kunde, summen: leereSummen(), gesamt: 0 };
        zeile.summen[p.alter] = round2(zeile.summen[p.alter] + p.offen);
        zeile.gesamt = round2(zeile.gesamt + p.offen);
        jeKunde.set(p.kunde, zeile);
        anzahl += 1;
        summe = round2(summe + p.offen);
    }
    const kunden = [...jeKunde.values()].sort((a, b) => b.gesamt - a.gesamt || a.kunde.localeCompare(b.kunde));
    return { klassen, kunden, gesamt: { anzahl, summe } };
}

/** The open items that are overdue — what „N Forderungen überfällig" counts. */
export function ueberfaellige(posten: readonly OffenerPosten[]): OffenerPosten[] {
    return posten.filter((p) => (p.tageUeberfaellig ?? 0) > 0);
}

/** „1 Forderung überfällig" / „3 Forderungen überfällig". */
export function forderungenTitel(n: number): string {
    return n === 1 ? '1 Forderung überfällig' : `${n} Forderungen überfällig`;
}

/** Whether a Verjährung warning (soon or already passed) applies to the item. */
export function verjaehrungDroht(p: Pick<OffenerPosten, 'verjaehrung'>): boolean {
    return p.verjaehrung?.status === 'bald' || p.verjaehrung?.status === 'verjaehrt';
}
