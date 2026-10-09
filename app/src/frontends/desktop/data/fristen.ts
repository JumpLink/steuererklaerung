/**
 * Fristen data for the native app — three layers, same as the CLI `fristen` and the MCP tools:
 *   • reactive open items (Paperless docs with payment_status=offen), via `listOpenItems`;
 *   • proactive Steuertermine (Regelfristen from the ELSTER configs), via `listSteuertermine`;
 *   • open tax payments (filed but unpaid, from the filing register), via `listOffeneSteuerzahlungen`.
 * Global (not per entity-year): the one "damit ich sowas nicht vergesse" overview. Async (the
 * open-items half fetches Paperless; the other two are local config/register reads).
 */

import { listOpenItems, type OpenItem } from '../../../core/actions/fristen.ts';
import { listSteuertermine } from '../../../core/actions/steuertermine.ts';
import { listOffeneSteuerzahlungen } from '../../../core/actions/steuerzahlungen.ts';
import type { SteuerTermin } from '../../../core/elster/steuertermine.ts';
import type { OffeneSteuerzahlung } from '../../../core/elster/steuerzahlungen.ts';

export type { OpenItem, SteuerTermin, OffeneSteuerzahlung };

export interface FristenData {
    openItems: OpenItem[];
    steuertermine: SteuerTermin[];
    steuerzahlungen: OffeneSteuerzahlung[];
    /** Per-layer failure messages, keyed by layer. Absent keys succeeded. */
    errors: Partial<Record<'openItems' | 'steuertermine' | 'steuerzahlungen', string>>;
}

/** Run one layer, turning a failure into a message instead of letting it take the others down. */
async function layer<T>(load: () => Promise<T> | T, fallback: T): Promise<{ value: T; error?: string }> {
    try {
        return { value: await load() };
    } catch (err) {
        return { value: fallback, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Load all three layers, ranked by urgency.
 *
 * Each layer settles INDEPENDENTLY. `Promise.all` was wrong here in a way that only shows once the
 * view exists: the open-items layer talks to Paperless, the other two read local config and the
 * filing register — so an unreachable or unconfigured Paperless took down the tax deadlines too,
 * and the one screen whose whole job is "damit ich das nicht vergesse" showed nothing at all.
 * A dead network must cost you the layer that needs the network, and nothing else.
 */
export async function loadFristen(): Promise<FristenData> {
    const [open, termine, zahlungen] = await Promise.all([
        layer<OpenItem[]>(() => listOpenItems(), []),
        layer<SteuerTermin[]>(() => listSteuertermine(), []),
        layer<OffeneSteuerzahlung[]>(() => listOffeneSteuerzahlungen(), []),
    ]);
    const errors: FristenData['errors'] = {};
    if (open.error) errors.openItems = open.error;
    if (termine.error) errors.steuertermine = termine.error;
    if (zahlungen.error) errors.steuerzahlungen = zahlungen.error;
    return {
        openItems: open.value,
        steuertermine: termine.value,
        steuerzahlungen: zahlungen.value,
        errors,
    };
}
