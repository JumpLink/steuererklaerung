/**
 * The reads the window moves off its main thread, as plain functions of a session.
 *
 * Nothing here knows about workers: the worker (read.worker.ts) calls these with its own session, and
 * the tests call them with a test session — the same functions, so what runs in the worker is what is
 * tested. Each one is a page's whole load (store reads + aggregation), which is what stalled the
 * main loop when it ran inline.
 */

import { loadHome } from '../../../core/presenters/home.ts';
import { loadFreiVerfuegbar } from '../../../core/presenters/frei-verfuegbar.ts';
import type { PresenterSession } from '../../../core/presenters/session.ts';
import type { EntityModel } from '../../../core/presenters/workspace.ts';
import type { FreiVerfuegbarModel } from '../../../core/elster/frei-verfuegbar.ts';
import { loadAuswertungen, type AuswertungenData } from '../data/auswertungen.ts';
import { loadEnrichedTransactions, loadRawTransactions } from '../../../core/presenters/buchungen.ts';
import { loadProjektAnsicht } from '../../../core/presenters/projekt.ts';
import { loadEuer, loadFeststellung, loadGewst, loadUste } from '../../../core/presenters/steuer.ts';
import type { SteuerData, TransaktionenData } from './protocol.ts';

export function homeQuery(session: PresenterSession, entity: EntityModel, year: number) {
    return loadHome(session, entity, year);
}

export function freiVerfuegbarQuery(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<FreiVerfuegbarModel> {
    return loadFreiVerfuegbar(session, entity, { year });
}

export function auswertungenQuery(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<AuswertungenData> {
    return loadAuswertungen(session, entity, year);
}

/**
 * Transaktionen: a business entity gets the classified aggregate, a `privat` one the raw cash list.
 * The project of each expense is an extra — its failure comes back as `projekteFehler`, not as an error.
 */
export async function transaktionenQuery(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<TransaktionenData> {
    if (!entity.elster) return { data: loadRawTransactions(entity, year), projekte: null };
    const data = await loadEnrichedTransactions(session, entity, year);
    try {
        return { data, projekte: await loadProjektAnsicht(session, entity, year) };
    } catch (err) {
        return { data, projekte: null, projekteFehler: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Steuer: the EÜR is required; the annual USt/GewSt/Feststellung derive from the same cached aggregate
 * and are optional, so a failure there resolves to null. The per-booking `detail` stays behind: the page
 * never reads it, and it is thousands of rows to clone across the thread boundary.
 */
export async function steuerQuery(session: PresenterSession, entity: EntityModel, year: number): Promise<SteuerData> {
    const full = await loadEuer(session, entity, year);
    const euer = { ...full, aggregate: { ...full.aggregate, detail: undefined } };
    const [uste, gewst, fest] = await Promise.all([
        loadUste(session, entity, year).catch(() => null),
        loadGewst(session, entity, year).catch(() => null),
        loadFeststellung(session, entity, year).catch(() => null),
    ]);
    return { euer, uste, gewst, fest };
}
