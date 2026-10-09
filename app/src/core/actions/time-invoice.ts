/**
 * Rechnung aus erfassten Zeiten.
 *
 * Turns unbilled time entries into a DRAFT invoice and RESERVES them for it. The draft is the
 * deliberate stopping point: numbering, finalisation and immutability are the invoice module's
 * job (GoBD), and a human should see the lines before they get a number. The entries count as billed
 * (`time_entries.invoice_id`) only once the invoice is finalized.
 *
 * The Leistungszeitraum is not asked for — it IS the span of the billed entries. That is the whole
 * reason for tracking time in the same place as the invoices: the performance period on the
 * invoice is derived from measured work instead of being typed in from memory.
 */

import {
    clearInvoiceTimeLinks,
    createInvoiceDraft,
    getInvoiceTimeLinks,
    getReservedTimeEntries,
    getTimeEntry,
    type InvoiceItemInput,
    ledgerDbPath,
    type LedgerDatabase,
    listTimeEntries,
    markTimeEntriesInvoiced,
    migrate,
    openLedger,
    setInvoiceTimeLinks,
    type StoredInvoice,
    type TimeEntry,
} from '@steuererklaerung/store';
import type { InvoiceItemSpec } from '../clients/qonto/client-invoices.ts';
import { formatDuration, toHours } from './time.ts';

function nowIso(): string {
    return new Date().toISOString();
}

function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

export interface BillTimeOptions {
    entityId: string;
    /** Bill this customer's entries. */
    contactId: string;
    /** Restrict to one project (otherwise every unbilled project of the customer becomes one item). */
    project?: string;
    /** ISO dates bounding which entries are billed. */
    from?: string;
    to?: string;
    /** Net price per hour. Required — there is no rate in the master data yet. */
    hourlyRate: number;
    /** VAT as a fraction, e.g. 0.19. */
    vatRate: number;
    /**
     * Round each project's total UP to a multiple of this many minutes (0 = exact).
     * Rounding per project, not per entry: rounding every five-minute entry up to a quarter hour
     * would inflate a day of small fixes into something the customer cannot recognise.
     */
    roundToMinutes?: number;
    issueDate?: string;
    dueDate?: string;
}

export interface BillTimeResult {
    invoice: StoredInvoice;
    entries: TimeEntry[];
    /** One line per project, as it went onto the invoice. */
    lines: { project: string; seconds: number; hours: number; entries: number }[];
}

/** Round seconds UP to a multiple of `minutes`; 0/undefined leaves them untouched. */
export function roundSecondsUp(seconds: number, minutes: number | undefined): number {
    if (!minutes || minutes <= 0) return seconds;
    const step = minutes * 60;
    return Math.ceil(seconds / step) * step;
}

/**
 * Build the description of one invoice line: the individual sessions, so the customer can see
 * what the hours consist of. Without this an invoice line is just a number and every question
 * about it turns into an archaeology exercise.
 */
export function describeEntries(entries: readonly TimeEntry[]): string {
    return entries
        .slice()
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((e) => {
            const day = new Date(e.startedAt).toLocaleDateString('de-DE');
            const dur = formatDuration(e.durationSeconds ?? 0);
            return e.description ? `${day}, ${dur} — ${e.description}` : `${day}, ${dur}`;
        })
        .join('\n');
}

/** What the entries turn into on the invoice — the whole arithmetic, without a database. */
export interface TimeInvoiceDraft {
    items: InvoiceItemInput[];
    lines: BillTimeResult['lines'];
    /** Leistungszeitraum, derived from the entries (YYYY-MM-DD). */
    performanceStart: string;
    performanceEnd: string;
}

/**
 * Turn entries into invoice lines — one line per project.
 *
 * Kept pure and separate from the ledger so the part that decides what a customer is charged can
 * be tested directly. Rounding happens per project total, not per entry: rounding every
 * five-minute fix up to a quarter hour would inflate a day of small changes into something the
 * customer cannot recognise in their own inbox.
 */
export function buildTimeInvoice(
    entries: readonly TimeEntry[],
    options: Pick<BillTimeOptions, 'hourlyRate' | 'vatRate' | 'roundToMinutes'>,
): TimeInvoiceDraft {
    if (entries.length === 0) throw new Error('Keine offenen, abrechenbaren Zeiten für diese Auswahl.');

    const byProject = new Map<string, TimeEntry[]>();
    for (const e of entries) {
        const list = byProject.get(e.project) ?? [];
        list.push(e);
        byProject.set(e.project, list);
    }

    const items: InvoiceItemInput[] = [];
    const lines: BillTimeResult['lines'] = [];
    for (const [project, list] of byProject) {
        const raw = list.reduce((sum, e) => sum + (e.durationSeconds ?? 0), 0);
        const seconds = roundSecondsUp(raw, options.roundToMinutes);
        const hours = toHours(seconds);
        items.push({
            title: project,
            description: describeEntries(list),
            quantity: hours,
            unit: 'Std',
            unitPriceNet: options.hourlyRate,
            vatRate: options.vatRate,
        });
        lines.push({ project, seconds, hours, entries: list.length });
    }

    // Leistungszeitraum = the span actually worked.
    const starts = entries.map((e) => e.startedAt).sort();
    const ends = entries.map((e) => e.endedAt ?? e.startedAt).sort();
    const day = (iso: string) => iso.slice(0, 10);

    return {
        items,
        lines,
        performanceStart: day(starts[0]),
        performanceEnd: day(ends[ends.length - 1]),
    };
}

// --- Zeiten als Rechnungspositionen (Rechnung ↔ Projekt) -------------------------------------

/** How the entries become lines: one line per task description, or one line for everything. */
export type TimeGrouping = 'task' | 'gesamt';

export interface TimeLine {
    title: string;
    description: string;
    /** Hours, rounded to 2 decimals (see {@link toHours}). */
    quantity: number;
    unit: 'Stunde';
    unitPriceNet: number;
    /** Fraction, e.g. 0.19. */
    vatRate: number;
    /** quantity × unitPriceNet, rounded to the cent. */
    net: number;
    entryIds: string[];
}

export interface TimeLines {
    lines: TimeLine[];
    /** First and last entry date (local calendar day, YYYY-MM-DD) — the Leistungszeitraum. */
    performanceStart: string;
    performanceEnd: string;
    entryIds: string[];
    net: number;
}

/** Local calendar day of an ISO timestamp: an entry started at 00:30 local time belongs to that day, not to the UTC one. */
export function localDay(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Turn the chosen open entries into invoice lines. The unit is „Stunde", the quantity the line's seconds
 * in hours rounded to 2 decimals, the line net quantity × unit price rounded to the cent — so the invoice
 * shows exactly the figures it multiplies. The Leistungszeitraum is the first..last entry date.
 *
 * `task` groups by the entry description (trimmed, case-insensitive; an entry without one goes under
 * `fallbackTitle`); `gesamt` is one line titled `fallbackTitle`. There is no default rate: a missing or
 * non-positive one throws, so no price is ever invented.
 */
export function buildTimeLines(
    entries: readonly TimeEntry[],
    options: { grouping: TimeGrouping; hourlyRate: number | null | undefined; vatRate: number; fallbackTitle: string },
): TimeLines {
    if (entries.length === 0) throw new Error('Keine Zeiteinträge ausgewählt.');
    const rate = options.hourlyRate;
    if (rate == null || !Number.isFinite(rate) || rate <= 0) {
        throw new Error('Stundensatz fehlt — bitte einen Netto-Stundensatz angeben.');
    }
    const sorted = [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const groups = new Map<string, { title: string; entries: TimeEntry[] }>();
    for (const e of sorted) {
        const desc = (e.description ?? '').trim();
        const key = options.grouping === 'gesamt' ? '' : desc ? desc.toLowerCase() : '\u0000';
        const title = options.grouping === 'gesamt' || !desc ? options.fallbackTitle : desc;
        const g = groups.get(key) ?? { title, entries: [] };
        g.entries.push(e);
        groups.set(key, g);
    }
    const lines: TimeLine[] = [...groups.values()].map((g) => {
        const quantity = toHours(g.entries.reduce((s, e) => s + (e.durationSeconds ?? 0), 0));
        return {
            title: g.title,
            description: describeEntries(g.entries),
            quantity,
            unit: 'Stunde',
            unitPriceNet: rate,
            vatRate: options.vatRate,
            net: Math.round(quantity * rate * 100) / 100,
            entryIds: g.entries.map((e) => e.id),
        };
    });
    const days = sorted.map((e) => localDay(e.startedAt)).sort();
    return {
        lines,
        performanceStart: days[0],
        performanceEnd: days[days.length - 1],
        entryIds: sorted.map((e) => e.id),
        net: Math.round(lines.reduce((s, l) => s + Math.round(l.net * 100), 0)) / 100,
    };
}

/** A time line in the shape the invoice providers take. */
export function timeLineToItemSpec(line: TimeLine): InvoiceItemSpec {
    return {
        title: line.title,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unitPriceNet,
        vat_rate: line.vatRate,
    };
}

/**
 * Create a draft invoice from a customer's unbilled time and RESERVE the entries for it.
 *
 * The entries stay open until the invoice is finalized (`settleTimeOnFinalize`): a draft that is
 * deleted leaves the hours billable, and a number is only spent on a finalized invoice. Invoice and
 * reservation are written in ONE ledger session.
 */
export function createInvoiceFromTime(options: BillTimeOptions): BillTimeResult {
    const at = nowIso();
    return withLedger((db) => {
        const reserved = getReservedTimeEntries(db, options.entityId);
        const entries = listTimeEntries(db, {
            entityId: options.entityId,
            contactId: options.contactId,
            project: options.project,
            from: options.from,
            to: options.to,
            unbilled: true,
            billable: true,
            running: false,
        }).filter((e) => !reserved.has(e.id));
        const built = buildTimeInvoice(entries, options);
        const { items, lines } = built;

        const invoice = createInvoiceDraft(
            db,
            {
                entityId: options.entityId,
                contactId: options.contactId,
                issueDate: options.issueDate ?? at.slice(0, 10),
                dueDate: options.dueDate ?? null,
                performanceStart: built.performanceStart,
                performanceEnd: built.performanceEnd,
                items,
            },
            at,
        );

        setInvoiceTimeLinks(
            db,
            options.entityId,
            invoice.id,
            entries.map((e) => e.id),
        );

        return { invoice, entries, lines };
    });
}

/** The open entries a new invoice may take: unbilled, billable, stopped, and not reserved by ANOTHER draft. */
export function listOpenTimeForInvoice(
    entityId: string,
    filter: { contactId?: string; projectId?: string; project?: string },
    exceptInvoiceId?: string,
): TimeEntry[] {
    return withLedger((db) => {
        const reserved = getReservedTimeEntries(db, entityId);
        return listTimeEntries(db, {
            entityId,
            ...filter,
            unbilled: true,
            billable: true,
            running: false,
        }).filter((e) => {
            const holder = reserved.get(e.id);
            return !holder || holder === exceptInvoiceId;
        });
    });
}

/** Reserve the entries for a draft (replacing its earlier reservation). They stay open. */
export function reserveTimeForDraft(entityId: string, invoiceId: string, entryIds: readonly string[]): void {
    withLedger((db) => {
        const reserved = getReservedTimeEntries(db, entityId);
        for (const id of entryIds) {
            const holder = reserved.get(id);
            if (holder && holder !== invoiceId)
                throw new Error(`Zeiteintrag ${id} ist schon für einen anderen Entwurf vorgemerkt.`);
            const entry = getTimeEntry(db, id);
            if (!entry) throw new Error(`Zeiteintrag ${id} existiert nicht.`);
            if (entry.invoiceId) throw new Error(`Zeiteintrag ${id} liegt bereits auf Rechnung ${entry.invoiceId}.`);
        }
        setInvoiceTimeLinks(db, entityId, invoiceId, entryIds);
    });
}

/** A draft was deleted: its reservation goes, the entries stay open. */
export function releaseTimeOfDraft(entityId: string, invoiceId: string): void {
    withLedger((db) => clearInvoiceTimeLinks(db, entityId, invoiceId));
}

/** Before finalizing: no reserved entry may have been billed on another invoice in the meantime. */
export function checkTimeBeforeFinalize(entityId: string, invoiceId: string): string[] {
    return withLedger((db) => {
        const ids = getInvoiceTimeLinks(db, entityId, invoiceId);
        for (const id of ids) {
            const entry = getTimeEntry(db, id);
            if (!entry) throw new Error(`Zeiteintrag ${id} existiert nicht mehr.`);
            if (entry.invoiceId && entry.invoiceId !== invoiceId) {
                throw new Error(
                    `Zeiteintrag ${id} liegt inzwischen auf Rechnung ${entry.invoiceId} — Entwurf neu aufbauen.`,
                );
            }
        }
        return ids;
    });
}

/** After finalizing: the reserved entries become billed (`invoice_id`), the reservation is cleared. Returns the count. */
export function settleTimeOnFinalize(entityId: string, invoiceId: string): number {
    const at = nowIso();
    return withLedger((db) => {
        const ids = getInvoiceTimeLinks(db, entityId, invoiceId);
        const changed = markTimeEntriesInvoiced(db, ids, invoiceId, at);
        clearInvoiceTimeLinks(db, entityId, invoiceId);
        return changed;
    });
}

/** What a project's open time turns into on a draft: the items to append, the period and the entries to reserve. */
export interface ProjectTimeDraft extends TimeLines {
    items: InvoiceItemSpec[];
}

/**
 * Build the time lines of one project for an invoice draft. `entryIds` narrows the open entries (the
 * person deselected the rest); `exceptInvoiceId` keeps the entries the draft being edited already reserves.
 */
export function buildProjectTimeDraft(
    entityId: string,
    project: { id: string; name: string },
    options: {
        grouping: TimeGrouping;
        hourlyRate: number | null | undefined;
        vatRate: number;
        entryIds?: readonly string[];
        exceptInvoiceId?: string;
    },
): ProjectTimeDraft {
    const open = listOpenTimeForInvoice(entityId, { projectId: project.id }, options.exceptInvoiceId);
    const chosen = options.entryIds ? open.filter((e) => options.entryIds!.includes(e.id)) : open;
    const built = buildTimeLines(chosen, {
        grouping: options.grouping,
        hourlyRate: options.hourlyRate,
        vatRate: options.vatRate,
        fallbackTitle: project.name,
    });
    return { ...built, items: built.lines.map(timeLineToItemSpec) };
}
