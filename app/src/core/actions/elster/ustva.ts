/**
 * The USt-VA of one period, from wherever the entity keeps its receipts: Paperless documents, or —
 * for an entity on the built-in DMS — the bookings ({@link ustvaAusBuchungen}).
 *
 * Only an entity that says `dms.type: "builtin"` takes the booking path. One without a `dms` block
 * keeps the Paperless aggregate it has always had: switching an existing setup's Voranmeldung to a
 * different source unannounced would change filed figures.
 */

import { getPeriodDateRange, loadManifest, loadPaperlessConfig, type ElsterConfig } from '../../config/index.ts';
import { findEntity } from '../../config/entities.ts';
import {
    aggregateUstvaFromPaperlessWithDetails,
    type UstvaAggregateWithDetails,
    type UstvaYearQuarter,
} from '../../elster/ustva-aggregate.ts';
import { ustvaAusBuchungen } from '../../elster/ustva-buchungen.ts';
import { round2 } from '../../lib/money.ts';
import { vorsteuerKorrekturenDerPeriode } from '../erstattungen.ts';
import { euerReportByTransactions } from './euer.ts';

/** Whether the entity's USt-VA comes from its bookings (built-in DMS) rather than Paperless. */
export function ustvaAusBuchungenAktiv(entityId: string): boolean {
    return findEntity(loadManifest(), entityId)?.dms?.type === 'builtin';
}

/** The EÜR rows of a year with their details — the input of {@link ustvaAusBuchungen}. */
async function buchungenDesJahres(config: ElsterConfig, year: number) {
    const agg = await euerReportByTransactions(loadPaperlessConfig(), year, { detail: true, elster: config });
    return agg.detail ?? [];
}

/** First day the period counts from: its start, or the business start when that is later. */
function periodenBeginn(config: ElsterConfig, dateFrom: string): string {
    return config.business_start_date && config.business_start_date > dateFrom ? config.business_start_date : dateFrom;
}

/** The USt-VA of `config.period` — same result shape on both paths. */
export async function aggregateUstvaDerPeriode(config: ElsterConfig): Promise<UstvaAggregateWithDetails> {
    if (!ustvaAusBuchungenAktiv(config.entity_id)) {
        return aggregateUstvaFromPaperlessWithDetails(config, undefined, vorsteuerKorrekturenDerPeriode(config));
    }
    if (config.taxation_basis === 'soll') {
        throw new Error('Soll-Versteuerung: die USt-VA aus den Buchungen rechnet nach Zahlungsdatum (Ist).');
    }
    const { dateFrom, dateTo } = getPeriodDateRange(config.period);
    const von = periodenBeginn(config, dateFrom);
    const rows = await buchungenDesJahres(config, config.period.year);
    return {
        aggregate: ustvaAusBuchungen(rows, von, dateTo),
        dateFrom: von,
        dateTo,
        outgoing: [],
        incoming: [],
        missingBmfRates: [],
    };
}

/** The four quarters of a year from the bookings — what `aggregateUstvaYear` is for Paperless. */
export async function ustvaJahrAusBuchungen(config: ElsterConfig, year: number): Promise<UstvaYearQuarter[]> {
    const rows = await buchungenDesJahres(config, year);
    return ([1, 2, 3, 4] as const).map((quarter) => {
        const { dateFrom, dateTo } = getPeriodDateRange({ year, quarter });
        const aggregate = ustvaAusBuchungen(rows, periodenBeginn(config, dateFrom), dateTo);
        return {
            quarter,
            aggregate,
            zahllast: round2(aggregate.vat_out - aggregate.vat_in),
            outgoing: [],
            incoming: [],
            missingBmfRates: [],
        };
    });
}
