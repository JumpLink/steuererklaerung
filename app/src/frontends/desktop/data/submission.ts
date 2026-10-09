/**
 * Absenden (ELSTER submission) data for the native app — the thin seam the Steuererklärung view calls
 * instead of the core submission actions directly. It maps the app's {@link AppEntity} to the core's
 * entity-id string and passes through to the already-tested, committed core primitives
 * ({@link buildSubmissionOverview} / {@link createFilingSnapshot} / {@link signOffFiling} /
 * {@link submitFiling}). NO business logic lives here: the whole submission state — snapshot status,
 * sign-off validity, the gate + its blockers, test/live readiness, ERiC availability — is derived in
 * core so the app, web and CLI render the exact same picture. The view stays about widgets.
 */

import {
    buildSubmissionOverview,
    snapshotFormsFromPlan,
    ustvaTargetsForYear,
} from '../../../core/actions/elster/submission-overview.ts';
import { createFilingSnapshot } from '../../../core/actions/elster/snapshots.ts';
import { signOffFiling } from '../../../core/actions/elster/signoffs.ts';
import { submitFiling, validateFilingSnapshot } from '../../../core/actions/elster/submit.ts';
import type { AppEntity } from '../entities.ts';
import type { SubmissionTarget } from '../../../core/actions/elster/submission-overview.ts';
import type { FilingFormType, FilingSnapshot } from '../../../core/actions/elster/snapshots.ts';
import type { SignOffResult } from '../../../core/actions/elster/signoffs.ts';
import type { SubmitFilingResult, SnapshotValidationResult } from '../../../core/actions/elster/submit.ts';

export { snapshotFormsFromPlan, ustvaTargetsForYear };

// ELSTER credentials seam (shared with the Konten ERiC card): the configured certificate path plus
// the keyring-backed PIN helpers. The test send pre-fills from these and, on opt-in, persists the PIN.
export { loadKeystorePath, keyringAvailable, lookupElsterPin, storeElsterPin, clearElsterPin } from './eric.ts';
export type {
    SubmissionOverview,
    FormSubmissionState,
    AnnualPlanForm,
    SubmissionTarget,
} from '../../../core/actions/elster/submission-overview.ts';
export type { FilingFormType, FilingSnapshot } from '../../../core/actions/elster/snapshots.ts';
export type { SignOffResult } from '../../../core/actions/elster/signoffs.ts';
export type { SubmitFilingResult, SnapshotValidationResult } from '../../../core/actions/elster/submit.ts';

/**
 * The whole-entity submission overview for a year over the given targets — the annual forms of the
 * plan plus, for a business entity, one row per USt-VA period. One ERiC availability probe +
 * per-target store reads; read-only, mutates nothing.
 */
export function loadSubmissionOverview(entity: AppEntity, year: number, targets: readonly SubmissionTarget[]) {
    return buildSubmissionOverview(entity.id, year, targets);
}

/** Capture an IMMUTABLE snapshot of one form (a safe, local-only write — nothing is transmitted). */
export function captureSnapshot(
    entity: AppEntity,
    year: number,
    form: FilingFormType,
    period?: string,
): Promise<FilingSnapshot> {
    // The period is passed as a LABEL and turned back into a quarter/month here, because that is
    // what the row carries: the view knows "2025-Q3", not "quarter 3 of the config's rhythm".
    return createFilingSnapshot(entity.id, year, form, periodParts(period));
}

/** `2025-Q3` → `{quarter: 3}`, `2025-07` → `{month: 7}`, nothing → the config's own period. */
function periodParts(period?: string): { quarter?: number; month?: number } {
    if (!period) return {};
    const quarter = /^\d{4}-Q([1-4])$/.exec(period);
    if (quarter) return { quarter: Number(quarter[1]) };
    const month = /^\d{4}-(\d{2})$/.exec(period);
    if (month) return { month: Number(month[1]) };
    return {};
}

/**
 * Validate the latest snapshot of a form locally against ERiC and, on success, promote it
 * `draft → validated`. Nothing is transmitted — this is the test-first gate a real (non-Testmerker)
 * artifact needs before a live send, mirroring the CLI `elster snapshot --validate`.
 */
export function validateSnapshot(
    entity: AppEntity,
    year: number,
    form: FilingFormType,
    period?: string,
): Promise<SnapshotValidationResult> {
    return validateFilingSnapshot({ entity: entity.id, year, formType: form, period });
}

/**
 * Record the human RELEASE (sign-off) of the latest snapshot for a form. Throws if there is no
 * snapshot or it is stale (core guard). Returns the sign-off + the machine cross-check verdict
 * captured at release time.
 */
export function releaseSignoff(
    entity: AppEntity,
    year: number,
    form: FilingFormType,
    opts: { note?: string; signedBy?: string; period?: string } = {},
): Promise<SignOffResult> {
    return signOffFiling({
        entity: entity.id,
        year,
        formType: form,
        period: opts.period,
        note: opts.note,
        signedBy: opts.signedBy,
    });
}

/**
 * Send a TEST transmission (Testmerker — discarded at the ELSTER clearing house) via ERiC. Hard-wired
 * to `mode: 'test'`: a live send is a separate, careful step and is intentionally NOT reachable from
 * here. The PIN is passed for this one call and never persisted (core mandate).
 */
export function sendTest(
    entity: AppEntity,
    year: number,
    form: FilingFormType,
    creds: { keystorePath: string; pin: string },
    period?: string,
): Promise<SubmitFilingResult> {
    return submitFiling({
        entity: entity.id,
        year,
        formType: form,
        period,
        mode: 'test',
        keystorePath: creds.keystorePath,
        pin: creds.pin,
    });
}

/**
 * Send a LIVE (verbindlich) transmission via ERiC — the real filing. This is the one irreversible step:
 * it passes `allowLive: true` (the GUI's confirmation dialog IS that opt-in) and records who submitted.
 * The PIN is used for this single call and never persisted here (the caller persists to the keyring only
 * on success). Core still enforces the full release gate (valid sign-off + validated/test-first snapshot
 * + Echt-Artefakt + no double-live) and refuses otherwise — nothing is transmitted on a blocked send.
 */
export function sendLive(
    entity: AppEntity,
    year: number,
    form: FilingFormType,
    creds: { keystorePath: string; pin: string },
    period?: string,
): Promise<SubmitFilingResult> {
    return submitFiling({
        entity: entity.id,
        year,
        formType: form,
        period,
        mode: 'live',
        allowLive: true,
        keystorePath: creds.keystorePath,
        pin: creds.pin,
        // Who filed it, for the audit trail — the entity's configured Datenlieferant.
        submittedBy: entity.elster?.datenlieferant ?? entity.name,
    });
}
