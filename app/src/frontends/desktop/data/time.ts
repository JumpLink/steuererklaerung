/**
 * Zeiten data — the tracker's view model, read straight from the store via the same core actions
 * the CLI uses. Store-only and synchronous; entity-scoped, not year-scoped (a running timer and
 * "what is still unbilled" are not questions about a tax year).
 *
 * Single import surface for the view, like data/contacts.ts.
 */

import {
    addTimeEntry as coreAddTimeEntry,
    assignTimeProject,
    currentTracking,
    customerContacts,
    listTime,
    projectsForContact,
    removeTimeEntry as coreRemoveTimeEntry,
    resolveTimeProject,
    startTracking,
    stopTracking,
    timeProjectLabel,
    timeSummary,
    updateTimeEntry as coreUpdateTimeEntry,
} from '../../../core/actions/time.ts';
import { listProjects } from '../../../core/actions/projects.ts';
import type { Project } from '../../../core/config/index.ts';
import { contactDisplayName } from '@steuererklaerung/store';
import type { Contact, TimeEntry, TimeSummaryRow } from '@steuererklaerung/store';

export type { TimeEntry, TimeSummaryRow } from '@steuererklaerung/store';
export { formatDuration, toHours } from '../../../core/actions/time.ts';
export { createInvoiceFromTime } from '../../../core/actions/time-invoice.ts';
export { buildTimeDays, type TimeDay, type TimeListRow } from '../../../core/presenters/zeiten.ts';

/** Everything the Zeiten view needs in one read. */
export interface TimeViewModel {
    running: TimeEntry | null;
    /** Recent entries, newest first — the day list. */
    recent: TimeEntry[];
    /** Unbilled totals per project, longest first. */
    unbilled: TimeSummaryRow[];
    /** Customers, for the project→customer picker. */
    customers: Contact[];
    /** contactId → display name. */
    names: Map<string, string>;
    /** The entity's manifest projects, for the picker and for resolving an entry's project name. */
    projectList: Project[];
    /** Project labels already used, for the entry completion. */
    projects: string[];
}

/** How far back the day list reaches. Enough to cover a normal billing cycle without paging. */
const RECENT_DAYS = 60;

export function loadTimeView(entityId: string): TimeViewModel {
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const recent = listTime({ entityId, from: since });
    const customers = customerContacts(entityId);
    const names = new Map<string, string>();
    for (const c of customers) names.set(c.id, contactDisplayName(c));
    // Projects come from ALL entries, not just the recent window — an engagement worked on
    // months ago should still autocomplete.
    const projects = [...new Set(listTime({ entityId }).map((e) => e.project))].sort((a, b) =>
        a.localeCompare(b, 'de'),
    );
    return {
        running: currentTracking(entityId),
        recent,
        unbilled: timeSummary({ entityId, unbilled: true, billable: true }),
        customers,
        names,
        projectList: listProjects(entityId),
        projects,
    };
}

export {
    assignTimeProject,
    projectsForContact,
    resolveTimeProject,
    timeProjectLabel,
    coreAddTimeEntry as addTimeEntry,
    coreRemoveTimeEntry as removeTimeEntry,
    coreUpdateTimeEntry as updateTimeEntry,
    startTracking,
    stopTracking,
};
