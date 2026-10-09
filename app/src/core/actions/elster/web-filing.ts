/**
 * Record a completed WEB-FORM submission — the annual returns are hand-entered in Mein ELSTER (no
 * Hersteller-ID ⇒ no ERiC transmission), so the tooling never learns they were filed. This action
 * closes that gap: it (a) captures a FRESH filing snapshot from the CURRENT computed figures (so the
 * durable record is not stale — the whole point, since the old snapshots sat on `draft` with stale
 * numbers), (b) marks that snapshot `submitted` with the user-supplied Transferticket + submission date
 * and `source='web-form'` (distinguishable from an ERiC send), and (c) records the filing register row
 * so `list_filings` shows the obligation as done with its Transferticket.
 *
 * The Transferticket is REQUIRED input and never fabricated — it is the only durable proof of what was
 * actually transmitted (it comes off the Übertragungsprotokoll PDF). `est` has no ELSTER XML builder,
 * so it gets the register row only (no snapshot).
 */

import type { Filing } from '@steuererklaerung/store';
import { createFilingSnapshot, markFilingSnapshotSubmitted, type FilingSnapshot } from './snapshots.ts';
import { recordFiling } from '../filings.ts';
import { FILING_FORMS, filingKindForForm, type FilingForm } from './filing-keys.ts';

/** Forms that can be recorded as a web submission (the snapshot-able forms + `est`, which has no XML). */
export const WEB_FILING_FORMS = FILING_FORMS;
export type WebFilingForm = FilingForm;

/** Whether the form has an ELSTER XML builder and can therefore be captured as a filing snapshot. */
function isSnapshotableForm(form: WebFilingForm): boolean {
    return form !== 'est';
}

/**
 * Build the filing-register `period` key: `2026-Q1` / `2026-03` for a USt-VA, plain `2025` for the
 * annual forms. The register is keyed by (entity, kind, period) — recording a USt-VA under the bare
 * year would make Q1..Q4 overwrite each other and silently corrupt the Vorauszahlungssoll (Z119),
 * which sums the year's UStVA rows.
 */
function filingPeriod(opts: Pick<RecordWebFilingOptions, 'form' | 'year' | 'quarter' | 'month'>): string {
    const { form, year, quarter, month } = opts;
    if (quarter != null && month != null)
        throw new Error('--quarter und --month schließen sich aus — bitte nur eines angeben.');
    if (form !== 'ustva') {
        if (quarter != null || month != null)
            throw new Error(
                `Formular '${form}' ist eine Jahreserklärung — --quarter/--month sind hier nicht zulässig.`,
            );
        return String(year);
    }
    if (quarter != null) {
        if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)
            throw new Error(`Ungültiges Quartal '${quarter}' — erwartet 1–4.`);
        return `${year}-Q${quarter}`;
    }
    if (month != null) {
        if (!Number.isInteger(month) || month < 1 || month > 12)
            throw new Error(`Ungültiger Monat '${month}' — erwartet 1–12.`);
        return `${year}-${String(month).padStart(2, '0')}`;
    }
    throw new Error('Eine USt-VA braucht ihren Voranmeldungszeitraum: --quarter 1–4 oder --month 1–12.');
}

export interface RecordWebFilingOptions {
    /** Workspace entity id (gbr|jumplink|privat). */
    entity: string;
    year: number;
    /**
     * Voranmeldungszeitraum for `ustva` — quarter 1–4, mutually exclusive with {@link month}.
     * The register is keyed by (entity, kind, period), so a USt-VA MUST carry its period or the
     * four quarters of a year would collide on a single `<year>` row.
     */
    quarter?: number;
    /** Voranmeldungszeitraum for a monthly `ustva` — month 1–12, mutually exclusive with {@link quarter}. */
    month?: number;
    /** Form type (ustva|euer|uste|gewst|feststellung|est). */
    form: WebFilingForm;
    /** ELSTER Transferticket from the Übertragungsprotokoll — REQUIRED, never fabricated. */
    transferticket: string;
    /** Submission date (YYYY-MM-DD); defaults to today. */
    date?: string;
    /** Who recorded it (stored in the filing note); optional. */
    recordedBy?: string;
    /**
     * Anmeldungssoll — the DECLARED Zahllast in EUR (signed). The authoritative Soll that feeds the
     * annual USt-Jahreserklärung's Vorauszahlungssoll (Z119). Optional; recorded on the register row.
     */
    declared?: number;
    /** Amount actually PAID in EUR (signed; paid/legacy value, may include a Säumniszuschlag). Optional. */
    paid?: number;
    /** Säumniszuschlag / steuerliche Nebenleistung (§240 AO) in EUR (signed) — NOT USt. Optional. */
    surcharge?: number;
}

export interface RecordWebFilingResult {
    /** The fresh, `submitted`-marked snapshot; null for `est` (no XML builder). */
    snapshot: FilingSnapshot | null;
    /** The filing register row (shows as filed with the Transferticket in list_filings). */
    filing: Filing;
}

/** Validate + normalise a Transferticket (must be present); it is never fabricated. */
function requireTransferticket(raw: string): string {
    const t = raw?.trim();
    if (!t) {
        throw new Error('Transferticket erforderlich — es steht auf dem Übertragungsprotokoll und wird nicht erzeugt.');
    }
    return t;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The decidable outcome of a record-web request: mapping + validation + note, WITHOUT any store I/O. */
export interface WebFilingPlan {
    entityId: string;
    form: WebFilingForm;
    year: number;
    /** Filing register `kind` for the form. */
    kind: string;
    /** Period label (the year, for the annual forms). */
    period: string;
    /** Resolved submission date (YYYY-MM-DD). */
    date: string;
    /** The register note — carries the Transferticket so list_filings surfaces it. */
    note: string;
    /** Whether a filing snapshot will be captured (false for `est`, which has no XML builder). */
    snapshotable: boolean;
    /** The validated Transferticket. */
    transferticket: string;
    /** Anmeldungssoll (declared Zahllast) in EUR for the register row, or undefined if not given. */
    declared?: number;
    /** Amount actually paid in EUR for the register row, or undefined if not given. */
    paid?: number;
    /** Säumniszuschlag / Nebenleistung in EUR for the register row, or undefined if not given. */
    surcharge?: number;
}

/**
 * Pure planning step: validate the Transferticket + form + date, map the form to its filing `kind`,
 * and build the register note. No store, no workspace, no snapshot — so it is unit-testable on plain
 * inputs. {@link recordWebFiling} runs this first, then performs the store writes.
 */
export function planWebFiling(
    opts: RecordWebFilingOptions,
    today = new Date().toISOString().slice(0, 10),
): WebFilingPlan {
    const transferticket = requireTransferticket(opts.transferticket);
    if (!WEB_FILING_FORMS.includes(opts.form)) {
        throw new Error(`Unbekannter Formulartyp '${opts.form}'. Erlaubt: ${WEB_FILING_FORMS.join(', ')}.`);
    }
    const date = opts.date?.trim() || today;
    if (!DATE_RE.test(date)) throw new Error(`Ungültiges Datum '${date}' — erwartet YYYY-MM-DD.`);
    const by = opts.recordedBy?.trim();
    return {
        entityId: opts.entity,
        form: opts.form,
        year: opts.year,
        kind: filingKindForForm(opts.form),
        period: filingPeriod(opts),
        date,
        note: `Web-Formular · Transferticket ${transferticket}${by ? ` · erfasst von ${by}` : ''}`,
        snapshotable: isSnapshotableForm(opts.form),
        transferticket,
        declared: opts.declared,
        paid: opts.paid,
        surcharge: opts.surcharge,
    };
}

/**
 * Record a manual (web-form) submission for one entity + form + year. See the module doc: fresh
 * snapshot → mark submitted (source='web-form' + ticket + date) → filing register row. Async because
 * capturing the snapshot recomputes the current figures + XML.
 */
export async function recordWebFiling(opts: RecordWebFilingOptions): Promise<RecordWebFilingResult> {
    const plan = planWebFiling(opts);

    let snapshot: FilingSnapshot | null = null;
    if (plan.snapshotable) {
        const fresh = await createFilingSnapshot(plan.entityId, plan.year, plan.form);
        snapshot = markFilingSnapshotSubmitted(fresh.id, {
            transferTicket: plan.transferticket,
            source: 'web-form',
            submittedAt: plan.date,
        });
    }

    const filing = recordFiling({
        entityId: plan.entityId,
        kind: plan.kind,
        period: plan.period,
        filedAt: plan.date,
        note: plan.note,
        declaredAmount: plan.declared,
        amount: plan.paid,
        surcharge: plan.surcharge,
    });

    return { snapshot, filing };
}
