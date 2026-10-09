/**
 * Splitbuchung (Idee 13 in docs/ideen-nutzerfuehrung.md): one booking split into parts, each with its
 * own amount, category and VAT rate. One part always takes the remainder, so the parts add up to the
 * booking to the cent. For a mixed order (business + private), a Bewirtung (70 % abziehbar) or a phone
 * bill used partly in private.
 *
 * The split is an overlay over the UNCHANGED bank transaction: the parts live in the ledger
 * (`booking_splits`), and the EÜR aggregate books each part under its own category
 * (`aufteilungen` in euer-transactions.ts). Tax treatment and sources: docs/references/tax-sources.md,
 * „Splitbuchung".
 *
 * Pure: amounts, categories and register entries in, parts and sentences out.
 */

import { fmtDe as fmt, round2 } from '../lib/money.ts';
import { ACCOUNTING_CATEGORY_OPTIONS } from '../lib/select-field-constants.ts';
import { NEUTRAL_MIT_VORSTEUER, SKR03_TO_EUER, type EuerKind } from './euer-aggregate.ts';
import { impliedRate } from './euer-classify.ts';
import { zeitraumLabel, zeitraumVon } from './ust-abweichung.ts';

/** The private part of a mixed booking: an Entnahme, no Betriebsausgabe, no Vorsteuer (§ 12 Nr. 1 EStG, § 15 Abs. 1 UStG). */
export const PRIVAT_KATEGORIE = '1800 Privatentnahme';
/** The deductible share of a Bewirtung. */
export const BEWIRTUNG_KATEGORIE = '4654 Bewirtungskosten';
/** The share of a Bewirtung that may not reduce the profit, whose Vorsteuer still counts (§ 15 Abs. 1a Satz 2 UStG). */
export const BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE = '4654 Nicht abziehbare Bewirtungskosten';
/** § 4 Abs. 5 Satz 1 Nr. 2 EStG: 70 % of an appropriate, documented Bewirtung are deductible. */
export const BEWIRTUNG_ABZIEHBAR_ANTEIL = 0.7;
/** The rates a part may carry: 0, ermäßigt and regulär (§ 12 Abs. 1 und 2 UStG). */
export const STEUERSAETZE: readonly number[] = [0, 0.07, 0.19];

/**
 * The categories a part may take: the booking categories without the ones no bank payment is split
 * into (AfA is computed, USt-Zahllast and Gewerbesteuer are whole payments to the Finanzamt), plus the
 * non-deductible Bewirtung, which only exists as a part.
 */
export const AUFTEILUNG_KATEGORIEN: readonly string[] = [
    ...ACCOUNTING_CATEGORY_OPTIONS.filter(
        (c) =>
            !['4830 Abschreibungen (AfA)', '1789 Umsatzsteuer-Zahllast (Finanzamt)', '2150 Gewerbesteuer'].includes(c),
    ),
    BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE,
];

/** One part as entered: `betrag` is the gross in EUR (positive); the remainder part has none. */
export interface TeilEingabe {
    category: string;
    betrag?: number | null;
    /** VAT rate as a fraction (0.19). Omitted: the receipt's rate, else the category's. */
    vatRate?: number | null;
    /** Marks the part that takes what is left. At most one; without one, the part without amount. */
    rest?: boolean;
    note?: string | null;
}

/** One part, computed: positive gross, its net and VAT by rate, and how the EÜR treats it. */
export interface Teil {
    nr: number;
    category: string;
    kind: EuerKind;
    betrag: number;
    vatRate: number;
    rest: boolean;
    net: number;
    vat: number;
    /** False for a private part: it is no Betriebsausgabe and its VAT is no Vorsteuer. */
    betrieblich: boolean;
    note?: string;
}

/** A split that cannot be stored, with the sentence the surface shows. */
export class AufteilungFehler extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AufteilungFehler';
    }
}

const cents = (n: number) => Math.round(n * 100);

/** „aufgeteilt in 2 Teile" — the origin a split booking shows wherever a rule name would stand. */
export function aufteilungTitel(n: number): string {
    return `aufgeteilt in ${n} Teile`;
}

/** Whether a part of this category is private money: neutral, and its VAT is not deductible. */
export function istPrivatTeil(category: string): boolean {
    return SKR03_TO_EUER[category]?.kind === 'neutral' && !NEUTRAL_MIT_VORSTEUER.has(category);
}

function standardSatz(category: string, kind: EuerKind, belegSatz: number | undefined): number {
    if (kind === 'neutral') return NEUTRAL_MIT_VORSTEUER.has(category) ? (belegSatz ?? 0.19) : (belegSatz ?? 0);
    const implied = impliedRate(category, kind);
    return implied === 0 ? 0 : (belegSatz ?? implied);
}

/**
 * Validate the parts against the booking and compute them. `amount` is the booking's signed amount: a
 * debit takes expense and neutral categories, a credit income and neutral ones. Throws
 * {@link AufteilungFehler} with a sentence for the surface. `belegSatz` is the receipt's VAT rate, the
 * default for a part without one.
 */
export function berechneTeile(
    amount: number,
    eingaben: readonly TeilEingabe[],
    opts: { belegSatz?: number } = {},
): Teil[] {
    const gesamt = cents(Math.abs(amount));
    if (gesamt === 0) throw new AufteilungFehler('Eine Buchung über 0 € lässt sich nicht aufteilen.');
    if (eingaben.length < 2) throw new AufteilungFehler('Eine Aufteilung braucht mindestens zwei Teile.');

    let restIndex = eingaben.findIndex((t) => t.rest);
    if (eingaben.filter((t) => t.rest).length > 1) {
        throw new AufteilungFehler('Nur ein Teil kann den Rest nehmen.');
    }
    if (restIndex < 0) {
        const ohneBetrag = eingaben.map((t, i) => (t.betrag == null ? i : -1)).filter((i) => i >= 0);
        if (ohneBetrag.length > 1)
            throw new AufteilungFehler('Nur ein Teil darf ohne Betrag bleiben — er nimmt den Rest.');
        restIndex = ohneBetrag[0] ?? eingaben.length - 1;
    }

    const debit = amount < 0;
    let fest = 0;
    const roh = eingaben.map((t, i) => {
        const nr = i + 1;
        const category = t.category?.trim() ?? '';
        const meta = SKR03_TO_EUER[category];
        if (!meta || !AUFTEILUNG_KATEGORIEN.includes(category)) {
            throw new AufteilungFehler(`Teil ${nr}: „${category || '—'}" ist keine Kategorie für einen Teil.`);
        }
        if (meta.kind !== 'neutral' && (meta.kind === 'income') === debit) {
            throw new AufteilungFehler(
                `Teil ${nr}: ${category} ist ${meta.kind === 'income' ? 'eine Einnahme' : 'eine Ausgabe'}, die Buchung ${debit ? 'eine Ausgabe' : 'eine Einnahme'}.`,
            );
        }
        const vatRate = t.vatRate ?? standardSatz(category, meta.kind, opts.belegSatz);
        if (!STEUERSAETZE.some((s) => Math.abs(s - vatRate) < 1e-9)) {
            throw new AufteilungFehler(
                `Teil ${nr}: Steuersatz ${round2(vatRate * 100)} % gibt es nicht (0, 7 oder 19 %).`,
            );
        }
        let c = 0;
        if (i !== restIndex || t.betrag != null) {
            const b = t.betrag;
            if (b == null || !Number.isFinite(b)) throw new AufteilungFehler(`Teil ${nr}: Betrag fehlt.`);
            if (b < 0) {
                throw new AufteilungFehler(
                    `Teil ${nr}: Beträge positiv eingeben — ob Ausgabe oder Einnahme, sagt die Buchung.`,
                );
            }
            if (Math.abs(b * 100 - Math.round(b * 100)) > 1e-6) {
                throw new AufteilungFehler(`Teil ${nr}: höchstens zwei Nachkommastellen.`);
            }
            c = cents(b);
            if (c === 0) throw new AufteilungFehler(`Teil ${nr}: ein Teil über 0 € ist kein Teil.`);
            if (i !== restIndex) fest += c;
        }
        return { nr, category, kind: meta.kind, vatRate, cents: c, note: t.note ?? undefined };
    });

    const restCents = gesamt - fest;
    const restNr = restIndex + 1;
    if (restCents < 0) {
        throw new AufteilungFehler(`Die Teile ergeben ${fmt(fest / 100)} €, die Buchung nur ${fmt(gesamt / 100)} €.`);
    }
    if (restCents === 0) {
        throw new AufteilungFehler(`Für den Rest (Teil ${restNr}) bleibt nichts — dann ist es ein Teil weniger.`);
    }
    // A remainder part that came with an amount (all parts filled in) must match what is left.
    const restAngabe = roh[restIndex].cents;
    if (restAngabe !== 0 && restAngabe !== restCents) {
        throw new AufteilungFehler(
            `Die Teile ergeben ${fmt((fest + restAngabe) / 100)} €, die Buchung ${fmt(gesamt / 100)} €.`,
        );
    }

    return roh.map((r, i) => {
        const betrag = (i === restIndex ? restCents : r.cents) / 100;
        const net = r.vatRate > 0 ? round2(betrag / (1 + r.vatRate)) : betrag;
        return {
            nr: r.nr,
            category: r.category,
            kind: r.kind,
            betrag,
            vatRate: r.vatRate,
            rest: i === restIndex,
            net,
            vat: round2(betrag - net),
            betrieblich: !istPrivatTeil(r.category),
            ...(r.note ? { note: r.note } : {}),
        };
    });
}

/**
 * One part from its short text form (CLI `--teil`): `<Kategorie>[=<Betrag>][@<Satz %>]`. Without an
 * amount it is the remainder part. The category may be its number alone when that is unique
 * („4930"); the amount takes a German or an English decimal mark („59,50", „59.50").
 */
export function teilAusText(text: string): TeilEingabe {
    const m = /^([^=@]+?)\s*(?:=\s*([^@]*?))?\s*(?:@\s*([\d.,]+)\s*%?)?$/.exec(text.trim());
    if (!m) throw new AufteilungFehler(`„${text}" ist kein Teil (Form: Kategorie=Betrag@Satz).`);
    const name = m[1].trim();
    const treffer = AUFTEILUNG_KATEGORIEN.filter((c) => c === name || c.startsWith(`${name} `) || c.startsWith(name));
    const exakt = AUFTEILUNG_KATEGORIEN.find((c) => c === name);
    if (!exakt && treffer.length !== 1) {
        throw new AufteilungFehler(
            treffer.length === 0
                ? `„${name}" ist keine Kategorie für einen Teil.`
                : `„${name}" ist nicht eindeutig: ${treffer.join(', ')}.`,
        );
    }
    const zahl = (s: string) => Number(s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    const betragText = m[2]?.trim();
    const betrag = betragText ? zahl(betragText) : null;
    if (betragText && !Number.isFinite(betrag)) throw new AufteilungFehler(`„${betragText}" ist kein Betrag.`);
    const satz = m[3] != null ? zahl(m[3]) / 100 : undefined;
    return {
        category: exakt ?? treffer[0],
        ...(betrag != null ? { betrag } : { rest: true }),
        ...(satz != null ? { vatRate: round2(satz) } : {}),
    };
}

/**
 * What the remainder part takes while the parts are being typed: the booking minus every other part
 * with a valid amount. Can be zero or negative — the dialog shows it and {@link berechneTeile} refuses.
 */
export function restBetrag(amount: number, eingaben: readonly TeilEingabe[], restIndex: number): number {
    let rest = cents(Math.abs(amount));
    eingaben.forEach((t, i) => {
        if (i !== restIndex && t.betrag != null && Number.isFinite(t.betrag)) rest -= cents(t.betrag);
    });
    return rest / 100;
}

/**
 * The part that stands for the booking where one category must be named (lists, Zu prüfen, an
 * Erstattung): the largest business part, else the largest part. Ties go to the earlier part.
 */
export function hauptTeil<T extends Pick<Teil, 'betrag' | 'betrieblich' | 'kind'>>(teile: readonly T[]): T {
    const betrieblich = teile.filter((t) => t.betrieblich && t.kind !== 'neutral');
    const pool = betrieblich.length > 0 ? betrieblich : teile;
    return pool.reduce((best, t) => (t.betrag > best.betrag ? t : best), pool[0]);
}

/** The Bewirtung preset: 70 % Bewirtungskosten, the rest (30 %) non-deductible, both at the same rate. */
export function bewirtungsTeile(amount: number, vatRate = 0.19): TeilEingabe[] {
    return [
        { category: BEWIRTUNG_KATEGORIE, betrag: round2(Math.abs(amount) * BEWIRTUNG_ABZIEHBAR_ANTEIL), vatRate },
        { category: BEWIRTUNG_NICHT_ABZIEHBAR_KATEGORIE, rest: true, vatRate },
    ];
}

/**
 * The VAT in the private parts — Vorsteuer the receipt shows that may not be deducted (§ 15 Abs. 1
 * Satz 1 Nr. 1 UStG: only what was supplied for the business). The receipt-driven USt-VA subtracts it.
 */
export function vorsteuerPrivat(teile: readonly Pick<Teil, 'betrieblich' | 'vat'>[]): number {
    return round2(teile.filter((t) => !t.betrieblich).reduce((s, t) => s + t.vat, 0));
}

/**
 * „Danach gilt …" double-count warning: a split with a private part while the entity also books a
 * pauschal Privatanteil (`adjustments.privatanteile`, Bruttomethode). If both cover the same costs,
 * the private share counts twice. Null when there is nothing to warn about.
 */
export function doppelzaehlungHinweis(
    teile: readonly Pick<Teil, 'betrieblich'>[],
    privatanteile: readonly { bezeichnung: string }[],
): string | null {
    if (privatanteile.length === 0 || teile.every((t) => t.betrieblich)) return null;
    const namen = privatanteile.map((p) => p.bezeichnung).join(', ');
    return (
        `Für diese Firma ist schon ein pauschaler Privatanteil eingetragen (${namen}). ` +
        'Gilt er für dieselben Kosten, ist der private Teil doppelt erfasst — dann nur eins von beiden behalten.'
    );
}

// ── Already filed periods ─────────────────────────────────────────────────────────────────────

/** A register entry as the guard needs it (store `Filing`). */
export interface Abgabe {
    kind: string;
    period: string;
    filedAt: string | null;
}

/** A filed return whose figures a split of a booking on that date would change. */
export interface AbgabeKonflikt {
    kind: string;
    period: string;
    label: string;
}

const JAHRES_ABGABEN: Record<string, string> = {
    euer: 'Anlage EÜR',
    'ust-jahr': 'USt-Jahreserklärung',
    feststellung: 'Feststellungserklärung',
    gewst: 'Gewerbesteuererklärung',
};

/**
 * The filed returns a split (or its removal) of a booking on `datum` touches: the Voranmeldung of the
 * booking's month or quarter and the year's EÜR, USt-Jahreserklärung, Feststellung and GewSt. Only
 * entries with a filing date count.
 */
export function betroffeneAbgaben(datum: string, abgaben: readonly Abgabe[]): AbgabeKonflikt[] {
    const jahr = datum.slice(0, 4);
    const ustva = new Set([zeitraumVon(datum, 'quartal'), zeitraumVon(datum, 'monat')]);
    const out: AbgabeKonflikt[] = [];
    for (const a of abgaben) {
        if (!a.filedAt) continue;
        if (a.kind === 'ustva' && ustva.has(a.period)) {
            out.push({ kind: a.kind, period: a.period, label: `USt-Voranmeldung ${zeitraumLabel(a.period)}` });
        } else if (JAHRES_ABGABEN[a.kind] && a.period === jahr) {
            out.push({ kind: a.kind, period: a.period, label: `${JAHRES_ABGABEN[a.kind]} ${jahr}` });
        }
    }
    return out;
}

/**
 * The warning a split on a filed period shows before it is saved. The register keeps the filed values;
 * the app only says what a correction would take.
 */
export function abgabeWarnung(konflikte: readonly AbgabeKonflikt[], aufheben = false): string {
    const liste = konflikte.map((k) => k.label).join(', ');
    const was = aufheben ? 'Das Aufheben der Aufteilung' : 'Die Aufteilung';
    return (
        `${liste} ${konflikte.length === 1 ? 'ist' : 'sind'} schon eingereicht. ${was} ändert die Zahlen dieses ` +
        'Zeitraums; die eingereichten Werte bleiben im Register, wie sie sind. Beim Finanzamt kommt die Änderung ' +
        'nur mit einer berichtigten Erklärung an (§ 153 AO; eine Voranmeldung wird als berichtigte Anmeldung neu ' +
        'übermittelt, § 168 AO).'
    );
}
