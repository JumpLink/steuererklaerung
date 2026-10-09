/**
 * Steuertermine — the PROACTIVE deadline layer. Where `actions/fristen.ts` (the reactive layer)
 * lists concrete open documents (a received Mahnung, an unpaid bill), this module derives the
 * *recurring statutory* deadlines from RULES + the entity's ELSTER config, so an upcoming
 * USt-Voranmeldung shows up **before** any reminder letter arrives.
 *
 * Everything here is a **Regelfrist-Schätzung** (`estimated: true`): the legal default date, not a
 * binding one. Two deliberate safety choices keep it from ever lulling the user past a real due date:
 *   1. USt-VA uses the EARLY base deadline (10th of the month after the period) unless the config
 *      explicitly records a granted Dauerfristverlängerung (`ust_dauerfristverlaengerung`).
 *   2. Annual declarations use the §149 AO base (31 July of the following year), NOT any
 *      Steuerberater-Fristverlängerung — a granted extension only ever moves the date LATER.
 *
 * Pure + deterministic: pass `today` (YYYY-MM-DD) for reproducible output. Consumed by the CLI
 * (`fristen`), the MCP tool (`list_upcoming_deadlines`) and the app/web Fristen views.
 */

import { jahresAbgabefrist } from './fristen.ts';

export type SteuerTerminKind = 'ustva' | 'ust-jahr' | 'euer' | 'feststellung' | 'gewst' | 'est';

export interface SteuerTermin {
    /** Owning entity (ledger id). */
    entityId: string;
    /** Human entity name for display. */
    entityName: string;
    /** Stable key, e.g. `jumplink:ustva:2026-Q2` — dedupe / view keying. */
    key: string;
    kind: SteuerTerminKind;
    /** Display label, e.g. "USt-VA Q2/2026". */
    label: string;
    /** Period label, e.g. "2026-Q2" or "2025". */
    period: string;
    /** The estimated Regelabgabefrist (YYYY-MM-DD). */
    dueDate: string;
    /** Whole days from `today` until `dueDate` (negative = overdue). */
    daysUntil: number;
    overdue: boolean;
    /** Always true — these are rule-derived estimates, verify against the actual Bescheid. */
    estimated: true;
    /** Assumption / caveat shown next to the date. */
    note?: string;
    /**
     * Filing status from the register, filled in by the `listSteuertermine` action (the pure
     * `computeSteuertermine` never sets it): 'eingereicht' once filed, 'bezahlt' once paid.
     * Undefined = still open. Lets the views move a done period out of the urgency groups.
     */
    status?: 'eingereicht' | 'bezahlt';
    /** Submission date from the register (YYYY-MM-DD), if recorded. */
    filedAt?: string;
    /** Payment date from the register (YYYY-MM-DD), if recorded. */
    paidAt?: string;
    /**
     * Set when the two records of "was this filed" disagree.
     *
     * The status above comes from the filing register; the proof of a filing
     * lives on its snapshot, where ELSTER's own receipt (Transferticket, server
     * protocol) is stored. Those are two stores of one fact, and they could
     * drift silently: the tool's own live send used to write only the snapshot,
     * so a return that had gone out kept being reported as overdue — measured on
     * the 2025 private ESt, transmitted 28.07.2026 and still shown 22 days late
     * four weeks later.
     *
     * The gap is REPORTED rather than quietly healed. A reminder that cries wolf
     * about something done is how a real miss gets waved away later, and a
     * reminder that silently fixes itself never tells anyone the writer is
     * broken.
     */
    registerGap?: string;
}

/** Minimal per-entity view of the ELSTER config this module needs (keeps it testable). */
export interface SteuerTerminEntity {
    entityId: string;
    entityName: string;
    /** Filing cadence for USt-VA — 'quarter' or 'month'; null = no USt-VA (no proactive VA dates). */
    ustCadence: 'quarter' | 'month' | null;
    /** Dauerfristverlängerung granted → every USt-VA deadline +1 month. */
    dauerfrist: boolean;
    /** Files an annual USt-Jahreserklärung (anyone who files USt-VA does). */
    filesUst: boolean;
    /** GbR / Personengesellschaft → Feststellung + Anlage EÜR; else a plain Anlage EÜR. */
    isGbr: boolean;
    /** Gewerbebetrieb → Gewerbesteuererklärung. */
    hasGewerbe: boolean;
    /** Unternehmereigenschaft start (YYYY-MM-DD), if known — no deadlines for periods before it. */
    businessStart?: string;
    /** Unternehmereigenschaft end (YYYY-MM-DD), if the business ceased — no USt-VA after it. */
    businessEnd?: string;
    /**
     * Files a private Einkommensteuererklärung (entity carries an `est` config) → an annual `est`
     * deadline, independent of any business activity. The business gating (businessStart/End)
     * does not apply to it — the private obligation outlives a ceased Gewerbe.
     */
    filesEst?: boolean;
}

/** Whole days from `today` (YYYY-MM-DD) until an ISO date; negative = overdue. Matches fristen.ts. */
function daysBetween(today: string, iso: string): number {
    const a = new Date(`${today}T00:00:00Z`).getTime();
    const b = new Date(`${iso}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86_400_000);
}

/** ISO date for `year-month-10` (the USt-VA base due day is always the 10th). */
function tenth(year: number, month1: number): string {
    return `${year}-${String(month1).padStart(2, '0')}-10`;
}

/** First / last day (YYYY-MM-DD) of a quarter, for business-activity gating. */
function quarterBounds(year: number, q: number): { start: string; end: string } {
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = q * 3;
    const lastDay = new Date(year, endMonth, 0).getDate();
    return {
        start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
        end: `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
}

/** First / last day of a month, for business-activity gating. */
function monthBounds(year: number, m: number): { start: string; end: string } {
    const lastDay = new Date(year, m, 0).getDate();
    return {
        start: `${year}-${String(m).padStart(2, '0')}-01`,
        end: `${year}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
}

/**
 * USt-VA base deadline (10th of the month FOLLOWING the period), plus one month if a
 * Dauerfristverlängerung is granted. Quarter: Q1→10 Apr, Q2→10 Jul, Q3→10 Oct, Q4→10 Jan(+1y).
 * Exported for the payment layer (steuerzahlungen.ts) — the declared Zahllast falls due on this
 * same statutory date (§18 Abs. 1 S. 4 UStG).
 */
export function ustvaDeadline(year: number, periodEndMonth: number, dauerfrist: boolean): string {
    // Month after the period end, rolling into the next year for December.
    let dueYear = year;
    let dueMonth = periodEndMonth + 1;
    if (dueMonth > 12) {
        dueMonth -= 12;
        dueYear += 1;
    }
    if (dauerfrist) {
        dueMonth += 1;
        if (dueMonth > 12) {
            dueMonth -= 12;
            dueYear += 1;
        }
    }
    return tenth(dueYear, dueMonth);
}

/** True if a period [pStart,pEnd] overlaps the entity's active window [businessStart,businessEnd]. */
function periodActive(pStart: string, pEnd: string, businessStart?: string, businessEnd?: string): boolean {
    if (businessStart && pEnd < businessStart) return false; // period ends before the business began
    if (businessEnd && pStart > businessEnd) return false; // period starts after the business ceased
    return true;
}

function mk(
    e: SteuerTerminEntity,
    kind: SteuerTerminKind,
    period: string,
    label: string,
    dueDate: string,
    today: string,
    note: string,
): SteuerTermin {
    const daysUntil = daysBetween(today, dueDate);
    return {
        entityId: e.entityId,
        entityName: e.entityName,
        key: `${e.entityId}:${kind}:${period}`,
        kind,
        label,
        period,
        dueDate,
        daysUntil,
        overdue: daysUntil < 0,
        estimated: true,
        note,
    };
}

/**
 * Derive the upcoming statutory deadlines for ONE entity. Returns USt-VA periods whose base
 * deadline falls within `[today, today + horizonDays]` (future-only — past periods are handled
 * by the reactive reminder documents, so nothing is double-listed) plus the annual declarations
 * for any completed year whose §149 deadline lies within `[today - 60d, today + horizonDays]`.
 */
export function computeSteuertermine(e: SteuerTerminEntity, today: string, horizonDays = 200): SteuerTermin[] {
    const out: SteuerTermin[] = [];
    const dauerNote = e.dauerfrist
        ? 'Regelfrist inkl. Dauerfristverlängerung (+1 Monat). Gegen ELSTER-Status prüfen.'
        : 'Regelfrist ohne Dauerfristverlängerung — mit bewilligter Dauerfrist +1 Monat. Gegen ELSTER-Status prüfen.';

    // ── USt-Voranmeldungen (recurring, future-only) ──────────────────────────────────────────
    if (e.ustCadence === 'quarter') {
        // Scan a generous span of quarters and keep those whose deadline is in the horizon window.
        const startYear = Number(today.slice(0, 4));
        for (let year = startYear - 1; year <= startYear + 2; year++) {
            for (let q = 1; q <= 4; q++) {
                const { start, end } = quarterBounds(year, q);
                if (!periodActive(start, end, e.businessStart, e.businessEnd)) continue;
                const due = ustvaDeadline(year, q * 3, e.dauerfrist);
                const days = daysBetween(today, due);
                if (days < 0 || days > horizonDays) continue; // future-only, bounded horizon
                out.push(mk(e, 'ustva', `${year}-Q${q}`, `USt-VA Q${q}/${year}`, due, today, dauerNote));
            }
        }
    } else if (e.ustCadence === 'month') {
        const startYear = Number(today.slice(0, 4));
        for (let year = startYear - 1; year <= startYear + 1; year++) {
            for (let m = 1; m <= 12; m++) {
                const { start, end } = monthBounds(year, m);
                if (!periodActive(start, end, e.businessStart, e.businessEnd)) continue;
                const due = ustvaDeadline(year, m, e.dauerfrist);
                const days = daysBetween(today, due);
                if (days < 0 || days > horizonDays) continue;
                const mm = String(m).padStart(2, '0');
                out.push(mk(e, 'ustva', `${year}-${mm}`, `USt-VA ${mm}/${year}`, due, today, dauerNote));
            }
        }
    }

    // ── Jahreserklärungen (§149 AO base = 31 July of the following year, no advisor extension) ──
    // Business annuals only for genuine business entities — a purely private entity files no
    // Anlage EÜR; the private `est` deadline is independent of any business window (it outlives
    // a ceased Gewerbe and exists without one).
    const isBusiness = e.filesUst || e.hasGewerbe || e.isGbr || e.ustCadence !== null;
    const annualNote =
        'Regelabgabefrist §149 AO (ohne Steuerberater = 31.07. des Folgejahres). ' +
        'Eine bewilligte Fristverlängerung verschiebt sie nach hinten.';
    const estNote =
        'Regelabgabefrist §149 AO (Pflichtveranlagung ohne Steuerberater = 31.07. des Folgejahres). ' +
        'Eine bewilligte Fristverlängerung verschiebt sie nach hinten.';
    const startYear = Number(today.slice(0, 4));
    for (let year = startYear - 2; year <= startYear; year++) {
        const due = jahresAbgabefrist(year, 0);
        const days = daysBetween(today, due);
        if (days < -60 || days > horizonDays) continue; // small look-back so a just-passed one still shows

        // The entity must have been active at some point during `year` for the business annuals.
        const yStart = `${year}-01-01`;
        const yEnd = `${year}-12-31`;
        if (isBusiness && periodActive(yStart, yEnd, e.businessStart, e.businessEnd)) {
            if (e.filesUst) {
                out.push(mk(e, 'ust-jahr', `${year}`, `USt-Jahreserklärung ${year}`, due, today, annualNote));
            }
            if (e.isGbr) {
                out.push(mk(e, 'feststellung', `${year}`, `Feststellung + Anlage EÜR ${year}`, due, today, annualNote));
            } else {
                out.push(mk(e, 'euer', `${year}`, `Anlage EÜR ${year}`, due, today, annualNote));
            }
            if (e.hasGewerbe) {
                out.push(mk(e, 'gewst', `${year}`, `Gewerbesteuererklärung ${year}`, due, today, annualNote));
            }
        }

        if (e.filesEst) {
            out.push(mk(e, 'est', `${year}`, `Einkommensteuererklärung ${year}`, due, today, estNote));
        }
    }

    return sortByDue(out);
}

/** Rank by urgency: soonest / most overdue first, then by key for stable ordering. */
function sortByDue(termine: SteuerTermin[]): SteuerTermin[] {
    termine.sort((a, b) =>
        a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    return termine;
}
