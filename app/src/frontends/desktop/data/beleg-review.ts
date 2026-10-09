/**
 * Beleg-Eingang confirm/undo + "Automatisch zuordnen" for the native app — thin wrappers over the
 * shared core actions that pair every write with the session cache drop (write + invalidate are
 * inseparable, or the queue and every derived tax figure go stale). Views call THESE, never core.
 */

import {
    confirmBelegDecision,
    undoBelegConfirmation,
    type BelegConfirmInput,
    type BelegConfirmResult,
    type BelegConfirmUndo,
} from '../../../core/actions/beleg-review.ts';
import { autoLinkOffeneBelege, type AutoLinkRunResult } from '../../../core/actions/auto-link-belege.ts';
import { unlinkDocumentFromTransaction } from '../../../core/actions/link-candidates.ts';
import { appSession } from './session.ts';
import type { AppEntity } from '../entities.ts';

export type { BelegConfirmResult, BelegConfirmUndo } from '../../../core/actions/beleg-review.ts';
export type { AutoLinkRunResult } from '../../../core/actions/auto-link-belege.ts';

/** Confirm one receipt against one booking (link + decision + document mark-up) and drop the caches.
 *  Invalidation runs in `finally`: the core action writes the link FIRST, so even a failed confirm
 *  may have changed the DMS — a spurious cache drop is cheap, a missed one shows stale figures. */
export async function confirmBeleg(
    entity: AppEntity,
    input: Omit<BelegConfirmInput, 'entityId'>,
): Promise<BelegConfirmResult> {
    try {
        return await confirmBelegDecision({ ...input, entityId: entity.id });
    } finally {
        appSession().invalidate(entity.id);
    }
}

/** Take one confirm back (the Undo-Toast write) and drop the caches (finally — see confirmBeleg). */
export async function undoConfirmBeleg(entity: AppEntity, undo: BelegConfirmUndo): Promise<void> {
    try {
        await undoBelegConfirmation(undo);
    } finally {
        appSession().invalidate(entity.id);
    }
}

/** Auto-link the given gap bookings; a real run (not dry-run) that linked anything drops the caches. */
export async function runAutoLink(entity: AppEntity, txIds: string[], dryRun: boolean): Promise<AutoLinkRunResult> {
    const result = await autoLinkOffeneBelege(entity.id, txIds, { dryRun });
    if (!dryRun && result.linked > 0) appSession().invalidate(entity.id);
    return result;
}

/**
 * Take a whole auto-link run back (the batch Undo-Toast): unlink every written pair, drop caches.
 * A failing pair does NOT abort the rest (mirroring the forward write loop) — the failures are
 * returned so the caller can report which links could not be reverted.
 */
export async function undoAutoLink(
    entity: AppEntity,
    pairs: Array<{ documentId: string; txId: string }>,
): Promise<Array<{ documentId: string; txId: string; message: string }>> {
    const failed: Array<{ documentId: string; txId: string; message: string }> = [];
    try {
        for (const p of pairs) {
            try {
                await unlinkDocumentFromTransaction(entity.id, p.documentId, p.txId);
            } catch (err) {
                failed.push({ ...p, message: err instanceof Error ? err.message : String(err) });
            }
        }
    } finally {
        appSession().invalidate(entity.id);
    }
    return failed;
}
