/**
 * Which example questions the assistant offers for an entity.
 *
 * A suggestion is a promise that the assistant can answer it. With the tax module off there is no
 * VAT figure and no deadline list, so a chip asking for one leads to an answer about something the
 * app does not do. Both frontends pick their chips here and only translate the ids.
 */

import type { Capabilities } from '../../countries/types.ts';

export type AssistantExampleId =
    | 'biggest-expenses'
    | 'missing-receipts'
    | 'find-receipts'
    | 'vat-due'
    | 'deadlines'
    | 'est-entlastungsbetrag'
    | 'est-kinderbetreuung'
    | 'est-elterngeld';

export interface AssistantExampleOptions {
    /** A private entity with an ESt config: the intake topics replace the business questions. */
    hasEst: boolean;
    /** A business entity; a private household has no VAT to ask about. */
    business: boolean;
    /** The frontend can search receipts by text (the web chat's Paperless tools). */
    receiptSearch?: boolean;
}

export function assistantExampleIds(
    caps: Pick<Capabilities, 'vatReturn' | 'taxDeadlines' | 'incomeTax'>,
    opts: AssistantExampleOptions,
): AssistantExampleId[] {
    const ids: AssistantExampleId[] = ['biggest-expenses'];
    if (opts.hasEst && caps.incomeTax) {
        ids.push('est-entlastungsbetrag', 'est-kinderbetreuung', 'est-elterngeld');
        return ids;
    }
    ids.push('missing-receipts');
    if (opts.receiptSearch) ids.push('find-receipts');
    if (caps.vatReturn && opts.business) ids.push('vat-due');
    if (caps.taxDeadlines) ids.push('deadlines');
    return ids;
}
