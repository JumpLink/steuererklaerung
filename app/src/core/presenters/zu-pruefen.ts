/**
 * „Zu prüfen" presenter — the queue, its confirmation and „Regel aus Auswahl" for one entity-year,
 * shared by the desktop tab, the Übersicht task, the CLI `buchungen` and the MCP tools.
 *
 * The rows are the enriched Buchungen (same aggregate + receipt join as the Buchungen list); the
 * decision what belongs in the queue is the pure `elster/zu-pruefen.ts`, the rule preview the pure
 * `elster/regel-aus-beispielen.ts`. This module only loads and writes.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { zuPruefenQueue, herkunftText, type ZuPruefenGrund } from '../elster/zu-pruefen.ts';
import { regelAusBeispielen, type RegelBuchung, type RegelVorschau } from '../elster/regel-aus-beispielen.ts';
import { buchungZeile } from '../elster/hinweise.ts';
import { confirmClassification, loadConfirmedClassifications } from '../actions/classifications.ts';
import { loadClassificationRules, rememberRule, toClassifyRules } from '../actions/classification-rules.ts';
import { loadEnrichedTransactions, type EnrichedTxRow } from './buchungen.ts';
import { offeneErstattungIds } from './erstattungen.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type ZuPruefenRow = EnrichedTxRow & { grund: ZuPruefenGrund; herkunft: string };

export interface ZuPruefenData {
    /** Newest first, like the Buchungen list. */
    rows: ZuPruefenRow[];
}

/** One business entity-year's queue. A `privat` entity has no classification, hence no queue. */
export async function loadZuPruefen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<ZuPruefenData> {
    if (!session.elster(entity)) return { rows: [] };
    const { rows } = await loadEnrichedTransactions(session, entity, year);
    const geprueft = loadConfirmedClassifications(rows.map((r) => r.id));
    const erstattungen = await offeneErstattungIds(session, entity, year);
    return {
        rows: zuPruefenQueue(rows, geprueft, erstattungen).map((r) => ({ ...r, herkunft: herkunftText(r) })),
    };
}

/**
 * How many bookings are in the queue — the Übersicht counter. The open Erstattungen are counted by
 * their own task („N Erstattungen zuordnen"), so `ohneErstattungen` leaves them out here: each
 * booking is one task, not two.
 */
export async function countZuPruefen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    opts: { ohneErstattungen?: boolean } = {},
): Promise<number> {
    const { rows } = await loadZuPruefen(session, entity, year);
    return opts.ohneErstattungen ? rows.filter((r) => r.grund !== 'erstattung').length : rows.length;
}

/**
 * Confirm one queued booking under the category it has now. Recomputes the queue first, so only a
 * booking that IS in it can be confirmed — an unclassified one has nothing to confirm (umbuchen
 * instead), and a booking that left the queue meanwhile is refused rather than silently stamped.
 */
export async function confirmZuPruefen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
    decidedBy = 'app',
): Promise<{ ok: true; id: string; category: string }> {
    const { rows } = await loadZuPruefen(session, entity, year);
    const row = rows.find((r) => r.id === txId);
    if (!row) throw new Error(`Die Buchung ${txId} ist für ${entity.name} ${year} nicht zu prüfen.`);
    if (row.grund === 'unklassifiziert') {
        throw new Error('Eine unklassifizierte Buchung hat nichts zu bestätigen — bitte umbuchen.');
    }
    if (row.grund === 'erstattung') {
        throw new Error(
            'Die Zahlung ist vermutlich eine Erstattung — erst „Gehört das zu dieser Zahlung?" beantworten.',
        );
    }
    confirmClassification({ transactionId: txId, category: row.category, decidedBy });
    return { ok: true, id: txId, category: row.category };
}

function toRegelBuchung(r: EnrichedTxRow): RegelBuchung {
    return {
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
    };
}

/** One hit of the preview, ready to show. */
export interface RegelTreffer {
    id: string;
    zeile: string;
    /** What the booking is classified as now, and by what. */
    category: string;
    herkunft: string;
    beispiel: boolean;
}

export interface RegelAusAuswahl {
    muster: string;
    kategorie: string;
    treffer: RegelTreffer[];
    nichtErfasst: Array<{ id: string; zeile: string; warum: string }>;
    /** Incoming payments among the examples — an own rule books as expense, so say it. */
    eingaenge: number;
}

/**
 * Propose the rule several bookings share and list every existing booking of the year it would hit.
 * `muster`/`kategorie` override the proposal (the person edited them); nothing is written.
 */
export async function regelAusAuswahl(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    ids: readonly string[],
    opts: { muster?: string; kategorie?: string } = {},
): Promise<RegelAusAuswahl> {
    const { rows } = await loadEnrichedTransactions(session, entity, year);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const beispiele = ids.map((id) => byId.get(id)).filter((r): r is EnrichedTxRow => r != null);
    if (beispiele.length === 0) throw new Error('Keine der gewählten Buchungen gehört zu diesem Jahr.');
    const rules = toClassifyRules(loadClassificationRules(entity.id));
    const vorschau: RegelVorschau = regelAusBeispielen(beispiele.map(toRegelBuchung), rows.map(toRegelBuchung), rules, {
        muster: opts.muster,
        kategorie: opts.kategorie,
    });
    const wanted = new Set(ids);
    return {
        muster: vorschau.muster,
        kategorie: vorschau.kategorie,
        treffer: vorschau.treffer.map((t) => ({
            id: t.id,
            zeile: buchungZeile(t),
            category: t.category,
            herkunft: herkunftText(t),
            beispiel: wanted.has(t.id),
        })),
        nichtErfasst: vorschau.nichtErfasst.map((n) => ({
            id: n.id,
            zeile: buchungZeile(byId.get(n.id)!),
            warum: n.warum,
        })),
        eingaenge: beispiele.filter((b) => b.amount > 0).length,
    };
}

/**
 * Save the rule from „Regel aus Auswahl": `ausnahmen` are the hits the person deselected. Drops the
 * entity's cached aggregate, because the rule re-classifies bookings.
 */
export function saveRegelAusAuswahl(
    session: PresenterSession,
    entity: EntityModel,
    muster: string,
    kategorie: string,
    ausnahmen: readonly string[],
): ReturnType<typeof rememberRule> {
    const result = rememberRule(entity.id, muster, kategorie, { ausnahmen });
    session.invalidate(entity.id);
    return result;
}
