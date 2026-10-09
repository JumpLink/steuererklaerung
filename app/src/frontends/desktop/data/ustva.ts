/**
 * USt-VA data for the native app — the same Umsatzsteuer-Voranmeldung the CLI `elster ustva report`
 * surfaces, computed by the shared `aggregateUstvaYear` helper (Ist-Versteuerung) with no HTTP in
 * between. Like the EÜR read (data/euer.ts) this is async and fetches Paperless per quarter.
 */

import {
    aggregateUstvaYear,
    type UstvaYearQuarter,
    type UstvaAggregate,
} from '../../../core/elster/ustva-aggregate.ts';
import { vorsteuerKorrekturenDesJahres } from '../../../core/actions/erstattungen.ts';
import { buildUstvaPortalUpload } from '../../../core/elster/ustva-xml.ts';
import { DmsUnsupportedError } from '../../../core/lib/errors.ts';
import { ustvaAusBuchungenAktiv, ustvaJahrAusBuchungen } from '../../../core/actions/elster/ustva.ts';
import type { AppEntity } from '../entities.ts';

/** One quarter of the USt-VA year overview (re-exported so the view keeps a stable name). */
export type UstvaQuarter = UstvaYearQuarter;

/**
 * Aggregate the USt-VA for all four quarters of a reporting year for one entity (async; fetches
 * Paperless). Entities without an ELSTER config yield an empty list (the nav hides the view).
 */
export async function loadUstvaYear(entity: AppEntity, year: number): Promise<UstvaQuarter[]> {
    if (!entity.elster) return [];
    // An entity that names the built-in DMS gets its USt-VA from the bookings, like its USt-Jahreserklärung.
    if (ustvaAusBuchungenAktiv(entity.id)) return ustvaJahrAusBuchungen(entity.elster, year);
    // Everything else reads receipts from Paperless, so an entity without it cannot produce one — and
    // used to learn that as a Paperless *config* error naming a CLI command, which sends the user to
    // configure a system they deliberately do not use.
    if (entity.dmsType !== 'paperless') {
        throw new DmsUnsupportedError(
            'USt-VA',
            entity.dmsType,
            'Die USt-VA wird zur Zeit nur aus Paperless berechnet; diese Entität nutzt das integrierte DMS.',
        );
    }
    return aggregateUstvaYear(entity.elster, year, vorsteuerKorrekturenDesJahres(entity.elster, year));
}

/**
 * Build the Mein-ELSTER XML-Import file for one already-aggregated quarter — no Paperless fetch,
 * the view passes the aggregate it already loaded. The config is scoped to that quarter (period +
 * schema_version = the filing year, so the `ustva/vYYYY` namespace + Jahr/Zeitraum are correct and
 * the filename is `ustva-YYYY-Qn.xml`). Sync — the caller then Save-As's the bytes.
 */
export function ustvaUploadXml(
    entity: AppEntity,
    year: number,
    quarter: number,
    aggregate: UstvaAggregate,
): { filename: string; bytes: Uint8Array } {
    if (!entity.elster) throw new Error('Diese Entität hat keine ELSTER-Config.');
    const { filename, bytes } = buildUstvaPortalUpload(aggregate, entity.elster, year, quarter);
    return { filename, bytes };
}
