/**
 * Erstattungen presenter (Idee 9) — the open refunds of one entity-year with their candidates, the
 * question for one booking, and the decisions „Ja", „Nein" and „Verknüpfung lösen". Shared by the
 * desktop (booking detail, „Zu prüfen"), the Übersicht task, the CLI `buchungen erstattungen` and the
 * MCP tools.
 *
 * Candidates come from the classified bookings of the year AND the year before (the window reaches
 * back {@link ERSTATTUNG_FENSTER_TAGE} days); the matching is the pure `elster/erstattung.ts`, the
 * ledger side `actions/erstattungen.ts`. This module only loads and writes.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { searchAccountKeys } from '@steuererklaerung/store';
import {
    erbeVonUrsprung,
    erstattungKandidaten,
    offeneErstattungen,
    ursprungLabel,
    type ErstattungBuchung,
    type ErstattungEntscheidung,
    type ErstattungKandidat,
} from '../elster/erstattung.ts';
import {
    loadErstattungLinks,
    removeErstattungLink,
    saveErstattungAbgelehnt,
    saveErstattungLink,
} from '../actions/erstattungen.ts';
import { buchungZeile } from '../elster/hinweise.ts';
import { loadEnrichedTransactions, type EnrichedTxRow } from './buchungen.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export { ERSTATTUNG_FENSTER_TAGE, erstattungenTitel } from '../elster/erstattung.ts';

type Row = EnrichedTxRow & ErstattungBuchung;

/** One candidate, ready to show. */
export interface ErstattungKandidatView {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    category: string;
    /** „10.03.2026 · Büromöbel Kranich GmbH · −357,00 €" */
    zeile: string;
    exakt: boolean;
    zweckTreffer: boolean;
    /** What the original can still take. */
    offen: number;
}

export interface OffeneErstattungView {
    buchung: EnrichedTxRow;
    zeile: string;
    kandidaten: ErstattungKandidatView[];
}

export interface ErstattungenData {
    year: number;
    /** Incoming payments of the year with a candidate and no link yet, newest first. */
    offen: OffeneErstattungView[];
    /** Refunds of the year that are linked, with what they were linked to. */
    verknuepft: Array<{ buchung: EnrichedTxRow; zeile: string; ursprung: string; ursprungId: string }>;
}

/** The question for ONE booking — what the booking detail shows. */
export interface ErstattungFrage {
    kandidaten: ErstattungKandidatView[];
    /** Set when the booking is already linked. */
    verknuepftMit?: { id: string; label: string };
}

function toRow(r: EnrichedTxRow): Row {
    return { ...r, reference: r.raw?.reference };
}

function kandidatView(k: ErstattungKandidat): ErstattungKandidatView {
    const o = k.original;
    return {
        id: o.id,
        bookingDate: o.bookingDate,
        amount: o.amount,
        counterparty: o.counterparty,
        purpose: o.purpose,
        category: o.category,
        zeile: buchungZeile(o),
        exakt: k.exakt,
        zweckTreffer: k.zweckTreffer,
        offen: k.offen,
    };
}

interface Loaded {
    rows: Row[];
    byId: Map<string, Row>;
    entscheidungen: ErstattungEntscheidung[];
}

/**
 * The year's and the previous year's classified bookings, plus every stored decision touching them
 * with the refund amounts (a refund linked in a later year still uses up its original).
 */
async function load(session: PresenterSession, entity: EntityModel, year: number): Promise<Loaded> {
    const current = (await loadEnrichedTransactions(session, entity, year)).rows;
    // The previous year only feeds candidates; an entity without bookings there simply has none.
    const before = await loadEnrichedTransactions(session, entity, year - 1)
        .then((d) => d.rows)
        .catch(() => [] as EnrichedTxRow[]);
    const rows = [...current, ...before].map(toRow);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const links = loadErstattungLinks(rows.map((r) => r.id));
    let amounts: Map<string, number> | undefined;
    const betrag = (id: string): number | undefined => {
        const known = byId.get(id);
        if (known) return Math.abs(known.amount);
        amounts ??= new Map(searchAccountKeys(entity.accountKeys, {}).map((t) => [t.id, Math.abs(t.amount)]));
        return amounts.get(id);
    };
    const entscheidungen = links.map((l) => ({
        refundTxId: l.refundTxId,
        originalTxId: l.originalTxId,
        status: l.status,
        betrag: betrag(l.refundTxId),
    }));
    return { rows, byId, entscheidungen };
}

/** One business entity-year's open and linked refunds. A `privat` entity has none. */
export async function loadErstattungen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<ErstattungenData> {
    if (!session.elster(entity)) return { year, offen: [], verknuepft: [] };
    const { rows, byId, entscheidungen } = await load(session, entity, year);
    const offen = offeneErstattungen(rows, entscheidungen, year).map((o) => ({
        buchung: o.buchung as EnrichedTxRow,
        zeile: buchungZeile(o.buchung),
        kandidaten: o.kandidaten.map(kandidatView),
    }));
    const verknuepft = entscheidungen
        .filter((e) => e.status === 'linked' && byId.get(e.refundTxId)?.bookingDate.startsWith(`${year}-`))
        .map((e) => {
            const b = byId.get(e.refundTxId)!;
            const o = byId.get(e.originalTxId);
            return {
                buchung: b as EnrichedTxRow,
                zeile: buchungZeile(b),
                ursprung: o ? ursprungLabel(o) : `Buchung ${e.originalTxId}`,
                ursprungId: e.originalTxId,
            };
        });
    return { year, offen, verknuepft };
}

/** Tx ids of the year's incoming payments with an open candidate — for the „Zu prüfen" queue. */
export async function offeneErstattungIds(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<Set<string>> {
    return new Set((await loadErstattungen(session, entity, year)).offen.map((o) => o.buchung.id));
}

/** How many refunds wait for „Ja" or „Nein" — the Übersicht counter. */
export async function countErstattungenOffen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<number> {
    return (await loadErstattungen(session, entity, year)).offen.length;
}

/** „Gehört das zu dieser Zahlung?" for one booking: its ranked candidates, or what it is linked to. */
export async function erstattungFrage(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
): Promise<ErstattungFrage> {
    if (!session.elster(entity)) return { kandidaten: [] };
    const { rows, byId, entscheidungen } = await load(session, entity, year);
    const link = entscheidungen.find((e) => e.refundTxId === txId && e.status === 'linked');
    if (link) {
        const o = byId.get(link.originalTxId);
        return {
            kandidaten: [],
            verknuepftMit: { id: link.originalTxId, label: o ? ursprungLabel(o) : link.originalTxId },
        };
    }
    const refund = byId.get(txId);
    if (!refund) return { kandidaten: [] };
    return { kandidaten: erstattungKandidaten(refund, rows, entscheidungen).map(kandidatView) };
}

/**
 * „Ja": link the refund to `originalId`. Recomputes the candidates first, so only a debit that IS a
 * candidate now can be chosen — that is what keeps several refunds of one debit below what it paid.
 * The refund inherits the original's category and VAT rate (frozen in the ledger).
 */
export async function verknuepfeErstattung(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
    originalId: string,
    decidedBy = 'app',
): Promise<{ ok: true; id: string; original: string; category: string; vatRate: number }> {
    const { rows, byId, entscheidungen } = await load(session, entity, year);
    const refund = byId.get(txId);
    if (!refund) throw new Error(`Die Buchung ${txId} gehört nicht zu ${entity.name} ${year}.`);
    const kandidaten = erstattungKandidaten(refund, rows, entscheidungen);
    const k = kandidaten.find((c) => c.original.id === originalId);
    if (!k) {
        const known = kandidaten.map((c) => c.original.id).join(', ') || '—';
        throw new Error(`${originalId} ist für diese Erstattung kein Kandidat. Kandidaten: ${known}`);
    }
    const erbe = erbeVonUrsprung(k.original);
    saveErstattungLink({ refundTxId: txId, originalTxId: originalId, ...erbe, decidedBy });
    session.invalidate(entity.id);
    return { ok: true, id: txId, original: originalId, category: erbe.category, vatRate: erbe.vatRate };
}

/** „Nein": this candidate is not the refund's original and is not offered again. */
export async function lehneErstattungAb(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
    originalId: string,
    decidedBy = 'app',
): Promise<{ ok: true; id: string; original: string }> {
    const { byId } = await load(session, entity, year);
    if (!byId.has(txId)) throw new Error(`Die Buchung ${txId} gehört nicht zu ${entity.name} ${year}.`);
    saveErstattungAbgelehnt(txId, originalId, decidedBy);
    session.invalidate(entity.id);
    return { ok: true, id: txId, original: originalId };
}

/** „Verknüpfung lösen": the refund is classified as before the „Ja"; rejections stay. */
export function loeseErstattung(session: PresenterSession, entity: EntityModel, txId: string): { ok: boolean } {
    const ok = removeErstattungLink(txId);
    session.invalidate(entity.id);
    return { ok };
}
