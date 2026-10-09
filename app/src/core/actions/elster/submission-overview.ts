/**
 * Submission overview — the all-forms-at-once view of "where is each return in the Absenden flow?"
 * for one entity + year. A thin core-first aggregator over the already-tested per-form primitives
 * (snapshot / sign-off gate / submit readiness / ERiC availability) so every front-end (native app,
 * web, CLI) renders the SAME submission state instead of each re-deriving it.
 *
 * Read-only: it gathers state, mutates nothing. The actions themselves (createFilingSnapshot /
 * signOffFiling / submitFiling) stay in their own modules.
 */

import {
    isSnapshotStale,
    latestFilingSnapshot,
    resolveEntityScope,
    type FilingFormType,
    type FilingSnapshot,
} from './snapshots.ts';
import { evaluateSubmissionGate, getSignoffStatus, type SubmissionGate } from './signoffs.ts';
import { evaluateSubmitReadiness } from './submit.ts';
import { getEricStatus } from './eric-status.ts';

/** Human label per snapshot-able form. */
const FORM_TITLE: Record<FilingFormType, string> = {
    ustva: 'Umsatzsteuer-Voranmeldung',
    euer: 'Anlage EÜR',
    uste: 'Umsatzsteuererklärung',
    gewst: 'Gewerbesteuererklärung',
    feststellung: 'Feststellungserklärung',
    est: 'Einkommensteuererklärung',
};

/** The forms shown in the annual submission overview (est is entered by hand in ELSTER; ustva is quarterly). */
export type AnnualPlanForm = 'euer' | 'uste' | 'gewst' | 'feststellung' | 'est';

/** Keep only the snapshot-able annual forms of a plan, in filing order. Since the ESt has an E10-XML
 *  builder + snapshot, `est` is snapshot-/submit-able too (a privat entity). */
export function snapshotFormsFromPlan(forms: readonly AnnualPlanForm[]): FilingFormType[] {
    const order: FilingFormType[] = ['feststellung', 'euer', 'uste', 'gewst', 'est'];
    return order.filter((f) => forms.includes(f as AnnualPlanForm));
}

/** `2025-Q1` → `Q1`, `2025-03` → `03/2025`. The year is already the view's scope. */
function periodSuffix(period: string): string {
    const quarter = /^\d{4}-Q([1-4])$/.exec(period);
    if (quarter) return `Q${quarter[1]}`;
    const month = /^(\d{4})-(\d{2})$/.exec(period);
    if (month) return `${month[2]}/${month[1]}`;
    return period;
}

/**
 * The USt-VA targets of a year — one per period the entity actually files.
 *
 * Read from the entity's own ELSTER period, because that is where its filing rhythm is declared:
 * a monthly filer gets twelve rows, a quarterly one four. Guessing quarters for a monthly filer
 * would offer three periods that do not exist for them.
 */
export function ustvaTargetsForYear(year: number, period: { quarter?: number; month?: number }): SubmissionTarget[] {
    if (period.month != null) {
        return Array.from({ length: 12 }, (_, i) => ({
            form: 'ustva' as const,
            period: `${year}-${String(i + 1).padStart(2, '0')}`,
        }));
    }
    return [1, 2, 3, 4].map((q) => ({ form: 'ustva' as const, period: `${year}-Q${q}` }));
}

/**
 * One thing that can be filed: a form, plus the period when the form is PERIODIC.
 *
 * The overview used to take bare form types, which works only while every form is annual. A USt-VA
 * year is four (or twelve) separate filings with separate snapshots, sign-offs and gates — one row
 * per form could not express that, and asking for `ustva` unscoped answers with whichever period
 * was captured last.
 */
export interface SubmissionTarget {
    form: FilingFormType;
    /** `2025-Q1` / `2025-03` for a USt-VA; omit for the annual forms. */
    period?: string;
}

/** The submission state of one form. */
export interface FormSubmissionState {
    form: FilingFormType;
    /** The period this row is for, when the form is periodic. */
    period?: string;
    title: string;
    /** The latest snapshot for this form, or null when none has been captured. */
    snapshot: FilingSnapshot | null;
    /** The snapshot drifted since capture (data changed). */
    stale: boolean;
    /** A valid, non-revoked, non-drifted sign-off exists. */
    signoffValid: boolean;
    /** German explanation of the sign-off state. */
    signoffReason?: string;
    /** The submission gate (unlocked ⟺ valid sign-off + clean cross-checks). */
    gate: SubmissionGate;
    /** The snapshot carries a `<Testmerker>` (⇒ only a test transmission is possible). */
    isTestArtifact: boolean;
    /** A test transmission is ready (structural guards only). */
    testReady: boolean;
    testBlockers: string[];
    /** A live filing is ready (full release gate + test-first + no double-live + allowLive). */
    liveReady: boolean;
    liveBlockers: string[];
}

/** The whole-entity submission picture for a year. */
export interface SubmissionOverview {
    entityId: string;
    year: number;
    /** ERiC installed AND its binding loadable (required before any real send). */
    ericAvailable: boolean;
    ericVersion: string | null;
    forms: FormSubmissionState[];
}

/**
 * Build the {@link SubmissionOverview} for an entity + year over the given snapshot-able forms
 * (typically {@link snapshotFormsFromPlan} of the tax-return plan). One ERiC availability probe +
 * per-form store reads; contacts no network for the forms themselves.
 */
export async function buildSubmissionOverview(
    entity: string,
    year: number,
    targets: readonly SubmissionTarget[],
): Promise<SubmissionOverview> {
    const scope = resolveEntityScope(entity);
    const eric = await getEricStatus(scope.elster?.eric_home);

    const states: FormSubmissionState[] = targets.map(({ form, period }) => {
        const snapshot = latestFilingSnapshot(entity, year, form, period);
        const signoff = getSignoffStatus({ entity, year, formType: form, period });
        const gate = evaluateSubmissionGate({ entity, year, formType: form, period });
        const test = evaluateSubmitReadiness({ entity, year, formType: form, period, mode: 'test' });
        const live = evaluateSubmitReadiness({
            entity,
            year,
            formType: form,
            period,
            mode: 'live',
            allowLive: true,
        });
        return {
            form,
            period,
            // The period is part of the NAME here, not a detail below it: four USt-VA rows whose
            // titles all read "Umsatzsteuer-Voranmeldung" are four rows nobody can act on.
            title: period ? `${FORM_TITLE[form]} ${periodSuffix(period)}` : FORM_TITLE[form],
            snapshot,
            stale: snapshot ? isSnapshotStale(snapshot) : false,
            signoffValid: signoff.valid,
            signoffReason: signoff.reason ?? undefined,
            gate,
            isTestArtifact: test.isTestArtifact,
            testReady: test.ready,
            testBlockers: test.blockers,
            liveReady: live.ready,
            liveBlockers: live.blockers,
        };
    });

    return {
        entityId: entity,
        year,
        ericAvailable: eric.available,
        ericVersion: eric.version,
        forms: states,
    };
}
