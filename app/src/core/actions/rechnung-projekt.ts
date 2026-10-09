/**
 * Rechnung ↔ Projekt (Idee 14): the direct assignment of an outgoing invoice to a project.
 *
 * The decision lives in the ledger (`invoice_projects`, audit-logged as `rechnung_projekt.*`) and is keyed
 * by the back-end invoice id like `invoice_reminders`, so it works for the self back-end and for Qonto.
 * A direct assignment wins over the link derived from billed hours (see `projekt-ergebnis.ts`).
 */

import {
    clearInvoiceProject,
    getInvoiceProject,
    getInvoiceProjects,
    listTimeEntries,
    ledgerDbExists,
    ledgerDbPath,
    migrate,
    openLedger,
    setInvoiceProject,
    type InvoiceProjectChange,
    type LedgerDatabase,
} from '@steuererklaerung/store';
import { loadProjects, type Project } from '../config/index.ts';

function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

const nowIso = () => new Date().toISOString();

/** Assign an invoice to a project of the entity. Throws on an unknown project. */
export function setRechnungProjekt(
    entityId: string,
    invoiceId: string,
    projectId: string,
    decidedBy?: string | null,
): InvoiceProjectChange {
    if (!loadProjects(entityId).some((p) => p.id === projectId)) {
        throw new Error(`Projekt „${projectId}" gibt es für ${entityId} nicht.`);
    }
    return withLedger((db) => setInvoiceProject(db, entityId, invoiceId, projectId, nowIso(), decidedBy));
}

/** „Zuordnung aufheben". True if there was one. No ledger yet means nothing to clear. */
export function clearRechnungProjekt(entityId: string, invoiceId: string, decidedBy?: string | null): boolean {
    if (!ledgerDbExists()) return false;
    return withLedger((db) => clearInvoiceProject(db, entityId, invoiceId, nowIso(), decidedBy));
}

/** The directly assigned project of one invoice, or null. READ-ONLY. */
export function getRechnungProjekt(entityId: string, invoiceId: string): string | null {
    try {
        if (!ledgerDbExists()) return null;
        return withLedger((db) => getInvoiceProject(db, entityId, invoiceId));
    } catch {
        return null;
    }
}

/** Every direct assignment of the entity: invoice id → project id. READ-ONLY. */
export function loadRechnungProjekte(entityId: string): Map<string, string> {
    try {
        if (!ledgerDbExists()) return new Map();
        return new Map(withLedger((db) => getInvoiceProjects(db, entityId)).map((r) => [r.invoiceId, r.projectId]));
    } catch {
        return new Map();
    }
}

/**
 * The project to PRESELECT for a customer: the only project that customer has. Never silent — a surface
 * shows it as the proposal and the person confirms. Zero or several projects: no proposal.
 */
export function vorschlagProjekt(
    projects: readonly Pick<Project, 'id' | 'contactId'>[],
    contactId: string | null | undefined,
): string | null {
    if (!contactId) return null;
    const own = projects.filter((p) => p.contactId === contactId);
    return own.length === 1 ? own[0].id : null;
}

/** „Danach gilt: …" — what the invoice counts as once the direct assignment is taken back. */
export function danachGiltRechnung(hatZeiten: boolean): string {
    return hatZeiten ? 'Danach gilt: Zuordnung über die abgerechneten Zeiten.' : 'Danach gilt: kein Projekt.';
}

/** Invoices of the customer that have no project (neither direct nor through hours), for the project detail hint. */
export function rechnungenOhneProjekt(
    rechnungen: readonly { id: string; contactId: string | null }[],
    contactId: string,
    zugeordnet: ReadonlySet<string>,
): string[] {
    return rechnungen.filter((r) => r.contactId === contactId && !zugeordnet.has(r.id)).map((r) => r.id);
}

export interface RechnungProjektAnsicht {
    /** The project assigned on the invoice itself (wins), or null. */
    direkt: { id: string; name: string } | null;
    /** The projects of the tracked hours billed on the invoice. */
    ueberZeiten: { id: string; name: string }[];
    /** What counts once the direct assignment is taken back; null when there is none. */
    danach: string | null;
}

/** Where an invoice's project comes from, for the invoice detail. READ-ONLY. */
export function rechnungProjektAnsicht(entityId: string, invoiceId: string): RechnungProjektAnsicht {
    const names = new Map(loadProjects(entityId).map((p) => [p.id, p.name]));
    const nameOf = (id: string) => ({ id, name: names.get(id) ?? id });
    const direktId = getRechnungProjekt(entityId, invoiceId);
    let ueber: string[] = [];
    try {
        if (ledgerDbExists()) {
            ueber = [
                ...new Set(
                    withLedger((db) => listTimeEntries(db, { entityId }))
                        .filter((e) => e.invoiceId === invoiceId && e.projectId)
                        .map((e) => e.projectId as string),
                ),
            ];
        }
    } catch {
        // an unreadable ledger has no hours to show
    }
    return {
        direkt: direktId ? nameOf(direktId) : null,
        ueberZeiten: ueber.map(nameOf),
        danach: direktId ? danachGiltRechnung(ueber.length > 0) : null,
    };
}
