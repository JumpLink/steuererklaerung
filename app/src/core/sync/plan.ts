/**
 * What to sync, in which order and when — the pure part of the background sync.
 *
 * Three sources feed the app from outside: the Qonto invoice list (and with it the recurring
 * schedules' `lastInvoice`), the Qonto transactions, and the Paperless documents. FinTS (TAN/PIN
 * prompt) and ELSTER (certificate PIN, a legal submission) are NOT sources here: they need a person
 * at the keyboard, so they stay behind their own buttons.
 *
 * No I/O, no clock — callers pass `now` — so every rule below is testable with plain numbers.
 */

export type SyncSource = 'qonto-invoices' | 'qonto-transactions' | 'paperless';

/** Default order when the open view says nothing about what matters. */
export const SYNC_SOURCES: readonly SyncSource[] = ['qonto-invoices', 'qonto-transactions', 'paperless'];

export const SYNC_SOURCE_LABEL: Record<SyncSource, string> = {
    'qonto-invoices': 'Qonto-Rechnungen',
    'qonto-transactions': 'Qonto-Buchungen',
    paperless: 'Paperless',
};

/** What the sync needs to know about the selected entity — already resolved, so this stays pure. */
export interface SyncEntityInfo {
    id: string;
    /** The entity owns a `qonto:` account (the gate in invoices/backend-gate.ts). */
    hasQontoAccount: boolean;
    /** Its invoicing back-end is Qonto (not "self"). */
    invoicingViaQonto: boolean;
    /** Its documents live in Paperless (not the built-in store). */
    usesPaperless: boolean;
}

/**
 * The sources that make sense for this entity. Qonto credentials are global (one organisation), so
 * without a `qonto:` account of its own an entity must never trigger a Qonto call — it would pull in
 * another entity's data.
 */
export function applicableSources(entity: SyncEntityInfo): SyncSource[] {
    const out: SyncSource[] = [];
    if (entity.hasQontoAccount && entity.invoicingViaQonto) out.push('qonto-invoices');
    if (entity.hasQontoAccount) out.push('qonto-transactions');
    if (entity.usesPaperless) out.push('paperless');
    return out;
}

/** The source whose data the open view shows, first in line. Views not listed have none. */
const VIEW_PRIMARY: Record<string, SyncSource> = {
    rechnungen: 'qonto-invoices',
    transactions: 'qonto-transactions',
    konten: 'qonto-transactions',
    review: 'paperless',
};

/** Which sources change what a view shows — so a finished run knows whether to reload it. */
const VIEW_SOURCES: Record<string, readonly SyncSource[]> = {
    rechnungen: ['qonto-invoices'],
    transactions: ['qonto-transactions'],
    konten: ['qonto-transactions'],
    review: ['paperless', 'qonto-transactions'],
    home: ['qonto-invoices', 'qonto-transactions', 'paperless'],
    fristen: ['qonto-invoices', 'qonto-transactions'],
};

/** The open view's own source first, then the rest in default order. Only `sources` are returned. */
export function prioritize(view: string | undefined, sources: readonly SyncSource[]): SyncSource[] {
    const primary = view ? VIEW_PRIMARY[view] : undefined;
    const ordered = SYNC_SOURCES.filter((s) => sources.includes(s));
    if (!primary || !ordered.includes(primary)) return ordered;
    return [primary, ...ordered.filter((s) => s !== primary)];
}

/** Whether a run that changed `changed` should make the open view reload. */
export function affectsView(view: string | undefined, changed: readonly SyncSource[]): boolean {
    const watched = view ? VIEW_SOURCES[view] : undefined;
    return !!watched && changed.some((s) => watched.includes(s));
}

/** Minutes between automatic runs per source; 0 switches that source off. */
export interface SyncSchedule {
    enabled: boolean;
    invoicesMinutes: number;
    transactionsMinutes: number;
    paperlessMinutes: number;
}

export const DEFAULT_SYNC_SCHEDULE: SyncSchedule = {
    enabled: true,
    invoicesMinutes: 15,
    transactionsMinutes: 60,
    paperlessMinutes: 30,
};

/**
 * Floor per source, in minutes. Qonto's API is rate limited and a typo in the settings ("1") must
 * not turn the app into a poller; the floor is applied here, not only in the settings widget.
 */
export const MIN_INTERVAL_MINUTES: Record<SyncSource, number> = {
    'qonto-invoices': 5,
    'qonto-transactions': 15,
    paperless: 5,
};

/** Longest back-off after repeated failures, as a multiple of the interval. */
const MAX_BACKOFF_FACTOR = 8;

export function intervalMinutes(schedule: SyncSchedule, source: SyncSource): number {
    const configured =
        source === 'qonto-invoices'
            ? schedule.invoicesMinutes
            : source === 'qonto-transactions'
              ? schedule.transactionsMinutes
              : schedule.paperlessMinutes;
    if (!schedule.enabled || !(configured > 0)) return 0;
    return Math.max(configured, MIN_INTERVAL_MINUTES[source]);
}

/** Per-source history the scheduler decides from. */
export interface SourceHistory {
    /** Epoch ms of the last attempt (success or failure). */
    lastAttemptAt?: number;
    /** Failures in a row since the last success. */
    failures: number;
}

/**
 * Sources whose automatic run is due at `now`, in priority order. Never attempted → due (that is
 * the run at startup). After failures the wait doubles per failure up to {@link MAX_BACKOFF_FACTOR}×,
 * so a revoked key or an outage is not retried every interval.
 */
export function dueSources(
    now: number,
    history: Partial<Record<SyncSource, SourceHistory>>,
    schedule: SyncSchedule,
    candidates: readonly SyncSource[],
): SyncSource[] {
    return candidates.filter((source) => {
        const minutes = intervalMinutes(schedule, source);
        if (minutes === 0) return false;
        const h = history[source];
        if (h?.lastAttemptAt == null) return true;
        const factor = Math.min(2 ** (h.failures ?? 0), MAX_BACKOFF_FACTOR);
        return now - h.lastAttemptAt >= minutes * 60_000 * factor;
    });
}
