/**
 * Zeiterfassung — orchestration shared by the CLI, MCP, web UI and the native app.
 *
 * Our SQLite store is the system of record. There is no external tracker to sync with: the
 * previous CSV-based app is an IMPORT SOURCE only (`importTimeCsv`), so its rows arrive once,
 * keyed by their old id, and are never written back.
 *
 * Why this lives in the app at all: the point of tracking time here rather than in a separate
 * tool is that the customer master and the invoices are already here. An entry links to a
 * `contact`, and billing an entry means attaching it to an invoice — so "what is still unbilled"
 * is a query, not a spreadsheet column somebody has to maintain by hand.
 */

import type { Project } from '../config/index.ts';
import { listProjects, matchProjectByName, normalizeLabel } from './projects.ts';
import {
    type Contact,
    contactDisplayName,
    deleteTimeEntry,
    findTimeEntryByExternalId,
    getRunningTimeEntry,
    getTimeEntry,
    type LedgerDatabase,
    ledgerDbPath,
    listContacts,
    listTimeEntries,
    markTimeEntriesInvoiced,
    migrate,
    openLedger,
    startTimeEntry,
    stopTimeEntry,
    summarizeTime,
    type TimeEntry,
    type TimeEntryFilter,
    type TimeEntryInput,
    type TimeSummaryRow,
    upsertTimeEntry,
} from '@steuererklaerung/store';

/** Today's instant as an ISO timestamp (single place so callers can reason about it). */
function nowIso(): string {
    return new Date().toISOString();
}

/** Open + migrate + close the ledger around a synchronous `fn`. */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

/** `3661` → `01:01:01`. The report format; seconds stay visible because entries are often short. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Decimal hours, rounded to 2 places — the unit an invoice line is written in. */
export function toHours(seconds: number): number {
    return Math.round((seconds / 3600) * 100) / 100;
}

export interface StartTimeInput {
    entityId: string;
    project: string;
    projectId?: string | null;
    description?: string | null;
    contactId?: string | null;
    /** ISO timestamp; defaults to now. Lets a forgotten start be entered after the fact. */
    startedAt?: string;
    billable?: boolean;
}

/** Start the timer. Fails loudly if one is already running for the entity (see the repo). */
export function startTracking(input: StartTimeInput): TimeEntry {
    const at = nowIso();
    return withLedger((db) =>
        startTimeEntry(
            db,
            {
                entityId: input.entityId,
                project: input.project,
                projectId: input.projectId ?? null,
                description: input.description ?? null,
                contactId: input.contactId ?? null,
                startedAt: input.startedAt ?? at,
                billable: input.billable ?? true,
                source: 'manual',
            },
            at,
        ),
    );
}

/** Stop the running timer (or a specific entry). */
export function stopTracking(entityId: string, id?: string, endedAt?: string): TimeEntry {
    const at = endedAt ?? nowIso();
    return withLedger((db) => stopTimeEntry(db, entityId, at, id));
}

/** The entry currently running for this entity, or null. */
export function currentTracking(entityId: string): TimeEntry | null {
    return withLedger((db) => getRunningTimeEntry(db, entityId));
}

/** Record a finished interval in one go — the path for "I forgot to start the timer". */
export function addTimeEntry(input: TimeEntryInput): TimeEntry {
    return withLedger((db) => upsertTimeEntry(db, input, nowIso()));
}

export function updateTimeEntry(input: TimeEntryInput & { id: string }): TimeEntry {
    return withLedger((db) => upsertTimeEntry(db, input, nowIso()));
}

export function removeTimeEntry(id: string): void {
    withLedger((db) => deleteTimeEntry(db, id));
}

export function listTime(filter: TimeEntryFilter): TimeEntry[] {
    return withLedger((db) => listTimeEntries(db, filter));
}

export function timeSummary(filter: TimeEntryFilter): TimeSummaryRow[] {
    return withLedger((db) => summarizeTime(db, filter));
}

/** Attach entries to an invoice — this is what marks them billed. Returns how many changed. */
export function billTimeEntries(ids: readonly string[], invoiceId: string): number {
    return withLedger((db) => markTimeEntriesInvoiced(db, ids, invoiceId, nowIso()));
}

/** Resolve a contact id to a display name, for reports. */
export function contactNames(entityId: string): Map<string, string> {
    return withLedger((db) => {
        const map = new Map<string, string>();
        for (const c of listContacts(db, entityId)) map.set(c.id, contactDisplayName(c));
        return map;
    });
}

// --- Import from the previous tracker -------------------------------------------------------

/** One parsed CSV row of the old tracker (`Project,Start Time,End Time,Description,ID,Billed,…`). */
export interface LegacyTimeRow {
    project: string;
    startedAt: string;
    endedAt: string;
    description: string;
    externalId: string;
    billed: boolean;
}

/**
 * Split a CSV line honouring double quotes.
 *
 * Hand-rolled rather than pulled in as a dependency: this parses exactly one known file, and the
 * old tracker writes its dates UNQUOTED with commas inside them
 * ("Mon Jul 08 2024 10:20:48 GMT+0200 (Mitteleuropäische Sommerzeit)" is fine, but descriptions
 * may contain commas and then ARE quoted). A generic parser would be more code, not less risk.
 */
export function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else inQuotes = false;
            } else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') {
            out.push(field);
            field = '';
        } else field += ch;
    }
    out.push(field);
    return out;
}

/**
 * Parse the old tracker's CSV.
 *
 * Its timestamps are JS `Date.toString()` output ("Mon Jul 08 2024 10:20:48 GMT+0200 (…)"), which
 * `Date.parse` accepts including the offset — so the instant is preserved exactly and we store it
 * normalised as ISO/UTC. Rows without a parseable start or end are reported, never guessed.
 */
export function parseLegacyTimeCsv(csv: string): { rows: LegacyTimeRow[]; skipped: string[] } {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows: LegacyTimeRow[] = [];
    const skipped: string[] = [];
    for (const line of lines.slice(1)) {
        const cols = splitCsvLine(line);
        const [project, start, end, description, externalId, billed] = cols;
        const startMs = Date.parse(start ?? '');
        const endMs = Date.parse(end ?? '');
        if (!project || Number.isNaN(startMs) || Number.isNaN(endMs)) {
            skipped.push(line);
            continue;
        }
        rows.push({
            project: project.trim(),
            startedAt: new Date(startMs).toISOString(),
            endedAt: new Date(endMs).toISOString(),
            description: (description ?? '').trim(),
            externalId: (externalId ?? '').trim(),
            billed: (billed ?? '').trim().toLowerCase() === 'true',
        });
    }
    return { rows, skipped };
}

/** The part of a manifest project a time entry needs: which one, its label, and whose it is. */
export interface TimeProjectRef {
    id: string;
    name: string;
    contactId: string;
}

export interface ImportTimeResult {
    imported: number;
    skippedExisting: number;
    unparsable: string[];
    /** Project labels with no matching project or customer — imported, but contact_id stays null. */
    unmatchedProjects: string[];
}

/** The import note: the old billed flag, and the original label when the project's name replaced it. */
function importNote(row: LegacyTimeRow, project: TimeProjectRef | null): string | null {
    const notes = [
        row.billed ? 'Import: im alten Tracker als abgerechnet markiert (ohne Rechnungsbezug)' : null,
        project && project.name !== row.project ? `Import-Label: ${row.project}` : null,
    ].filter(Boolean);
    return notes.length ? notes.join('; ') : null;
}

/**
 * Import parsed rows.
 *
 * Already-imported rows (same `externalId` in this entity) are LEFT ALONE, not overwritten: after
 * an import the entries are ours, may have been corrected here, and the CSV is a snapshot of a
 * tool we no longer use.
 *
 * `billed: true` in the old file cannot be honoured faithfully — it names no invoice, and billed
 * means "on invoice X" here. Such rows are imported as non-billable with a note, so they neither
 * vanish nor show up as still-to-invoice.
 *
 * `resolveProject` maps a label to a project of the manifest: a hit sets `projectId` and takes the
 * customer from the project. No project is ever created here — a label that matches nothing is
 * imported as before (label only) and reported in `unmatchedProjects` when it has no customer either.
 */
export function importTimeRows(
    entityId: string,
    rows: readonly LegacyTimeRow[],
    projectToContact: (project: string) => string | null,
    resolveProject: (label: string) => TimeProjectRef | null = () => null,
): ImportTimeResult {
    const at = nowIso();
    const unmatched = new Set<string>();
    let imported = 0;
    let skippedExisting = 0;

    withLedger((db) => {
        for (const row of rows) {
            if (row.externalId && findTimeEntryByExternalId(db, entityId, row.externalId)) {
                skippedExisting += 1;
                continue;
            }
            const project = resolveProject(row.project);
            const contactId = project?.contactId ?? projectToContact(row.project);
            if (!contactId) unmatched.add(row.project);
            upsertTimeEntry(
                db,
                {
                    entityId,
                    contactId,
                    project: project?.name ?? row.project,
                    projectId: project?.id ?? null,
                    description: row.description || null,
                    startedAt: row.startedAt,
                    endedAt: row.endedAt,
                    billable: !row.billed,
                    source: 'import',
                    externalId: row.externalId || null,
                    note: importNote(row, project),
                },
                at,
            );
            imported += 1;
        }
    });

    return { imported, skippedExisting, unparsable: [], unmatchedProjects: [...unmatched] };
}

/**
 * Match a project label to a customer contact by name.
 *
 * Deliberately conservative: a normalised substring match in EITHER direction, and only when
 * exactly ONE customer matches. "Nordwerk" hits "Nordwerk Studios GmbH";
 * an ambiguous label stays unassigned rather than being attached to the wrong customer, which
 * would later put worked hours on somebody else's invoice.
 */
export function matchProjectToContact(project: string, contacts: readonly Contact[]): string | null {
    const norm = normalizeLabel;
    const p = norm(project);
    if (!p) return null;
    const hits = contacts.filter((c) => {
        if (!c.isCustomer) return false;
        const name = norm(contactDisplayName(c));
        return name.includes(p) || p.includes(name);
    });
    return hits.length === 1 ? hits[0].id : null;
}

/** Customers of an entity — the candidate set for `matchProjectToContact`. */
export function customerContacts(entityId: string): Contact[] {
    return withLedger((db) => listContacts(db, entityId).filter((c) => c.isCustomer));
}

/** Look up one entry by id (for the frontends' edit paths). */
export function findTimeEntry(id: string): TimeEntry | null {
    return withLedger((db) => getTimeEntry(db, id));
}

// --- Projects ---------------------------------------------------------------------------------

/** What a time entry stores about its project: the label, the manifest project's id and its customer. */
export interface TimeProjectTarget {
    project: string;
    projectId: string | null;
    contactId: string | null;
}

/**
 * Resolve a project argument (id or name) to what an entry stores.
 *
 * A hit sets the project id, takes the project's name as the label (so one project is one line on an
 * invoice) and its customer as the contact. A free label stays a label. A `contact` that contradicts
 * the project's customer is refused: hours on the wrong customer's invoice are the mistake this link
 * exists to prevent.
 */
export function resolveTimeProject(
    entityId: string,
    label: string,
    contact?: string | null,
    projects: readonly Project[] = listProjects(entityId),
): TimeProjectTarget {
    const hit = projects.find((p) => p.id === label) ?? matchProjectByName(label, projects, contact);
    if (!hit) return { project: label, projectId: null, contactId: contact ?? null };
    if (contact && contact !== hit.contactId) {
        throw new Error(`Projekt „${hit.name}" gehört zu Kontakt ${hit.contactId}, nicht zu ${contact}.`);
    }
    return { project: hit.name, projectId: hit.id, contactId: hit.contactId };
}

/** The projects an entry of this customer may be put on; all of them while the customer is unknown. */
export function projectsForContact(projects: readonly Project[], contactId?: string | null): Project[] {
    return contactId ? projects.filter((p) => p.contactId === contactId) : [...projects];
}

/**
 * The name to show for an entry or a summary row: the manifest project's current name when its id
 * resolves, otherwise the stored label (also for a `projectId` whose project has since been deleted).
 */
export function timeProjectLabel(
    row: { project: string; projectId: string | null },
    projects: readonly Project[],
): string {
    return (row.projectId ? projects.find((p) => p.id === row.projectId)?.name : undefined) ?? row.project;
}

/**
 * Put a finished, unbilled entry on a project, or take it off one (`null` keeps the label and the
 * customer, drops only the link). The project must belong to the entry's customer when it has one;
 * an entry without a customer takes the project's.
 */
export function assignTimeProject(id: string, projectId: string | null): TimeEntry {
    const entry = findTimeEntry(id);
    if (!entry) throw new Error(`Kein Zeiteintrag mit der Id ${id}`);
    if (entry.invoiceId) throw new Error(`Eintrag ${id} steht auf Rechnung ${entry.invoiceId} und bleibt unverändert.`);
    if (projectId === null) return updateTimeEntry({ ...entry, projectId: null });
    const project = listProjects(entry.entityId).find((p) => p.id === projectId);
    if (!project) throw new Error(`Projekt „${projectId}" gibt es für ${entry.entityId} nicht.`);
    if (entry.contactId && entry.contactId !== project.contactId) {
        throw new Error(
            `Projekt „${project.name}" gehört zu Kontakt ${project.contactId}, nicht zu ${entry.contactId}.`,
        );
    }
    return updateTimeEntry({ ...entry, project: project.name, projectId: project.id, contactId: project.contactId });
}
