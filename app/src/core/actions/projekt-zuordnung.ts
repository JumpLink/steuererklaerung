/**
 * Projekte auch für Ausgaben (Idee 14) — the storage side: the person's decisions about which project a
 * booking belongs to, and the project rules.
 *
 * Decisions live in the ledger (`booking_projects`, audit-logged as `projekt.*`), not in the manifest:
 * like a Umbuchung, an Erstattung or an Aufteilung they are per-booking decisions keyed by the unified tx
 * id, and the manifest would turn every bulk assignment into a rewrite of `steuererklaerung.json`. The
 * project itself stays where it was (the entity's `projects` block); a decision refers to it by id.
 *
 * Rules live in the manifest next to the other rules (`elster.klassifizierung.projekt_regeln`): they are
 * knowledge about a counterparty ("Küstenlicht → Relaunch"), the same kind as `aufwand_regeln`, and they
 * get the same backup on write. A decision of the person wins over a rule.
 */

import {
    clearPartLinks,
    clearProjectLink,
    getInvoiceProjects,
    getProjectLinks,
    listInvoices,
    listTimeEntries,
    ledgerDbExists,
    ledgerDbPath,
    migrate,
    openLedger,
    setProjectLink,
    type LedgerDatabase,
    type ProjectLinkChange,
} from '@steuererklaerung/store';
import { ensureElsterSection, mutateElsterConfig, resolveEntityElster } from '../config/accessors.ts';
import { loadProjects, type ElsterKlassifizierungProjektRegel } from '../config/index.ts';
import {
    GANZE_BUCHUNG,
    type ProjektEntscheidung,
    type ProjektRechnung,
    type ProjektRegel,
    type ProjektZeit,
} from '../elster/projekt-ergebnis.ts';

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

/** The decisions touching the given tx ids (or all), keyed by tx id. READ-ONLY: no ledger yet means none. */
export function loadProjektEntscheidungen(transactionIds?: readonly string[]): Map<string, ProjektEntscheidung[]> {
    const out = new Map<string, ProjektEntscheidung[]>();
    try {
        if (!ledgerDbExists()) return out;
        for (const l of withLedger((db) => getProjectLinks(db, transactionIds))) {
            const list = out.get(l.txId) ?? [];
            list.push({ teilNr: l.partNo, projectId: l.projectId });
            out.set(l.txId, list);
        }
    } catch {
        // an unreadable ledger holds no decisions we could honour
    }
    return out;
}

export interface ProjektZuweisung {
    txId: string;
    change: ProjectLinkChange;
}

/**
 * Decide the project of each booking: a project id, or `null` for „kein Projekt" (wins over a rule). One
 * ledger session for all of them, so a multi-select either lands completely or not at all.
 * `teilNr` addresses one part of a split booking; the default is the whole booking.
 */
export function entscheideProjekt(
    txIds: readonly string[],
    projectId: string | null,
    opts: { teilNr?: number; decidedBy?: string | null } = {},
): ProjektZuweisung[] {
    const at = nowIso();
    const teilNr = opts.teilNr ?? GANZE_BUCHUNG;
    return withLedger((db) =>
        txIds.map((txId) => ({
            txId,
            change: setProjectLink(db, txId, teilNr, projectId, at, opts.decidedBy),
        })),
    );
}

/** „Zuordnung zurücknehmen": drop the decisions. The ids that had one are returned. */
export function nimmProjektEntscheidungZurueck(
    txIds: readonly string[],
    opts: { teilNr?: number; decidedBy?: string | null } = {},
): string[] {
    const at = nowIso();
    const teilNr = opts.teilNr ?? GANZE_BUCHUNG;
    return withLedger((db) => txIds.filter((txId) => clearProjectLink(db, txId, teilNr, at, opts.decidedBy)));
}

/** A split dissolved: the part decisions have nothing to refer to any more. */
export function vergissProjektTeile(txId: string, decidedBy?: string | null): number {
    try {
        if (!ledgerDbExists()) return 0;
        return withLedger((db) => clearPartLinks(db, txId, nowIso(), decidedBy));
    } catch {
        return 0;
    }
}

// --- Rules ----------------------------------------------------------------------------------

/** The entity's project rules, in manifest order (first match wins). */
export function loadProjektRegeln(entityId: string): ProjektRegel[] {
    const list = resolveEntityElster(entityId)?.klassifizierung?.projekt_regeln ?? [];
    return list.map((r) => ({
        muster: r.muster,
        projekt: r.projekt,
        ...(r.ausnahmen?.length ? { ausnahmen: [...r.ausnahmen] } : {}),
    }));
}

export interface MerkeProjektRegelErgebnis {
    rule: ProjektRegel;
    /** False when an identical rule already existed — nothing was written unless new exceptions were added. */
    added: boolean;
}

const sameRule = (r: { muster: string; projekt: string }, muster: string, projekt: string) =>
    r.muster.trim().toLowerCase() === muster.toLowerCase() && r.projekt === projekt;

/**
 * Remember „text X belongs to project Y". Idempotent like `rememberRule`: an identical rule is not
 * appended twice, new exceptions are merged into the stored one. A rule with the same pattern for ANOTHER
 * project is appended — the first match wins, so the older one keeps what it had.
 */
export function merkeProjektRegel(
    entityId: string,
    muster: string,
    projekt: string,
    opts: { ausnahmen?: readonly string[] } = {},
): MerkeProjektRegelErgebnis {
    const pattern = muster.trim();
    if (!pattern) throw new Error('Ein Regel-Muster darf nicht leer sein.');
    if (!loadProjects(entityId).some((p) => p.id === projekt)) {
        throw new Error(`Projekt „${projekt}" gibt es für ${entityId} nicht.`);
    }
    const ausnahmen = [...new Set((opts.ausnahmen ?? []).map((a) => a.trim()).filter(Boolean))];
    const rule: ProjektRegel = ausnahmen.length
        ? { muster: pattern, projekt, ausnahmen }
        : { muster: pattern, projekt };

    const existing = loadProjektRegeln(entityId).find((r) => sameRule(r, pattern, projekt));
    if (existing) {
        const merged = [...new Set([...(existing.ausnahmen ?? []), ...ausnahmen])];
        if (merged.length === (existing.ausnahmen ?? []).length) return { rule: existing, added: false };
        schreibeRegeln(entityId, (list) =>
            list.map((r) => (sameRule(r, pattern, projekt) ? { ...r, ausnahmen: merged } : r)),
        );
        return { rule: { ...existing, ausnahmen: merged }, added: false };
    }
    schreibeRegeln(entityId, (list) => [...list, rule]);
    return { rule, added: true };
}

/**
 * Remove a rule by its pattern (and project, when the pattern is used for several). Unlike a booking
 * rule this changes no EÜR figure — only which project the matching bookings show — so removing is
 * offered. A decision of the person on a booking is not touched. True if a rule was removed.
 */
export function entferneProjektRegel(entityId: string, muster: string, projekt?: string): boolean {
    const wanted = muster.trim().toLowerCase();
    const hits = loadProjektRegeln(entityId).filter(
        (r) => r.muster.trim().toLowerCase() === wanted && (projekt == null || r.projekt === projekt),
    );
    if (hits.length === 0) return false;
    if (hits.length > 1) {
        throw new Error(
            `Das Muster „${muster.trim()}" gibt es für mehrere Projekte (${hits.map((h) => h.projekt).join(', ')}) — Projekt angeben.`,
        );
    }
    const [hit] = hits;
    schreibeRegeln(entityId, (list) => list.filter((r) => !sameRule(r, hit.muster.trim(), hit.projekt)));
    return true;
}

function schreibeRegeln(
    entityId: string,
    change: (list: ElsterKlassifizierungProjektRegel[]) => ElsterKlassifizierungProjektRegel[],
): void {
    ensureElsterSection(entityId);
    mutateElsterConfig(entityId, (raw) => {
        const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
        const list = Array.isArray(k.projekt_regeln)
            ? ([...k.projekt_regeln] as ElsterKlassifizierungProjektRegel[])
            : [];
        raw.klassifizierung = { ...k, projekt_regeln: change(list) };
    });
}

// --- Umsatz and hours ------------------------------------------------------------------------

/**
 * The entity's issued invoices that carry tracked project time, and every tracked entry — the ledger
 * side of the Projektergebnis. An invoice belongs to a project directly (`invoice_projects`, wins) or through the time
 * entries billed on it (`time_entries.invoice_id`); drafts, cancelled invoices and Stornorechnungen are left out, so a
 * storno never counts twice. READ-ONLY: no ledger yet means no invoices and no hours.
 */
export function loadProjektRechnungenUndZeiten(entityId: string): {
    rechnungen: ProjektRechnung[];
    zeiten: ProjektZeit[];
    /** Issued invoices without any project (neither direct nor through hours) — for the „ohne Projekt" hint. */
    ohneProjekt: { id: string; contactId: string | null }[];
} {
    try {
        if (!ledgerDbExists()) return { rechnungen: [], zeiten: [], ohneProjekt: [] };
        return withLedger((db) => {
            const entries = listTimeEntries(db, { entityId });
            const zeiten: ProjektZeit[] = entries
                .filter((e) => e.projectId)
                .map((e) => ({ projectId: e.projectId!, startedAt: e.startedAt, seconds: e.durationSeconds ?? 0 }));
            const sekunden = new Map<string, Record<string, number>>();
            for (const e of entries) {
                if (!e.invoiceId) continue;
                const per = sekunden.get(e.invoiceId) ?? {};
                const key = e.projectId ?? '';
                per[key] = (per[key] ?? 0) + (e.durationSeconds ?? 0);
                sekunden.set(e.invoiceId, per);
            }
            const direktMap = new Map(getInvoiceProjects(db, entityId).map((r) => [r.invoiceId, r.projectId]));
            const rechnungen: ProjektRechnung[] = [];
            const ohneProjekt: { id: string; contactId: string | null }[] = [];
            for (const inv of listInvoices(db, entityId)) {
                const per = sekunden.get(inv.id) ?? {};
                const direkt = direktMap.get(inv.id) ?? null;
                if (inv.kind !== 'invoice' || (inv.status !== 'open' && inv.status !== 'paid')) continue;
                if (!direkt && Object.keys(per).length === 0) {
                    ohneProjekt.push({ id: inv.id, contactId: inv.contactId });
                    continue;
                }
                rechnungen.push({
                    id: inv.id,
                    nummer: inv.number,
                    datum: (inv.issueDate ?? inv.createdAt).slice(0, 10),
                    netto: inv.totals.net,
                    sekunden: per,
                    ...(direkt ? { direktProjekt: direkt } : {}),
                });
            }
            return { rechnungen, zeiten, ohneProjekt };
        });
    } catch {
        return { rechnungen: [], zeiten: [], ohneProjekt: [] };
    }
}
