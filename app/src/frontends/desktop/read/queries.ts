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
