/**
 * "Automatisch zuordnen" for the Offene-Belege worklist — entity-scoped and DMS-agnostic (works for
 * the builtin DMS AND Paperless, unlike the Paperless-only `reconcile store` batch): load the
 * period's receipt pool ONCE via the entity's provider, plan the unambiguous links with the pure
 * {@link planAutoLinks}, and (unless dry-run) write them through the same `provider.link` the manual
 * picker uses — so the gap report, worklists and EÜR read one consistent link source.
 *
 * Dry-run first is the intended UI flow: preview the plan (counts + pairs), then execute it.
 */

import { searchAccountKeys } from '@steuererklaerung/store';
import { shiftDate } from '@steuererklaerung/shared';
import { resolveEntityDms } from './link-candidates.ts';
import { assertTxPeriodUnlocked } from '../lib/ledger/period-guard.ts';
import { planAutoLinks, type AutoLinkPlan } from '../lib/transactions/auto-link.ts';

/** How far around the bookings to pull the receipt pool (payments lag invoices by weeks). */
const WINDOW_DAYS = 92;

export interface AutoLinkRunResult extends AutoLinkPlan {
    /** Links actually written (0 on dry-run). */
    linked: number;
    /** Per-pair write failures — the run continues past them. */
    errors: Array<{ txId: string; documentId: string; message: string }>;
}

/**
 * Auto-link the given gap bookings (the Offen tab's rows) to their unambiguous receipts.
 * `dryRun: true` returns the plan without writing — show it, then call again with `dryRun: false`.
 */
export async function autoLinkOffeneBelege(
    entityId: string,
    txIds: string[],
    options: { dryRun?: boolean; path?: string } = {},
): Promise<AutoLinkRunResult> {
    const { accountKeys, provider } = resolveEntityDms(entityId, options.path);
    const allTxs = searchAccountKeys(accountKeys);
    const wanted = new Set(txIds);
    const txs = allTxs.filter((t) => wanted.has(t.id));
    if (txs.length === 0) return { planned: [], ambiguous: [], unmatched: [], linked: 0, errors: [] };

    const dates = txs.map((t) => t.bookingDate).sort();
    const docs = await provider.list({
        from: shiftDate(dates[0], -WINDOW_DAYS),
        to: shiftDate(dates[dates.length - 1], WINDOW_DAYS),
    });

    // Mutual-best check against EVERY entity booking, not just the gap set — a receipt whose true
    // payment lies outside the worklist must not be claimed by a lesser match inside it.
    const plan = planAutoLinks(txs, docs, { allTxs });
    if (options.dryRun) return { ...plan, linked: 0, errors: [] };

    if (!provider.link) throw new Error('Dieses DMS unterstützt das Verknüpfen nicht.');
    let linked = 0;
    const errors: AutoLinkRunResult['errors'] = [];
    for (const pair of plan.planned) {
        try {
            // GoBD: guarded per pair so the lock holds for every back-end.
            assertTxPeriodUnlocked(pair.txId, 'Verknüpfen');
            await provider.link(pair.documentId, pair.txId);
            linked++;
        } catch (err) {
            errors.push({
                txId: pair.txId,
                documentId: pair.documentId,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { ...plan, linked, errors };
}
