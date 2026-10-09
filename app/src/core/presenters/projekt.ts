/**
 * Projekte auch für Ausgaben (Idee 14) — the presenter: the Projektergebnis per project, the project of
 * every booking with where it comes from, assigning bookings (one or many, optionally with a rule) and
 * taking an assignment back. Shared by the Projekte view, the Buchungen list and detail, the CLI
 * `projects` and the MCP tools.
 *
 * The rows are the enriched Buchungen of the year (the same EÜR aggregate the Buchungen list shows), so a
 * cost is the net the EÜR books and moves with a receipt, an Umbuchung or an Aufteilung. The decisions
 * what belongs to a project are the pure `elster/projekt-ergebnis.ts`; this module only loads and writes.
 * The result is an internal evaluation, not a tax figure.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { listProjects } from '../actions/projects.ts';
import {
    entferneProjektRegel,
    entscheideProjekt,
    loadProjektEntscheidungen,
    loadProjektRechnungenUndZeiten,
    loadProjektRegeln,
    merkeProjektRegel,
    nimmProjektEntscheidungZurueck,
    type MerkeProjektRegelErgebnis,
} from '../actions/projekt-zuordnung.ts';
import { buchungZeile } from '../elster/hinweise.ts';
import {
    danachGilt,
    GANZE_BUCHUNG,
    jahrZeitraum,
    projektergebnis,
    projektFuerBuchung,
    projektKosten,
    type KostenQuelle,
    type Projektergebnis,
    type ProjektEntscheidung,
    type ProjektHerkunftArt,
    type ProjektRegel,
} from '../elster/projekt-ergebnis.ts';
import { musterAusBeispielen, type RegelBuchung } from '../elster/regel-aus-beispielen.ts';
import { loadEnrichedTransactions, type EnrichedTxRow } from './buchungen.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export {
    GANZE_BUCHUNG,
    type KostenZeile,
    type Projektergebnis,
    type ProjektHerkunftArt,
    type ProjektRegel,
} from '../elster/projekt-ergebnis.ts';

/** The project of one booking (or of one part of a split booking), as a surface shows it. */
export interface BuchungProjekt {
    /** The booking, or the part of a split booking this line stands for. */
    teilNr: number;
    projectId: string;
    projektName: string;
    art: ProjektHerkunftArt;
    /** „manuell", „via Regel „Küstenlicht“". */
    herkunft: string;
    /** „Danach gilt: …" for taking the decision back; null when there is no decision of the person to take back. */
    danach: string | null;
}

/** What the person decided about a booking, whether or not it left a project (`kein Projekt`). */
export interface BuchungProjektAnsicht {
    id: string;
    /** The project(s): one for a plain booking, one per assigned part of a split booking. */
    projekte: BuchungProjekt[];
    /** The person decided „kein Projekt" although a rule would assign one. */
    ausgenommen: boolean;
    /** Whether the person has a decision on the booking that „Zuordnung zurücknehmen" removes. */
    hatEntscheidung: boolean;
    /** What applies once the decision is taken back; null without a decision. */
    danach: string | null;
}

export interface ProjektRegelAnsicht extends ProjektRegel {
    projektName: string;
    /** Bookings of the year the rule claims right now. */
    treffer: number;
}

export interface ProjektAnsicht {
    entityId: string;
    year: number;
    projekte: Array<Projektergebnis & { kundeId: string; rechnungenOhneProjekt: number }>;
    regeln: ProjektRegelAnsicht[];
    /** Per booking id; only bookings that belong to a project or carry a decision. */
    buchungen: Record<string, BuchungProjektAnsicht>;
}

function quelle(r: EnrichedTxRow): KostenQuelle {
    return {
        id: r.id,
        amount: r.amount,
        counterparty: r.counterparty,
        purpose: r.purpose,
        reference: r.raw?.reference,
        type: r.raw?.type,
        bookingDate: r.bookingDate,
        kind: r.kind,
        category: r.category,
        net: r.net,
        aufteilung: r.aufteilung?.map((t) => ({ nr: t.nr, category: t.category, kind: t.kind, net: t.net })),
    };
}

/**
 * The Projektergebnis of every project of the entity for one year, the project rules with the bookings
 * they claim, and the project of every booking that has one.
 */
export async function loadProjektAnsicht(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<ProjektAnsicht> {
    const projekte = listProjects(entity.id);
    const regeln = loadProjektRegeln(entity.id);
    const zeitraum = jahrZeitraum(year);
    // A privat entity has no EÜR to read the costs from; its projects still show hours and Umsatz.
    const rows = session.elster(entity) ? (await loadEnrichedTransactions(session, entity, year)).rows : [];
    const entscheidungen = loadProjektEntscheidungen(rows.map((r) => r.id));
    const namen = new Map(projekte.map((p) => [p.id, p.name]));
    const bekannt = new Set(namen.keys());

    const kosten = projektKosten(rows.map(quelle), entscheidungen, regeln, namen, zeitraum);
    const alleKosten = [...kosten.values()].flat();
    const { rechnungen, zeiten, ohneProjekt } = loadProjektRechnungenUndZeiten(entity.id);

    const buchungen: Record<string, BuchungProjektAnsicht> = {};
    for (const r of rows) {
        const a = buchungProjektAnsicht(r, entscheidungen.get(r.id) ?? [], regeln, namen);
        if (a.projekte.length > 0 || a.hatEntscheidung) buchungen[r.id] = a;
    }
    const regelSchluessel = (r: ProjektRegel) => `${r.muster.trim().toLowerCase()}\n${r.projekt}`;
    const treffer = new Map<string, number>();
    for (const r of rows) {
        // Only what the rule actually decides: a booking with a decision of the person is not the rule's.
        const gilt = projektFuerBuchung(quelle(r), entscheidungen.get(r.id) ?? [], regeln, bekannt);
        const regel = gilt.herkunft?.art === 'regel' ? gilt.herkunft.regel : undefined;
        if (regel) treffer.set(regelSchluessel(regel), (treffer.get(regelSchluessel(regel)) ?? 0) + 1);
    }

    return {
        entityId: entity.id,
        year,
        projekte: projekte.map((p) => ({
            ...projektergebnis(p, { kosten: alleKosten, rechnungen, zeiten }, zeitraum),
            kundeId: p.contactId,
            rechnungenOhneProjekt: p.contactId ? ohneProjekt.filter((r) => r.contactId === p.contactId).length : 0,
        })),
        regeln: regeln.map((r) => ({
            ...r,
            projektName: namen.get(r.projekt) ?? `(unbekanntes Projekt ${r.projekt})`,
            treffer: treffer.get(regelSchluessel(r)) ?? 0,
        })),
        buchungen,
    };
}

/** The project of one booking, from its row and decisions. */
function buchungProjektAnsicht(
    r: EnrichedTxRow,
    entscheidungen: readonly ProjektEntscheidung[],
    regeln: readonly ProjektRegel[],
    namen: ReadonlyMap<string, string>,
): BuchungProjektAnsicht {
    const bekannt = new Set(namen.keys());
    const q = quelle(r);
    const teile = r.aufteilung ? r.aufteilung.map((t) => t.nr) : [GANZE_BUCHUNG];
    const projekte: BuchungProjekt[] = [];
    for (const teilNr of teile) {
        const z = projektFuerBuchung(q, entscheidungen, regeln, bekannt, teilNr);
        if (z.projectId == null || z.herkunft == null) continue;
        const eigene = entscheidungen.some((e) => e.teilNr === teilNr);
        projekte.push({
            teilNr,
            projectId: z.projectId,
            projektName: namen.get(z.projectId) ?? z.projectId,
            art: z.herkunft.art,
            herkunft: z.herkunft.label,
            danach: eigene ? danachGilt(q, entscheidungen, regeln, namen, teilNr) : null,
        });
    }
    const hatEntscheidung = entscheidungen.length > 0;
    const ausgenommen = entscheidungen.some((e) => e.projectId == null) && projekte.length === 0;
    return {
        id: r.id,
        projekte,
        ausgenommen,
        hatEntscheidung,
        danach: hatEntscheidung ? danachGilt(q, entscheidungen, regeln, namen) : null,
    };
}

// --- Assign ---------------------------------------------------------------------------------

export interface ProjektZuordnenErgebnis {
    ok: true;
    projectId: string | null;
    zugeordnet: string[];
    /** Already had exactly this decision. */
    unveraendert: string[];
    /** Claimed by the rule that was remembered with them, so no decision of their own was needed. */
    viaRegel: string[];
    /** Not an expense of this entity-year, so nothing was written for it. */
    uebersprungen: Array<{ id: string; warum: string }>;
    /** A rule was remembered too. */
    regel?: MerkeProjektRegelErgebnis;
}

/**
 * Assign bookings to a project (`projectId`), or decide „kein Projekt" (`null`) — one ledger session for
 * all, so a multi-select lands completely or not at all. Only expenses of the entity-year count; the
 * others are reported, not guessed. `teilNr` addresses one part of a split booking. With `regel`, the
 * pattern is remembered as a project rule too, and the bookings the person left out of the preview
 * become its `ausnahmen`.
 */
export async function weiseProjektZu(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txIds: readonly string[],
    projectId: string | null,
    opts: {
        teilNr?: number;
        decidedBy?: string;
        regel?: { muster: string; ausnahmen?: readonly string[] };
    } = {},
): Promise<ProjektZuordnenErgebnis> {
    if (projectId != null && !listProjects(entity.id).some((p) => p.id === projectId)) {
        throw new Error(`Projekt „${projectId}" gibt es für ${entity.name} nicht.`);
    }
    const ids = [...new Set(txIds)];
    if (ids.length === 0) throw new Error('Keine Buchung gewählt.');
    const rows = new Map((await loadEnrichedTransactions(session, entity, year)).rows.map((r) => [r.id, r]));
    const gueltig: string[] = [];
    const uebersprungen: ProjektZuordnenErgebnis['uebersprungen'] = [];
    for (const id of ids) {
        const row = rows.get(id);
        if (!row) uebersprungen.push({ id, warum: `gehört nicht zu ${entity.name} ${year}` });
        else if (row.amount >= 0) uebersprungen.push({ id, warum: 'ist keine Ausgabe' });
        else if (opts.teilNr && !row.aufteilung?.some((t) => t.nr === opts.teilNr)) {
            uebersprungen.push({ id, warum: `hat keinen Teil ${opts.teilNr}` });
        } else gueltig.push(id);
    }
    if (gueltig.length === 0) {
        throw new Error(
            `Keine der Buchungen ist eine Ausgabe dieses Jahres (${uebersprungen.map((u) => u.warum).join('; ')}).`,
        );
    }
    // With a rule, the bookings it claims need no decision of their own — they follow the rule, and show
    // „via Regel". Only the selected bookings it does not claim (another project decided there already)
    // get a decision.
    let regel: MerkeProjektRegelErgebnis | undefined;
    let viaRegel: string[] = [];
    let zuEntscheiden = gueltig;
    if (opts.regel && projectId != null) {
        if (opts.teilNr) throw new Error('Eine Regel gilt für die ganze Buchung, nicht für einen Teil.');
        regel = merkeProjektRegel(entity.id, opts.regel.muster, projectId, { ausnahmen: opts.regel.ausnahmen });
        const regeln = loadProjektRegeln(entity.id);
        const bekannt = new Set(listProjects(entity.id).map((p) => p.id));
        const bisher = loadProjektEntscheidungen(gueltig);
        viaRegel = gueltig.filter((id) => {
            const z = projektFuerBuchung(quelle(rows.get(id)!), bisher.get(id) ?? [], regeln, bekannt);
            return z.herkunft?.art === 'regel' && z.projectId === projectId;
        });
        zuEntscheiden = gueltig.filter((id) => !viaRegel.includes(id));
    }
    const geschrieben = entscheideProjekt(zuEntscheiden, projectId, {
        teilNr: opts.teilNr,
        decidedBy: opts.decidedBy ?? 'app',
    });
    session.invalidate(entity.id);
    return {
        ok: true,
        projectId,
        zugeordnet: geschrieben.filter((g) => g.change !== 'unchanged').map((g) => g.txId),
        unveraendert: geschrieben.filter((g) => g.change === 'unchanged').map((g) => g.txId),
        viaRegel,
        uebersprungen,
        ...(regel ? { regel } : {}),
    };
}

export interface ProjektZuruecknehmenErgebnis {
    ok: boolean;
    /** The bookings whose decision was removed, each with what applies now. */
    zurueckgenommen: Array<{ id: string; danach: string }>;
}

/** „Zuordnung zurücknehmen": drop the person's decision; what applies afterwards is a rule or nothing. */
export async function nimmProjektZuordnungZurueck(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txIds: readonly string[],
    opts: { teilNr?: number; decidedBy?: string } = {},
): Promise<ProjektZuruecknehmenErgebnis> {
    const rows = new Map((await loadEnrichedTransactions(session, entity, year)).rows.map((r) => [r.id, r]));
    const regeln = loadProjektRegeln(entity.id);
    const namen = new Map(listProjects(entity.id).map((p) => [p.id, p.name]));
    const vorher = loadProjektEntscheidungen(txIds);
    const entfernt = nimmProjektEntscheidungZurueck(txIds, { teilNr: opts.teilNr, decidedBy: opts.decidedBy ?? 'app' });
    const zurueckgenommen = entfernt.map((id) => {
        const row = rows.get(id);
        return {
            id,
            danach: row
                ? danachGilt(quelle(row), vorher.get(id) ?? [], regeln, namen, opts.teilNr)
                : 'Danach gilt: kein Projekt.',
        };
    });
    session.invalidate(entity.id);
    return { ok: entfernt.length > 0, zurueckgenommen };
}

// --- Rules ----------------------------------------------------------------------------------

export interface ProjektRegelVorschau {
    muster: string;
    projectId: string;
    /** Every expense of the year the rule would assign, examples included, the person's own decisions left out. */
    treffer: Array<{ id: string; zeile: string; beispiel: boolean }>;
    /** Examples the rule would not claim, with the reason. */
    nichtErfasst: Array<{ id: string; zeile: string; warum: string }>;
}

/**
 * Propose the pattern the marked bookings share and list every booking of the year it would assign to
 * the project — before anything is saved, like „Regel aus Auswahl". A booking that already has a decision
 * of the person is not a hit (the decision wins); one an earlier rule claims for another project is
 * listed as such. Nothing is written.
 */
export async function projektRegelVorschau(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    ids: readonly string[],
    projectId: string,
    opts: { muster?: string } = {},
): Promise<ProjektRegelVorschau> {
    const { rows } = await loadEnrichedTransactions(session, entity, year);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const beispiele = ids.map((id) => byId.get(id)).filter((r): r is EnrichedTxRow => r != null);
    const regelBuchung = (r: EnrichedTxRow): RegelBuchung => ({
        id: r.id,
        bookingDate: r.bookingDate,
        amount: r.amount,
        counterparty: r.counterparty,
        purpose: r.purpose,
        reference: r.raw?.reference,
        type: r.raw?.type,
        source: r.source,
        category: r.category,
        matchedRule: r.matchedRule,
    });
    const muster = (opts.muster ?? musterAusBeispielen(beispiele.map(regelBuchung))).trim();
    const regeln = loadProjektRegeln(entity.id);
    const namen = new Map(listProjects(entity.id).map((p) => [p.id, p.name]));
    const bekannt = new Set(namen.keys());
    const entscheidungen = loadProjektEntscheidungen(rows.map((r) => r.id));
    const wanted = new Set(ids);
    const treffer: ProjektRegelVorschau['treffer'] = [];
    const hit = new Set<string>();
    if (muster) {
        const neu: ProjektRegel = { muster, projekt: projectId };
        for (const r of rows) {
            if (r.amount >= 0 || entscheidungen.has(r.id)) continue;
            // The new rule goes last, so it only adds what no earlier rule claims.
            const gilt = projektFuerBuchung(quelle(r), [], [...regeln, neu], bekannt);
            if (gilt.herkunft?.regel?.muster !== muster || gilt.projectId !== projectId) continue;
            hit.add(r.id);
            treffer.push({ id: r.id, zeile: buchungZeile(r), beispiel: wanted.has(r.id) });
        }
    }
    const nichtErfasst: ProjektRegelVorschau['nichtErfasst'] = [];
    for (const b of beispiele) {
        if (hit.has(b.id)) continue;
        let warum: string;
        if (!muster) warum = 'kein gemeinsames Muster';
        else if (b.amount >= 0) warum = 'ist keine Ausgabe';
        else if (entscheidungen.has(b.id)) warum = 'hat eine eigene Zuordnung — die gewinnt';
        else if (
            !`${b.counterparty ?? ''} ${b.purpose ?? ''} ${b.raw?.reference ?? ''} ${b.raw?.type ?? ''}`
                .toLowerCase()
                .includes(muster.toLowerCase())
        )
            warum = `enthält „${muster}“ nicht`;
        else warum = 'eine frühere Regel greift zuerst';
        nichtErfasst.push({ id: b.id, zeile: buchungZeile(b), warum });
    }
    return { muster, projectId, treffer, nichtErfasst };
}

/** Remember a project rule on its own (no booking marked) — the CLI `projects rule add`. */
export function legeProjektRegelAn(
    session: PresenterSession,
    entity: EntityModel,
    muster: string,
    projectId: string,
): MerkeProjektRegelErgebnis {
    const result = merkeProjektRegel(entity.id, muster, projectId);
    session.invalidate(entity.id);
    return result;
}

/** Remove a project rule; the decisions of the person stay. */
export function loeseProjektRegel(
    session: PresenterSession,
    entity: EntityModel,
    muster: string,
    projectId?: string,
): boolean {
    const removed = entferneProjektRegel(entity.id, muster, projectId);
    session.invalidate(entity.id);
    return removed;
}
