/**
 * Time tracking model.
 *
 * A time entry is one worked interval on a customer project. The store is the system of record —
 * there is no external tracker to sync with any more (the previous CSV-based app is only an
 * import source, see `importSource`).
 *
 * Billing state is NOT a boolean. An entry counts as billed exactly when it carries the id of the
 * invoice it went into (`invoiceId`), which makes the link auditable in both directions: from the
 * invoice you can list what was billed, and an entry can never claim to be billed without saying
 * on which invoice. `billable = false` is the separate case of work that is deliberately not
 * charged (goodwill, internal, warranty) — it is not "unbilled", it is "never to be billed".
 */

/** Where an entry came from. Kept so a reconstructed estimate is never mistaken for a measurement. */
export type TimeEntrySource =
    /** Timer ran, or the interval was typed in by hand. */
    | 'manual'
    /** Imported from the previous tracker's CSV. */
    | 'import'
    /** Reconstructed after the fact (e.g. from commit timestamps) — an ESTIMATE, not a measurement. */
    | 'reconstructed';

export interface TimeEntry {
    id: string;
    /** Workspace entity id (jumplink|gbr|privat) — a free scoping tag, as everywhere else. */
    entityId: string;
    /** Customer this was worked for; null while a timer runs without one assigned yet. */
    contactId: string | null;
    /** Project/engagement label, e.g. "Nordwerk". Free text so a project needs no master record. */
    project: string;
    /**
     * Id of the manifest project this was worked on, or null for entries that only carry the label
     * (everything before projects existed, and imports whose label matched none).
     */
    projectId: string | null;
    description: string | null;
    /** ISO timestamp. */
    startedAt: string;
    /** ISO timestamp, or null while the timer is still running. */
    endedAt: string | null;
    /**
     * Seconds between start and end. Denormalised on stop so reports never re-derive it and a
     * hand-corrected duration (rounding to the billed quarter hour) can differ from the raw
     * interval on purpose.
     */
    durationSeconds: number | null;
    billable: boolean;
    /** Set once the entry went into an invoice — that is what "billed" means here. */
    invoiceId: string | null;
    source: TimeEntrySource;
    /** Id in the system the entry was imported from — the dedupe key for repeated imports. */
    externalId: string | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Fields accepted when creating or updating an entry. */
export interface TimeEntryInput {
    id?: string;
    entityId: string;
    contactId?: string | null;
    project: string;
    projectId?: string | null;
    description?: string | null;
    startedAt: string;
    endedAt?: string | null;
    durationSeconds?: number | null;
    billable?: boolean;
    invoiceId?: string | null;
    source?: TimeEntrySource;
    externalId?: string | null;
    note?: string | null;
}

/** Filter for listing/reporting. All fields are optional and AND-combined. */
export interface TimeEntryFilter {
    entityId?: string;
    contactId?: string;
    project?: string;
    projectId?: string;
    /** ISO date (YYYY-MM-DD) — entries STARTING on or after this day. */
    from?: string;
    /** ISO date (YYYY-MM-DD) — entries STARTING on or before this day. */
    to?: string;
    /** true = only entries not yet on an invoice; false = only billed ones. */
    unbilled?: boolean;
    /** true = only billable entries, false = only non-billable. */
    billable?: boolean;
    /** true = only the running entry (endedAt IS NULL). */
    running?: boolean;
}

/** One row of a grouped report. */
export interface TimeSummaryRow {
    project: string;
    projectId: string | null;
    contactId: string | null;
    entries: number;
    seconds: number;
}
