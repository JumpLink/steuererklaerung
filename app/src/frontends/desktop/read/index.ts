/**
 * The process-wide read client and the page loads the views call.
 *
 * Views use {@link reads} instead of the presenters directly: the work happens in the read worker, the
 * main thread only awaits the plain result.
 */

import type { SubmissionTarget } from '../../../core/actions/elster/submission-overview.ts';
import type { FigureRef } from '../../../core/actions/elster/explain.ts';
import type { EntityModel } from '../../../core/presenters/workspace.ts';
import { ReadClient } from './client.ts';
import { workerChannel } from './channel.ts';

let client: ReadClient | undefined;

/** The process-wide client (a worker is spawned on its first call). */
export function readClient(): ReadClient {
    return (client ??= new ReadClient(workerChannel));
}

/** Whether a client exists — the session forwards invalidations only to one that may hold memos. */
export function readClientIfStarted(): ReadClient | undefined {
    return client;
}

export const reads = {
    home: (entity: EntityModel, year: number) => readClient().call((api) => api.home(entity, year)),
    freiVerfuegbar: (entity: EntityModel, year: number) => readClient().call((api) => api.freiVerfuegbar(entity, year)),
    auswertungen: (entity: EntityModel, year: number) => readClient().call((api) => api.auswertungen(entity, year)),
    transaktionen: (entity: EntityModel, year: number) => readClient().call((api) => api.transaktionen(entity, year)),
    steuer: (entity: EntityModel, year: number) => readClient().call((api) => api.steuer(entity, year)),
    steuererklaerung: (entity: EntityModel, year: number) =>
        readClient().call((api) => api.steuererklaerung(entity, year)),
    absenden: (entity: EntityModel, year: number, targets: SubmissionTarget[]) =>
        readClient().call((api) => api.absenden(entity, year, targets)),
    figureExplanation: (entity: EntityModel, year: number, ref: FigureRef | string) =>
        readClient().call((api) => api.figureExplanation(entity, year, ref)),
    euerCategories: (entity: EntityModel, year: number) => readClient().call((api) => api.euerCategories(entity, year)),
    enrichedTransactions: (entity: EntityModel, year: number) =>
        readClient().call((api) => api.enrichedTransactions(entity, year)),
    documents: (entity: EntityModel, year: number) => readClient().call((api) => api.documents(entity, year)),
};
