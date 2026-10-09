/**
 * Offene Steuerzahlungen across the whole filing register — the payment companion to
 * `listSteuertermine` (declarations) and `listOpenItems` (documents). Read-only; shared by the
 * CLI (`fristen`), the MCP tool (`list_open_tax_payments`) and the app/web Fristen views.
 */

import { entityIdAliases } from '@steuererklaerung/store';
import { loadManifest, resolveEntities } from '../config/index.ts';
import {
    computeBescheidAbweichungen,
    computeOffeneSteuerzahlungen,
    type BescheidAbweichung,
    type OffeneSteuerzahlung,
    type SteuerzahlungEntity,
} from '../elster/steuerzahlungen.ts';
import { listFilings } from './filings.ts';

/**
 * Every filed-but-unpaid tax amount from the register, with its estimated due date (see
 * `elster/steuerzahlungen.ts` for the per-kind rules). `today` (YYYY-MM-DD) defaults to the
 * current date; pass it for deterministic output. An unreadable manifest degrades gracefully:
 * the amounts still surface (from the register alone), only entity names / Dauerfrist flags
 * fall back to their defaults.
 */
function manifestEntities(): SteuerzahlungEntity[] {
    const entities: SteuerzahlungEntity[] = [];
    try {
        for (const e of resolveEntities(loadManifest())) {
            entities.push({
                ids: entityIdAliases(e.id),
                entityId: e.id,
                entityName: e.name,
                dauerfrist: e.elster?.ust_dauerfristverlaengerung ?? false,
            });
        }
    } catch (err) {
        // Same doctrine as listSteuertermine: never throw (the register data must still surface),
        // never swallow silently (stderr, so it never pollutes MCP stdout / report JSON).
        console.warn(
            `[steuerzahlungen] Manifest (steuererklaerung.json) nicht ladbar — Entitätsnamen/Dauerfrist fehlen: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return entities;
}

export function listOffeneSteuerzahlungen(opts: { today?: string } = {}): OffeneSteuerzahlung[] {
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    return computeOffeneSteuerzahlungen(listFilings(), manifestEntities(), today);
}

/**
 * Every recorded Bescheid that diverges from what we declared (see
 * `elster/steuerzahlungen.ts` for why this is reported separately from the open payments).
 */
export function listBescheidAbweichungen(): BescheidAbweichung[] {
    return computeBescheidAbweichungen(listFilings(), manifestEntities());
}

export type { BescheidAbweichung, OffeneSteuerzahlung };
