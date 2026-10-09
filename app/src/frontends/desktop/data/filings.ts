/**
 * The filing register for the native app — recording that a declaration was submitted or paid.
 *
 * The register is what stops the proactive Steuertermine layer from nagging forever: a period
 * marked eingereicht/bezahlt drops out of the list. It was CLI- and MCP-only, so from the app the
 * Fristen list could only ever be READ — and a list of deadlines you cannot tick off is a list you
 * stop looking at.
 *
 * A thin adapter over `core/actions/filings.ts`, in the same shape as the other data modules.
 */

import { listFilings, recordFiling } from '../../../core/actions/filings.ts';
import type { Filing, FilingInput } from '@steuererklaerung/store';

export type { Filing, FilingInput };

/** Record (or merge into) one register entry. */
export function saveFiling(input: FilingInput): Filing {
    return recordFiling(input);
}

/** Every register entry, newest period first. */
export function loadFilings(opts: { entityId?: string; year?: number } = {}): Filing[] {
    return listFilings(opts);
}
