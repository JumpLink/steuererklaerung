/**
 * ESt-Intake — the deterministic heart of the private-ESt "Steuer-Wizard". It turns plain-language
 * answers about a taxpayer's LIFE SITUATION (Trennung, Haushalt, Kinder, Lohnersatz …) into validated
 * est-config patches via the raw-preserving writer (`upsertEstJahr`). The GUI wizard and the AI copilot
 * are thin ADAPTERS over the `derive*`/`apply*` functions here: the engine stays the single source of
 * truth for the math, this layer only captures the FACTS a layperson can answer but couldn't hand-author
 * as JSON (exactly the branching questions this app kept needing: §24b months, Kita allocation, …).
 *
 * Pattern per topic: a QUESTION descriptor (what the GUI renders / the AI asks) → `derive()` (pure:
 * eligibility logic + the config values + human Hinweise) → `apply()` (writes via the config seam).
 * First topic: §24b Entlastungsbetrag für Alleinerziehende. Add topics in the same shape.
 */

import { upsertEstJahr, mutateEstConfig } from '../../config/accessors.ts';
import { round2 } from '../../lib/money.ts';

/**
 * One wizard question — rendered by the GUI, asked by the AI copilot. `wennId`/`wennWert` make a
 * question conditional (branching): only ask it when a prior answer equals `wennWert`.
 */
export interface IntakeQuestion {
    id: string;
    frage: string;
    typ: 'boolean' | 'monat' | 'zahl' | 'kind' | 'auswahl';
    /** For `typ: 'auswahl'` — the choices as `{ wert, label }`. */
    optionen?: Array<{ wert: string; label: string }>;
    hilfe?: string;
    /** For `typ: 'zahl'` — decimal places the GUI shows (2 = money, 0 = a count). Default 0. */
    nachkomma?: number;
    wennId?: string;
    wennWert?: unknown;
}

/**
 * Is a question active given the answers so far? An ungated question (`wennId` unset) is always shown;
 * a gated one only when the referenced prior answer equals `wennWert`. Pure — the GUI wizard and the AI
 * copilot both use this to decide which question to render/ask next (the branching lives here, once).
 */
export function frageAktiv(q: IntakeQuestion, answers: Record<string, unknown>): boolean {
    if (q.wennId === undefined) return true;
    return answers[q.wennId] === q.wennWert;
}

/** The active questions of a flow, in order, given the partial answers so far (branch-filtered). */
export function aktiveFragen(fragen: IntakeQuestion[], answers: Record<string, unknown>): IntakeQuestion[] {
    return fragen.filter((q) => frageAktiv(q, answers));
}

// ── §24b Entlastungsbetrag für Alleinerziehende ─────────────────────────────────────────────────

export interface EntlastungAnswers {
    /** Was the Stpfl. (at times) ALLEINSTEHEND during the VZ with at least one child — unmarried and
     *  no other adult in the household (apart from children with Kindergeldanspruch)? */
    alleinstehendMitKind: boolean;
    /** First month of being alleinstehend ('YYYY-MM'); empty = from January. */
    von?: string;
    /** Last month ('YYYY-MM'); empty = through December. */
    bis?: string;
    /** IdNr of the child in the household (Grundbetrag). */
    kindIdnr?: string;
    /** Children in the household BEYOND the first one (each one +Erhöhungsbetrag 240 €). */
    weitereKinder?: number;
    /** Does ANOTHER adult live in the household (no child with Kindergeldanspruch)? → §24b does not apply. */
    andererVolljaehrigerImHaushalt?: boolean;
}

export interface EntlastungDerived {
    monate: number;
    weitere_kinder: number;
    kind_idnr?: string;
    /** Human-readable rationale/warnings (for the wizard UI + AI copilot). */
    hinweise: string[];
}

/** The §24b question flow, for the GUI/AI to render. */
export const ENTLASTUNG_FRAGEN: IntakeQuestion[] = [
    {
        id: 'alleinstehendMitKind',
        typ: 'boolean',
        frage: 'Warst du im Jahr (zeitweise) alleinerziehend — nicht verheiratet und ohne weiteren Erwachsenen im Haushalt, mit mindestens einem Kind bei dir?',
    },
    {
        id: 'von',
        typ: 'monat',
        wennId: 'alleinstehendMitKind',
        wennWert: true,
        frage: 'Ab welchem Monat traf das zu?',
        hilfe: 'z. B. ab dem Auszug des anderen Elternteils. Leer = ab Januar.',
    },
    {
        id: 'bis',
        typ: 'monat',
        wennId: 'alleinstehendMitKind',
        wennWert: true,
        frage: 'Bis zu welchem Monat?',
        hilfe: 'Leer = bis Dezember.',
    },
    {
        id: 'kindIdnr',
        typ: 'kind',
        wennId: 'alleinstehendMitKind',
        wennWert: true,
        frage: 'Welches Kind lebt in deinem Haushalt (für den Grundbetrag)?',
    },
    {
        id: 'weitereKinder',
        typ: 'zahl',
        wennId: 'alleinstehendMitKind',
        wennWert: true,
        frage: 'Wie viele WEITERE Kinder leben zusätzlich in deinem Haushalt?',
        hilfe: 'Je weiteres Kind erhöht sich der Entlastungsbetrag um 240 €.',
    },
    {
        id: 'andererVolljaehrigerImHaushalt',
        typ: 'boolean',
        wennId: 'alleinstehendMitKind',
        wennWert: true,
        frage: 'Wohnt eine andere volljährige Person mit im Haushalt (neue:r Partner:in, Eltern, WG)?',
        hilfe: 'Falls ja, entfällt der Entlastungsbetrag für diese Zeit — dann bist du steuerlich nicht „alleinstehend".',
    },
];

/** Month number (1..12) from a 'YYYY-MM' string, clamped; `fallback` when empty/unparseable. */
function monat(s: string | undefined, fallback: number): number {
    if (!s) return fallback;
    const m = Number(s.slice(5, 7));
    return m >= 1 && m <= 12 ? m : fallback;
}

/**
 * Derive the §24b Entlastungsbetrag from the wizard answers (months + further children), including the
 * eligibility logic: no marriage/Splitting check here (that one sits in `veranlagung`), but the two
 * exclusions — not alleinerziehend, or another adult in the household — lead to 0.
 * §24b Abs. 3: 1/12 per full calendar month in which the conditions are met.
 */
export function deriveEntlastungAlleinerziehende(a: EntlastungAnswers): EntlastungDerived {
    const hinweise: string[] = [];
    const kind_idnr = a.kindIdnr;
    if (!a.alleinstehendMitKind) {
        hinweise.push('Nicht alleinerziehend → kein Entlastungsbetrag (§24b).');
        return { monate: 0, weitere_kinder: 0, kind_idnr, hinweise };
    }
    if (a.andererVolljaehrigerImHaushalt) {
        hinweise.push(
            'Eine andere volljährige Person im Haushalt → steuerlich nicht „alleinstehend" → §24b entfällt für diese Zeit.',
        );
        return { monate: 0, weitere_kinder: 0, kind_idnr, hinweise };
    }
    const von = Math.max(1, monat(a.von, 1));
    const bis = Math.min(12, monat(a.bis, 12));
    const monate = Math.max(0, bis - von + 1);
    if (!kind_idnr)
        hinweise.push('Kein Kind zugeordnet — §24b verlangt mindestens ein Kind mit Kindergeldanspruch im Haushalt.');
    hinweise.push(
        monate >= 12
            ? 'Ganzjährig → voller Entlastungsbetrag (4.260 € + 240 € je weiterem Kind).'
            : `${monate} Monat(e) alleinerziehend → anteilig ${monate}/12.`,
    );
    return { monate, weitere_kinder: Math.max(0, Math.trunc(a.weitereKinder ?? 0)), kind_idnr, hinweise };
}

/** Derive + persist `jahr.entlastung_alleinerziehende` via the raw-preserving writer (validate-before-write). */
export function applyEntlastungAlleinerziehende(
    entityId: string,
    year: number,
    a: EntlastungAnswers,
): EntlastungDerived {
    const derived = deriveEntlastungAlleinerziehende(a);
    upsertEstJahr(entityId, year, {
        entlastung_alleinerziehende: {
            monate: derived.monate,
            weitere_kinder: derived.weitere_kinder,
            ...(derived.kind_idnr ? { kind_idnr: derived.kind_idnr } : {}),
        },
    });
    return derived;
}

// ── Kinderbetreuungskosten (§10 Nr. 5) — incl. the allocation between separated parents ─────────

export interface KinderbetreuungAnswers {
    /** Were there deductible Betreuungskosten (Kita/Hort/Tagesmutter) WITH an invoice + paid NON-CASH? */
    hatKosten: boolean;
    /** Name of the provider (e.g. Kita) — goes into the `bezeichnung`. */
    dienstleister?: string;
    /** Total for the year — what BOTH parents paid together (only the pure care portion). */
    betragGesamt?: number;
    /** Period TT.MM–TT.MM (default 01.01–31.12). */
    zeitraumVon?: string;
    zeitraumBis?: string;
    /** Did the child belong to YOUR household during the period? (Precondition for YOUR deduction.) */
    kindImHaushalt?: boolean;
    /** Who deducts the costs — only ONCE per child across both parents (the FA cross-checks both returns). */
    abzug: 'ich' | 'anderer' | 'haelftig';
}

export interface KinderbetreuungEintrag {
    bezeichnung: string;
    zeitraum_von: string;
    zeitraum_bis: string;
    betrag: number;
    von_mir: number;
}

export interface KinderbetreuungDerived {
    /** The Betreuungskosten entry for the child-year, or null (no deduction on your side). */
    eintrag: KinderbetreuungEintrag | null;
    hinweise: string[];
}

/** The Kinderbetreuung questions (per child) — for the GUI/AI. */
export const KINDERBETREUUNG_FRAGEN: IntakeQuestion[] = [
    {
        id: 'hatKosten',
        typ: 'boolean',
        frage: 'Hattest du für dieses Kind Betreuungskosten (Kita, Hort, Tagesmutter) mit Rechnung und unbarer Zahlung?',
    },
    {
        id: 'betragGesamt',
        typ: 'zahl',
        nachkomma: 2,
        wennId: 'hatKosten',
        wennWert: true,
        frage: 'Wie hoch waren die Betreuungskosten insgesamt im Jahr (€)?',
        hilfe: 'Der volle Betrag, den beide Eltern zusammen gezahlt haben — nur der reine Betreuungsanteil (ohne Verpflegung).',
    },
    {
        id: 'kindImHaushalt',
        typ: 'boolean',
        wennId: 'hatKosten',
        wennWert: true,
        frage: 'Gehörte das Kind in dem Zeitraum zu deinem Haushalt?',
    },
    {
        id: 'abzug',
        typ: 'auswahl',
        wennId: 'hatKosten',
        wennWert: true,
        frage: 'Wer zieht die Kosten steuerlich ab?',
        optionen: [
            { wert: 'ich', label: 'Nur ich' },
            { wert: 'anderer', label: 'Nur der andere Elternteil' },
            { wert: 'haelftig', label: 'Hälftig (jeder die Hälfte)' },
        ],
        hilfe: 'Betreuungskosten sind nur EINMAL je Kind über beide Eltern abziehbar — das Finanzamt gleicht beide Erklärungen ab.',
    },
];

/**
 * Derive the Kinderbetreuung entry from the answers — including the two preconditions (child in the
 * household; any costs at all) AND the allocation between separated parents: "only me" (full),
 * "only the other one" (0, no double deduction), "half" (½). Exactly the double-deduction guard that
 * separated parents need — across both parents the costs are deductible only once.
 */
export function deriveKinderbetreuung(a: KinderbetreuungAnswers): KinderbetreuungDerived {
    const hinweise: string[] = [];
    if (!a.hatKosten || !a.betragGesamt || a.betragGesamt <= 0) {
        hinweise.push('Keine abzugsfähigen Kinderbetreuungskosten angegeben.');
        return { eintrag: null, hinweise };
    }
    if (a.kindImHaushalt === false) {
        hinweise.push(
            'Das Kind gehörte in dem Zeitraum nicht zu deinem Haushalt → du kannst die Kosten nicht abziehen (§10 Nr. 5).',
        );
        return { eintrag: null, hinweise };
    }
    let von_mir: number;
    if (a.abzug === 'anderer') {
        hinweise.push(
            'Der andere Elternteil zieht die Kosten voll ab → bei dir 0 € (ein Doppelabzug ist ausgeschlossen).',
        );
        von_mir = 0;
    } else if (a.abzug === 'haelftig') {
        von_mir = round2(a.betragGesamt / 2);
        hinweise.push(
            'Hälftige Aufteilung — der andere Elternteil zieht die andere Hälfte ab; zusammen nie mehr als der Gesamtbetrag.',
        );
    } else {
        von_mir = round2(a.betragGesamt);
        hinweise.push(
            'Du ziehst die Kosten voll ab → der andere Elternteil darf sie NICHT auch abziehen (das Finanzamt gleicht beide Erklärungen ab).',
        );
    }
    if (von_mir <= 0) return { eintrag: null, hinweise };
    return {
        eintrag: {
            bezeichnung: a.dienstleister ? `Kinderbetreuung (${a.dienstleister})` : 'Kinderbetreuung',
            zeitraum_von: a.zeitraumVon ?? '01.01',
            zeitraum_bis: a.zeitraumBis ?? '31.12',
            betrag: round2(a.betragGesamt),
            von_mir,
        },
        hinweise,
    };
}

/**
 * Navigate to a child's year entry (creating both the child's `jahre` array and the year entry when
 * missing), then mutate it — via the raw-preserving est seam. Shared by the per-child intake writers
 * (`applyKinderbetreuung`, `applyHaushalt`) so the config navigation lives in exactly one place.
 */
function mutateKindJahr(
    entityId: string,
    kindIdnr: string,
    year: number,
    fn: (jahr: Record<string, unknown>) => void,
): void {
    mutateEstConfig(entityId, (raw) => {
        const kinder = Array.isArray(raw.kinder) ? (raw.kinder as Array<Record<string, unknown>>) : [];
        const kind = kinder.find((k) => (k as { idnr?: string }).idnr === kindIdnr);
        if (!kind) throw new Error(`Kein Kind mit IdNr '${kindIdnr}' in der est-Config.`);
        const jahre = Array.isArray(kind.jahre) ? (kind.jahre as Array<Record<string, unknown>>) : [];
        kind.jahre = jahre;
        let jahr = jahre.find((j) => (j as { jahr?: number }).jahr === year);
        if (!jahr) {
            jahr = { jahr: year };
            jahre.push(jahr);
        }
        fn(jahr);
    });
}

/** Derive + persist the child's `jahre[year].kinderbetreuung` (single entry, or removed) via the raw seam. */
export function applyKinderbetreuung(
    entityId: string,
    year: number,
    kindIdnr: string,
    a: KinderbetreuungAnswers,
): KinderbetreuungDerived {
    const derived = deriveKinderbetreuung(a);
    mutateKindJahr(entityId, kindIdnr, year, (jahr) => {
        if (derived.eintrag) jahr.kinderbetreuung = [derived.eintrag];
        else delete jahr.kinderbetreuung;
    });
    return derived;
}

// ── Household/separation timeline — the SHARED fact behind §24b months AND the KBK household block ────
//
// A separated pair of parents answers ONE timeline (separated since when, child with whom), and two
// otherwise separately maintained things follow from it inevitably: the §24b months (Alleinerziehende)
// and the Anlage Kind household block (`KBK/Ang_HH`, required by ERiC as soon as Kinderbetreuung is
// declared). `deriveHaushalt` is the pure derivation; `applyHaushalt` writes the per-child block, the
// §24b months come back as `alleinstehend_*` to hand to the existing §24b intake (no second writer).

/** The Anlage Kind household block (`KBK/Ang_HH`) as TT.MM-TT.MM periods — same shape as the est schema. */
export interface HaushaltBlock {
    gemeinsam_zeitraum?: string;
    gemeinsam_kind_zeitraum?: string;
    getrennt_zeitraum?: string;
    kind_bei_mir_zeitraum?: string;
    kind_beim_anderen_zeitraum?: string;
}

export interface HaushaltAnswers {
    /** Did you (the parents) live SEPARATELY during the year — at least for a while (no shared household)? */
    getrenntGelebt: boolean;
    /** First month of the separation ('YYYY-MM'); empty = from January. */
    getrenntAb?: string;
    /** Last month of the separation ('YYYY-MM'); empty = through December (end of year). */
    getrenntBis?: string;
    /** Whom the child lived with DURING the separation. Default 'ich'. */
    kindBeiWem?: 'ich' | 'anderer';
    /** Did the child belong to the household during a SHARED household? Default true. */
    kindImGemeinsamenHaushalt?: boolean;
}

export interface HaushaltDerived {
    /** §24b: calendar months the Stpfl. lived alone with the child (0 = child with the other / no separation). */
    alleinstehend_monate: number;
    /** 'YYYY-MM' window to hand to the §24b intake (undefined = from January / through December). */
    alleinstehend_von?: string;
    alleinstehend_bis?: string;
    /** The KBK household block for the child-year, or undefined. */
    haushalt: HaushaltBlock | undefined;
    hinweise: string[];
}

/** The household/separation questions (per child) — for the GUI/AI. */
export const HAUSHALT_FRAGEN: IntakeQuestion[] = [
    {
        id: 'getrenntGelebt',
        typ: 'boolean',
        frage: 'Habt ihr (die Eltern des Kindes) im Jahr — zumindest zeitweise — getrennt gelebt, also keinen gemeinsamen Haushalt mehr geführt?',
    },
    {
        id: 'getrenntAb',
        typ: 'monat',
        wennId: 'getrenntGelebt',
        wennWert: true,
        frage: 'Ab welchem Monat habt ihr getrennt gelebt?',
        hilfe: 'z. B. der Monat, in dem der andere Elternteil ausgezogen ist. Leer = ab Januar.',
    },
    {
        id: 'getrenntBis',
        typ: 'monat',
        wennId: 'getrenntGelebt',
        wennWert: true,
        frage: 'Bis zu welchem Monat dauerte die Trennung?',
        hilfe: 'Leer = bis Jahresende. Nur ausfüllen, wenn ihr im selben Jahr wieder einen gemeinsamen Haushalt gebildet habt.',
    },
    {
        id: 'kindBeiWem',
        typ: 'auswahl',
        wennId: 'getrenntGelebt',
        wennWert: true,
        frage: 'Bei wem lebte das Kind während der Trennung?',
        optionen: [
            { wert: 'ich', label: 'Bei mir' },
            { wert: 'anderer', label: 'Beim anderen Elternteil' },
        ],
        hilfe: 'Nur beim Elternteil, zu dessen Haushalt das Kind gehörte, zählen die §24b-Monate.',
    },
    {
        id: 'kindImGemeinsamenHaushalt',
        typ: 'boolean',
        frage: 'Gehörte das Kind während eines gemeinsamen Haushalts zu eurem Haushalt?',
        hilfe: 'Vor/nach der Trennung — bzw. das ganze Jahr, wenn ihr zusammengelebt habt. Fast immer ja.',
    },
];

/** Last day of a month (leap-year aware via the concrete year). */
function letzterTag(year: number, month1to12: number): number {
    return new Date(year, month1to12, 0).getDate();
}

/** A full-month window [vonM..bisM] as a `TT.MM-TT.MM` string (first day of vonM → last day of bisM). */
function monatsZeitraum(year: number, vonM: number, bisM: number): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(1)}.${p(vonM)}-${p(letzterTag(year, bisM))}.${p(bisM)}`;
}

/**
 * Derive the KBK household block AND the §24b months from the separation timeline. Model: the separation
 * is ONE window [getrenntAb..getrenntBis]; the rest of the year is a shared household. Whoever had the
 * child in the household during that window gets its months as the §24b share (child with the other → 0).
 * The edge case "separated mid-year, shared before AND after" cannot be carried in full by the KBK block
 * (it holds only one "gemeinsam" period) → a Hinweis instead of a silent truncation.
 */
export function deriveHaushalt(a: HaushaltAnswers, year: number): HaushaltDerived {
    const hinweise: string[] = [];
    const kindGem = a.kindImGemeinsamenHaushalt !== false;
    if (!a.getrenntGelebt) {
        hinweise.push('Keine Trennung im Jahr → durchgehend gemeinsamer Haushalt; §24b (Alleinerziehende) entfällt.');
        return {
            alleinstehend_monate: 0,
            haushalt: {
                gemeinsam_zeitraum: monatsZeitraum(year, 1, 12),
                ...(kindGem ? { gemeinsam_kind_zeitraum: monatsZeitraum(year, 1, 12) } : {}),
            },
            hinweise,
        };
    }
    let von = Math.max(1, monat(a.getrenntAb, 1));
    let bis = Math.min(12, monat(a.getrenntBis, 12));
    if (bis < von) {
        hinweise.push('Trennungs-Ende liegt vor dem -Beginn — die Monate wurden getauscht; bitte prüfen.');
        [von, bis] = [bis, von];
    }
    const haushalt: HaushaltBlock = { getrennt_zeitraum: monatsZeitraum(year, von, bis) };
    // Shared household = the complement of the separation within the year.
    if (von > 1) {
        haushalt.gemeinsam_zeitraum = monatsZeitraum(year, 1, von - 1);
        if (kindGem) haushalt.gemeinsam_kind_zeitraum = monatsZeitraum(year, 1, von - 1);
    }
    if (bis < 12) {
        if (von > 1) {
            hinweise.push(
                `Nach der Trennung wieder gemeinsamer Haushalt (ab Monat ${bis + 1}) — der KBK-Block kann nur EINEN „gemeinsam"-Zeitraum tragen; den zweiten bitte im Einstellungen-UI ergänzen.`,
            );
        } else {
            haushalt.gemeinsam_zeitraum = monatsZeitraum(year, bis + 1, 12);
            if (kindGem) haushalt.gemeinsam_kind_zeitraum = monatsZeitraum(year, bis + 1, 12);
        }
    }
    const monate = bis - von + 1;
    let alleinstehend_monate = 0;
    let alleinstehend_von: string | undefined;
    let alleinstehend_bis: string | undefined;
    if (a.kindBeiWem === 'anderer') {
        haushalt.kind_beim_anderen_zeitraum = monatsZeitraum(year, von, bis);
        hinweise.push('Kind während der Trennung beim anderen Elternteil → keine §24b-Monate bei dir.');
    } else {
        haushalt.kind_bei_mir_zeitraum = monatsZeitraum(year, von, bis);
        alleinstehend_monate = monate;
        alleinstehend_von = von > 1 ? `${year}-${String(von).padStart(2, '0')}` : undefined;
        alleinstehend_bis = bis < 12 ? `${year}-${String(bis).padStart(2, '0')}` : undefined;
        hinweise.push(
            `Kind bei dir während der Trennung → ${monate} Monat(e) alleinstehend (§24b anteilig ${monate}/12).`,
        );
    }
    return { alleinstehend_monate, alleinstehend_von, alleinstehend_bis, haushalt, hinweise };
}

/**
 * Derive + persist the child's `jahre[year].haushalt` (KBK/Ang_HH) block via the raw seam. Writes ONLY
 * the household block; the §24b months come back in the return value (`alleinstehend_*`) for the caller
 * to feed into {@link applyEntlastungAlleinerziehende} — no second §24b writer here.
 */
export function applyHaushalt(entityId: string, year: number, kindIdnr: string, a: HaushaltAnswers): HaushaltDerived {
    const derived = deriveHaushalt(a, year);
    mutateKindJahr(entityId, kindIdnr, year, (jahr) => {
        if (derived.haushalt && Object.keys(derived.haushalt).length) jahr.haushalt = derived.haushalt;
        else delete jahr.haushalt;
    });
    return derived;
}

// ── §32b Lohnersatzleistungen (Progressionsvorbehalt) — incl. repayment (Abflussprinzip) ───────────
//
// Tax-free income replacement benefits (Eltern-, Arbeitslosen-, Kranken-, Mutterschaftsgeld …) are
// tax-free themselves but raise the tax rate on the remaining income (§32b). The relevant value is the
// NET one: received in the year minus repaid in the year (Abflussprinzip §11) — if the repayment
// dominates, the negative Progressionsvorbehalt lowers the tax. Exactly the real 2025 case (Elterngeld
// from the previous year, repaid in instalments or in full) that a layperson can answer in plain words.

export interface LohnersatzAnswers {
    /** Did you have tax-free Lohnersatzleistungen during the year — received OR repaid? */
    hatLohnersatz: boolean;
    /** Amount RECEIVED in the calendar year (0 when this year only saw repayments). */
    erhalten?: number;
    /** Amount REPAID in the calendar year (Abflussprinzip; e.g. Elterngeld instalments from last year). */
    zurueckgezahlt?: number;
    /** Kind of benefit (Elterngeld, Arbeitslosengeld …) — informational, only used for the Hinweise. */
    art?: string;
}

export interface LohnersatzDerived {
    erhalten: number;
    zurueckgezahlt: number;
    /** Net = received − repaid (may be negative → negative Progressionsvorbehalt). */
    netto: number;
    hinweise: string[];
}

/** The §32b Lohnersatz questions — for the GUI/AI. */
export const LOHNERSATZ_FRAGEN: IntakeQuestion[] = [
    {
        id: 'hatLohnersatz',
        typ: 'boolean',
        frage: 'Hast du im Jahr steuerfreie Lohnersatzleistungen bezogen oder zurückgezahlt (Elterngeld, Arbeitslosengeld, Krankengeld, Mutterschaftsgeld …)?',
        hilfe: 'Diese Leistungen sind steuerfrei, erhöhen aber den Steuersatz auf dein übriges Einkommen (Progressionsvorbehalt §32b).',
    },
    {
        id: 'erhalten',
        typ: 'zahl',
        nachkomma: 2,
        wennId: 'hatLohnersatz',
        wennWert: true,
        frage: 'Wie viel hast du in diesem Jahr erhalten (€)?',
        hilfe: 'Der im Kalenderjahr zugeflossene Betrag. 0, wenn du in diesem Jahr nur zurückgezahlt hast.',
    },
    {
        id: 'zurueckgezahlt',
        typ: 'zahl',
        nachkomma: 2,
        wennId: 'hatLohnersatz',
        wennWert: true,
        frage: 'Wie viel hast du in diesem Jahr zurückgezahlt (€)?',
        hilfe: 'z. B. Elterngeld aus dem Vorjahr, das du in Raten oder komplett zurückzahlst. 0, wenn keine Rückzahlung.',
    },
];

/**
 * Derive the §32b net amount from the answers (received − repaid). Both amounts are clamped to ≥ 0 (the
 * direction sits in the two fields, not in the sign); the net may be negative — then the negative
 * Progressionsvorbehalt lowers the tax. Pure derivation; no config access.
 */
export function deriveLohnersatz(a: LohnersatzAnswers): LohnersatzDerived {
    const hinweise: string[] = [];
    if (!a.hatLohnersatz) {
        hinweise.push('Keine Lohnersatzleistungen → kein Progressionsvorbehalt (§32b).');
        return { erhalten: 0, zurueckgezahlt: 0, netto: 0, hinweise };
    }
    const erhalten = round2(Math.max(0, a.erhalten ?? 0));
    const zurueckgezahlt = round2(Math.max(0, a.zurueckgezahlt ?? 0));
    const netto = round2(erhalten - zurueckgezahlt);
    const art = a.art ? `${a.art}: ` : '';
    if (netto < 0)
        hinweise.push(
            `${art}Rückzahlung überwiegt (netto ${netto} €) → negativer Progressionsvorbehalt senkt den Steuersatz.`,
        );
    else if (netto > 0)
        hinweise.push(`${art}netto ${netto} € steuerfrei, erhöhen aber den Steuersatz auf dein übriges Einkommen.`);
    else hinweise.push(`${art}erhalten und zurückgezahlt gleichen sich aus → keine Auswirkung auf den Steuersatz.`);
    hinweise.push('Maßgeblich ist das ZUFLUSS-/ABFLUSSJAHR (§11) — Rückzahlungen zählen im Jahr der Zahlung.');
    return { erhalten, zurueckgezahlt, netto, hinweise };
}

/** Derive + persist the year's `lohnersatz` block (erhalten/zurückgezahlt) via the raw-preserving writer. */
export function applyLohnersatz(entityId: string, year: number, a: LohnersatzAnswers): LohnersatzDerived {
    const derived = deriveLohnersatz(a);
    upsertEstJahr(entityId, year, {
        lohnersatz: { erhalten: derived.erhalten, zurueckgezahlt: derived.zurueckgezahlt },
    });
    return derived;
}
