/**
 * Auswertungen data — the combined BWA + Einblicke payload for the single stacked Auswertungen
 * screen (the v2 design puts both on one page, not in tabs). Both are pure compute on top of the
 * SAME EÜR aggregate, so we load it once (via the shared, memoised {@link loadAggregate}) and derive
 * both — instead of the old two views each awaiting the aggregate on their own tab.
 *
 * The Hinweise are assembled by the SHARED core {@link computeYearHinweise} — the exact function the
 * web review cache uses — so this view and `/api/hinweise` can never diverge. (It previously hand-built
 * a reduced input and silently dropped the USt / GewSt / Beleg-Lücke / Betriebsaufgabe / Frist hints.)
 */

import { computeBwa, type BwaResult } from '../../../core/elster/bwa.ts';
import { loadHinweise, type YearHinweis } from '../../../core/presenters/hinweise.ts';
import { appSession } from './session.ts';
import type { AppEntity } from '../entities.ts';

export type { BwaLine, BwaResult } from '../../../core/elster/bwa.ts';
export type { YearHinweis as Hinweis } from '../../../core/presenters/hinweise.ts';

export interface AuswertungenData {
    bwa: BwaResult;
    hinweise: YearHinweis[];
}

/** Load + compute the BWA matrix and the advisory Hinweise for one entity-year (async; may fetch Paperless). */
export async function loadAuswertungen(entity: AppEntity, year: number): Promise<AuswertungenData> {
    // The BWA needs the aggregate detail; the Hinweise need the aggregate AND the period's documents
    // (the Beleg-Lücke). Both come from the shared, memoised session caches — one Paperless fetch.
    const session = appSession();
    const [agg, hinweise] = await Promise.all([session.aggregate(entity, year), loadHinweise(session, entity, year)]);
    return { bwa: computeBwa(agg, year), hinweise };
}
