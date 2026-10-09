/**
 * Offene Steuerzahlungen — the PAYMENT side of the Fristen system. Where `steuertermine.ts`
 * derives upcoming DECLARATION deadlines, this module derives which declared tax amounts are
 * still unpaid and when they fall due. Source of truth is the filing register (store `filings`):
 * a row that is filed, unpaid and carries a positive Soll is an open payment.
 *
 * WHICH Soll: the Finanzamt's own assessment wins over ours whenever one is recorded
 * (`assessedAmount`), because it is the amount actually owed — it settles against the Finanzamt's
 * Vorauszahlungssoll, which knows payments this register never saw. A declared Abschlusszahlung of
 * 1.091,16 € came back as a 354,98 € REFUND that way, and the tracker kept demanding the 1.091,16 €
 * until the Bescheid figure was allowed to override it. The declared figure is never overwritten
 * (Z119 must keep summing what we sent) — the divergence is reported instead, via
 * {@link zahlungsAbweichung}.
 *
 * Due-date rules (all Regelfrist-Schätzungen, `estimated: true`):
 *   • ustva     — a USt-VA is a Steueranmeldung: the declared Zahllast is due WITHOUT any Bescheid
 *                 on the statutory filing deadline itself (§18 Abs. 1 S. 4 UStG — the 10th after
 *                 the period, +1 month with Dauerfristverlängerung). A late submission does not
 *                 move the due date — the amount is then already overdue.
 *   • ust-jahr  — the Abschlusszahlung of the annual return is due one month after the return
 *                 reached the Finanzamt (§18 Abs. 4 S. 1–2 UStG), no Bescheid needed either.
 *   • gewst/est/sonstige — payment falls due per Bescheid (§220 AO; typically one month after
 *                 Bekanntgabe), so no date can be derived here → dueDate null, amount still shown.
 *   • feststellung/euer/dauerfrist — never a payment obligation; skipped entirely.
 *
 * Weekend deadlines shift to the next Monday (§108 Abs. 3 AO); public holidays are NOT modelled —
 * a real holiday only ever moves the date LATER, so the estimate errs on the safe side.
 *
 * Pure + deterministic: pass `today` (YYYY-MM-DD) for reproducible output. Consumed by the CLI
 * (`fristen`), the MCP tool (`list_open_tax_payments`) and the app/web Fristen views.
 */

import type { Filing } from '@steuererklaerung/store';
import { ustvaDeadline } from './steuertermine.ts';

export interface OffeneSteuerzahlung {
    /** Owning entity — the register's entity id, resolved to the workspace entity when known. */
    entityId: string;
    /** Human entity name for display (falls back to the register id for unknown entities). */
    entityName: string;
    /** Stable key, e.g. `jumplink:ustva:2026-Q1:zahlung` — dedupe / view keying. */
    key: string;
    /** Filing kind (ustva|ust-jahr|gewst|est|sonstige). */
    kind: string;
    /** Period label, e.g. '2026-Q1' or '2025'. */
    period: string;
    /** Display label, e.g. "USt-VA Q1/2026 — Zahllast". */
    label: string;
    /** The open amount in EUR — the assessed Soll when a Bescheid is recorded, else the declared one. */
    amount: number;
    /**
     * How the open amount was determined: 'assessed' = read off the Finanzamt's Bescheid,
     * 'declared' = our own Anmeldungssoll, 'legacy' = the pre-v10 `amount` column. Callers say
     * which, because "the Finanzamt asks for this" and "we calculated this" are not the same claim.
     */
    amountSource: 'assessed' | 'declared' | 'legacy';
    /** Submission date from the register (YYYY-MM-DD). */
    filedAt: string;
    /** Estimated payment due date (YYYY-MM-DD), or null when it depends on the Bescheid. */
    dueDate: string | null;
    /** Whole days from `today` until `dueDate` (negative = overdue); null without a due date. */
    daysUntil: number | null;
    overdue: boolean;
    /** Always true — rule-derived estimates, verify against the actual Bescheid/Kontoauszug. */
    estimated: true;
    /** Assumption / caveat shown next to the date. */
    note: string;
}

/** Minimal per-entity view this module needs to resolve names + the Dauerfrist flag. */
export interface SteuerzahlungEntity {
    /** All register ids this entity may appear under (workspace id + ledger aliases). */
    ids: string[];
    entityId: string;
    entityName: string;
    /** Dauerfristverlängerung granted → the USt-VA statutory due date shifts +1 month. */
    dauerfrist: boolean;
}

/** Whole days from `today` (YYYY-MM-DD) until an ISO date; negative = overdue. Matches fristen.ts. */
function daysBetween(today: string, iso: string): number {
    const a = new Date(`${today}T00:00:00Z`).getTime();
    const b = new Date(`${iso}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86_400_000);
}

/** Shift a Saturday/Sunday deadline to the following Monday (§108 Abs. 3 AO; holidays not modelled). */
export function shiftToBusinessDay(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    const dow = d.getUTCDay();
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
    else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/**
 * One month after `iso`, Fristende-style (§108 Abs. 1 AO, §188 Abs. 2–3 BGB): the same day of the
 * next month, clamped to that month's last day when it has no such day (31 Jan → 28/29 Feb).
 */
export function addOneMonthClamped(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    // Day 0 of the month AFTER next = the last day of nextM.
    const lastDay = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return `${nextY}-${String(nextM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse a USt-VA period label into its year + last month, or null for a malformed one. */
function parseUstvaPeriod(period: string): { year: number; endMonth: number } | null {
    const q = period.match(/^(\d{4})-Q([1-4])$/);
    if (q) return { year: Number(q[1]), endMonth: Number(q[2]) * 3 };
    const m = period.match(/^(\d{4})-(\d{2})$/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), endMonth: Number(m[2]) };
    return null;
}

/** Display label per kind + period, e.g. "USt-VA Q1/2026 — Zahllast". */
function zahlungsLabel(kind: string, period: string): string {
    if (kind === 'ustva') {
        const q = period.match(/^(\d{4})-Q([1-4])$/);
        if (q) return `USt-VA Q${q[2]}/${q[1]} — Zahllast`;
        const m = period.match(/^(\d{4})-(\d{2})$/);
        if (m) return `USt-VA ${m[2]}/${m[1]} — Zahllast`;
        return `USt-VA ${period} — Zahllast`;
    }
    if (kind === 'ust-jahr') return `USt-Jahreserklärung ${period} — Abschlusszahlung`;
    if (kind === 'gewst') return `Gewerbesteuer ${period}`;
    if (kind === 'est') return `Einkommensteuer ${period}`;
    return `${kind} ${period}`;
}

const WEEKEND_NOTE = 'Wochenend-Fristende auf Montag verschoben (§108 Abs. 3 AO); Feiertage nicht berücksichtigt.';
const BESCHEID_NOTE =
    'Fälligkeit laut Bescheid (i. d. R. 1 Monat nach Bekanntgabe, §220 AO) — Betrag laut eigener Berechnung.';

/** Kinds whose declarations never create a payment obligation of their own. */
const NO_PAYMENT_KINDS = new Set(['feststellung', 'euer', 'dauerfrist']);

/**
 * Derive the open tax payments from the filing register: every row that is filed, NOT paid and
 * carries a positive Soll (declared, falling back to the legacy amount). See the module doc for
 * the per-kind due-date rules. Sorted by due date (undated Bescheid-driven items last).
 */
export function computeOffeneSteuerzahlungen(
    filings: Filing[],
    entities: SteuerzahlungEntity[],
    today: string,
): OffeneSteuerzahlung[] {
    const byRegisterId = new Map<string, SteuerzahlungEntity>();
    for (const e of entities) for (const id of e.ids) byRegisterId.set(id, e);

    const out: OffeneSteuerzahlung[] = [];
    for (const f of filings) {
        if (f.filedAt == null || f.paidAt != null) continue;
        if (NO_PAYMENT_KINDS.has(f.kind)) continue;
        // The Finanzamt's assessment first: it is what is actually owed. Only without one do we
        // fall back to our own declaration (and, for legacy rows, to the paid/legacy column).
        const amount = f.assessedAmount ?? f.declaredAmount ?? f.amount ?? null;
        if (amount == null || amount <= 0) continue; // nothing open (or an Erstattung)

        const entity = byRegisterId.get(f.entityId);
        let dueDate: string | null = null;
        let note = BESCHEID_NOTE;
        if (f.kind === 'ustva') {
            const p = parseUstvaPeriod(f.period);
            if (p) {
                // Statutory due date of the Voranmeldung itself (§18 Abs. 1 S. 4 UStG) — a late
                // submission does not move it, the amount is simply already overdue.
                dueDate = shiftToBusinessDay(ustvaDeadline(p.year, p.endMonth, entity?.dauerfrist ?? false));
                note = `Zahllast fällig mit der Regelfrist der Voranmeldung (§18 Abs. 1 UStG${
                    entity?.dauerfrist ? ', inkl. Dauerfristverlängerung' : ''
                }). ${WEEKEND_NOTE}`;
            } else {
                note = `Unbekanntes USt-VA-Periodenformat '${f.period}' — Fälligkeit nicht ableitbar.`;
            }
        } else if (f.kind === 'ust-jahr') {
            dueDate = shiftToBusinessDay(addOneMonthClamped(f.filedAt));
            note = `Abschlusszahlung fällig 1 Monat nach Eingang der Erklärung (§18 Abs. 4 UStG). ${WEEKEND_NOTE}`;
        }

        const daysUntil = dueDate ? daysBetween(today, dueDate) : null;
        out.push({
            entityId: entity?.entityId ?? f.entityId,
            entityName: entity?.entityName ?? f.entityId,
            key: `${entity?.entityId ?? f.entityId}:${f.kind}:${f.period}:zahlung`,
            kind: f.kind,
            period: f.period,
            label: zahlungsLabel(f.kind, f.period),
            amount,
            amountSource: f.assessedAmount != null ? 'assessed' : f.declaredAmount != null ? 'declared' : 'legacy',
            filedAt: f.filedAt,
            dueDate,
            daysUntil,
            overdue: daysUntil != null && daysUntil < 0,
            estimated: true,
            note,
        });
    }

    // Rank: dated items by due date ascending (most overdue first), Bescheid-driven undated last.
    out.sort((a, b) => {
        if (a.dueDate && b.dueDate)
            return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.key < b.key ? -1 : 1;
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return a.key < b.key ? -1 : 1;
    });
    return out;
}

/**
 * A recorded Bescheid that does NOT match what we declared.
 *
 * The reason this is its own report rather than a line in the open-payments list: once the
 * Finanzamt assesses a refund, the obligation stops being an open payment and drops out of that
 * list entirely — taking the divergence with it. A 1.446,14 € gap between our declaration and the
 * Finanzamt's own settlement would then have been visible nowhere at all. Every divergence is
 * worth a look, in BOTH directions: a Bescheid demanding more than we declared may be wrong, and
 * one demanding less usually means our Vorauszahlungssoll was incomplete — which is a defect in
 * OUR data that will repeat next year if nobody sees it.
 */
export interface BescheidAbweichung {
    entityId: string;
    entityName: string;
    /** Stable key, e.g. `gbr:ust-jahr:2025:abweichung`. */
    key: string;
    kind: string;
    period: string;
    label: string;
    /** What we declared, in EUR (signed). */
    declared: number;
    /** What the Finanzamt assessed, in EUR (signed); negative = Erstattung. */
    assessed: number;
    /** assessed − declared, in EUR. Negative = the Finanzamt asks for LESS than we declared. */
    difference: number;
    /** Bescheid date (YYYY-MM-DD), or null when not recorded. */
    assessedAt: string | null;
}

/** Round to cents — float noise must not manufacture a divergence. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Every filing whose recorded Bescheid differs from its declared Soll by more than one cent.
 * Pure; sorted by period descending (newest first), like the register itself.
 */
export function computeBescheidAbweichungen(filings: Filing[], entities: SteuerzahlungEntity[]): BescheidAbweichung[] {
    const byRegisterId = new Map<string, SteuerzahlungEntity>();
    for (const e of entities) for (const id of e.ids) byRegisterId.set(id, e);

    const out: BescheidAbweichung[] = [];
    for (const f of filings) {
        if (f.assessedAmount == null) continue;
        // Compare against what we DECLARED. A legacy row without declared_amount has nothing to
        // compare — `amount` there is a payment, and "Bescheid ≠ payment" is a different statement.
        const declared = f.declaredAmount;
        if (declared == null) continue;
        const difference = round2(f.assessedAmount - declared);
        if (Math.abs(difference) <= 0.01) continue;

        const entity = byRegisterId.get(f.entityId);
        out.push({
            entityId: entity?.entityId ?? f.entityId,
            entityName: entity?.entityName ?? f.entityId,
            key: `${entity?.entityId ?? f.entityId}:${f.kind}:${f.period}:abweichung`,
            kind: f.kind,
            period: f.period,
            label: zahlungsLabel(f.kind, f.period),
            declared,
            assessed: f.assessedAmount,
            difference,
            assessedAt: f.assessedAt,
        });
    }
    out.sort((a, b) => (a.period > b.period ? -1 : a.period < b.period ? 1 : a.key < b.key ? -1 : 1));
    return out;
}
