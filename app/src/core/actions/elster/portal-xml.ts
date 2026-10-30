/**
 * XML for the no-ERiC path: without ERiC (and a Hersteller-ID) the app cannot send, so the person
 * uploads a generated file in Mein ELSTER. Only the USt-VA has such a file — it is the one form the
 * portal accepts as an XML import; the annual returns are typed into the web forms (check PDF as
 * the template), and the ERiC envelope the snapshots carry is not importable there.
 */

import { aggregateUstvaDerPeriode } from './ustva.ts';
import { resolveEntityScope } from './snapshots.ts';
import { buildUstvaPortalUploadForPeriod, parseUstvaPeriodLabel } from '../../elster/ustva-xml.ts';

export interface PortalXmlFile {
    filename: string;
    bytes: Uint8Array;
}

/** The USt-VA XML-Import file for one period label (`2025-Q3` / `2025-07`). */
export async function buildUstvaPortalXml(entity: string, year: number, periodLabel?: string): Promise<PortalXmlFile> {
    const period = periodLabel ? parseUstvaPeriodLabel(periodLabel) : null;
    if (!period) throw new Error(`Ungültiger USt-VA-Zeitraum '${periodLabel ?? ''}'.`);
    const elster = resolveEntityScope(entity).elster;
    if (!elster) throw new Error(`Entität '${entity}' hat keine ELSTER-Config.`);
    const { aggregate } = await aggregateUstvaDerPeriode({ ...elster, period, schema_version: year });
    const { filename, bytes } = buildUstvaPortalUploadForPeriod(aggregate, elster, period);
    return { filename, bytes };
}
