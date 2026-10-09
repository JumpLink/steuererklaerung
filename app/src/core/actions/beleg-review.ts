/**
 * Beleg-Eingang confirm — the ONE write behind "Bestätigen und weiter", shared by every frontend
 * (core-first: the native review flow, and later web/CLI/MCP, call exactly this).
 *
 * One confirm = link-first-then-classify plus the document mark-up the redesign asks for:
 *   1. link the receipt to the chosen booking via the entity's DMS provider (idempotent,
 *      GoBD-guarded for every back-end),
 *   2. record the classification decision in the ledger (`category` undefined = ACCEPT the AI
 *      reading — numbers unchanged; a label = MANUAL override — the EÜR moves),
 *   3. Paperless only: tag the document `ki-uberarbeitet` (human-reviewed) and, on an override,
 *      write the corrected `accounting_category` select field so the document-side EÜR cross-check
 *      agrees with the ledger. The document write is best-effort — the ledger decision is the
 *      authoritative record and stands even if Paperless is unreachable.
 *
 * The result carries an undo snapshot incl. the PRIOR ledger decision; {@link undoBelegConfirmation}
 * takes the confirm back and restores that prior state (Undo-Toast, HIG: undo instead of a
 * confirmation dialog). Undo order: unlink FIRST (the guarded, most fallible write), then the
 * ledger restore, then the best-effort document revert — a refused unlink leaves the ledger intact.
 */

import { getDocument, getCustomFieldValue, mergeCustomFields, updateDocument } from '@steuererklaerung/paperless';
import type { ClassificationRecord } from '@steuererklaerung/store';
import { createAppContext } from '../context.ts';
import type { SyncConfig } from '../config/schema/paperless.ts';
import { resolveEntityDms, unlinkDocumentFromTransaction } from './link-candidates.ts';
import {
    getClassificationDecision,
    recordClassificationDecision,
    restoreClassificationDecision,
} from './classifications.ts';
import { assertTxPeriodUnlocked } from '../lib/ledger/period-guard.ts';
import { paperlessUpdateDocumentFields } from './paperless/write.ts';
import { ACCOUNTING_CATEGORY_OPTIONS } from '../lib/select-field-constants.ts';

export interface BelegConfirmInput {
    entityId: string;
    documentId: string;
    /** The booking backing this receipt (link-first-then-classify — a confirm needs a booking). */
    txId: string;
    /** SKR03 category override; undefined = accept the AI reading (EÜR/USt unchanged). */
    category?: string;
    /** Owner Begründung. */
    note?: string;
    /** The AI rationale shown to the owner (kept for accept/override provenance). */
    aiNote?: string | null;
}

/** Everything needed to take one confirm back. */
export interface BelegConfirmUndo {
    entityId: string;
    documentId: string;
    txId: string;
    /** The doc ⇄ tx link existed BEFORE this confirm — Undo must then leave it in place. */
    wasLinked: boolean;
    /** The booking's ledger decision BEFORE this confirm (null = none) — Undo restores it verbatim,
     *  never blind-deletes (an earlier override/Begründung on the same booking must survive). */
    previousDecision: ClassificationRecord | null;
    /** Paperless-only prior document state (absent when no document write happened). */
    paperless?: {
        /** RAW accounting_category custom-field value before the confirm (option id or legacy label;
         *  null = field was empty). Stored raw so a drifted option-id map cannot corrupt the revert. */
        previousCategoryRaw: string | number | null;
        /** Whether the confirm wrote a category (only then does Undo restore/clear it). */
        wroteCategory: boolean;
        /** The ki-uberarbeitet tag was already present before the confirm. */
        hadKiTag: boolean;
    };
}

export interface BelegConfirmResult {
    record: ClassificationRecord;
    undo: BelegConfirmUndo;
    /** Paperless document write: 'skipped' for builtin/non-numeric docs, 'failed' = decision stands
     *  but the document could not be marked (surface as a warning, not an error). */
    documentWrite: 'updated' | 'skipped' | 'failed';
}

/** True when the label may be written to the `accounting_category` select field. */
function isKnownCategory(label: string): boolean {
    return (ACCOUNTING_CATEGORY_OPTIONS as readonly string[]).includes(label);
}

/**
 * Confirm one receipt against one booking: link + ledger decision + (Paperless) document mark-up.
 * Throws when the LINK is impossible (GoBD-locked period, unknown document) — then nothing was
 * recorded. After a successful link the decision always lands; only the document write degrades.
 */
export async function confirmBelegDecision(
    input: BelegConfirmInput,
    options: { path?: string } = {},
): Promise<BelegConfirmResult> {
    const { provider } = resolveEntityDms(input.entityId, options.path);
    const before = await provider.get(input.documentId);
    if (!before) throw new Error(`Dokument ${input.documentId} nicht gefunden.`);
    const wasLinked = before.linkedTxIds.includes(input.txId);
    if (!wasLinked) {
        if (!provider.link) throw new Error('Dieses DMS unterstützt das Verknüpfen nicht.');
        // GoBD: guarded here so the lock holds for every back-end (Paperless has no ledger access).
        assertTxPeriodUnlocked(input.txId, 'Verknüpfen');
        await provider.link(input.documentId, input.txId);
    }

    const numericDocId = /^\d+$/.test(input.documentId) ? Number(input.documentId) : null;
    const previousDecision = getClassificationDecision(input.txId);
    const record = recordClassificationDecision({
        transactionId: input.txId,
        category: input.category,
        note: input.note,
        aiNote: input.aiNote ?? undefined,
        aiNoteAccepted: true,
        documentId: numericDocId,
    });

    const undo: BelegConfirmUndo = {
        entityId: input.entityId,
        documentId: input.documentId,
        txId: input.txId,
        wasLinked,
        previousDecision,
    };
    let documentWrite: BelegConfirmResult['documentWrite'] = 'skipped';

    if (provider.kind === 'paperless' && numericDocId != null) {
        try {
            const config = createAppContext().config;
            const kiTagId = config.tag_ids?.ai_reviewed ?? 0;
            const catFieldId = config.custom_field_ids?.accounting_category ?? 0;
            const raw = await getDocument(numericDocId);
            const rawCat = catFieldId > 0 ? getCustomFieldValue(raw, catFieldId) : null;
            const previousCategoryRaw = typeof rawCat === 'string' || typeof rawCat === 'number' ? rawCat : null;
            const existingTags = raw.tags ?? [];
            const hadKiTag = kiTagId > 0 && existingTags.includes(kiTagId);
            const payload = kiTagId > 0 && !hadKiTag ? { tags: [...existingTags, kiTagId] } : undefined;
            const wroteCategory = input.category != null && catFieldId > 0 && isKnownCategory(input.category);
            const customFields = wroteCategory ? { accounting_category: input.category } : undefined;
            if (payload || customFields) {
                await paperlessUpdateDocumentFields(numericDocId, { payload, customFields, config });
                documentWrite = 'updated';
            }
            undo.paperless = { previousCategoryRaw, wroteCategory, hadKiTag };
        } catch (err) {
            // The ledger decision is authoritative; a failed Paperless mark-up degrades to a warning.
            documentWrite = 'failed';
            console.error(`[beleg-review] Paperless-Markierung fehlgeschlagen: ${errMessage(err)}`);
        }
    }

    return { record, undo, documentWrite };
}

/**
 * Take one confirm back (the Undo-Toast write): remove the link this confirm created (never a
 * pre-existing one) — the guarded write comes FIRST so a GoBD refusal leaves everything intact —
 * then restore the booking's prior ledger decision, then best-effort revert the Paperless mark-up
 * (restore the raw `accounting_category` value, remove a freshly added `ki-uberarbeitet` tag).
 */
export async function undoBelegConfirmation(undo: BelegConfirmUndo, options: { path?: string } = {}): Promise<void> {
    if (!undo.wasLinked) await unlinkDocumentFromTransaction(undo.entityId, undo.documentId, undo.txId, options);
    restoreClassificationDecision(undo.txId, undo.previousDecision);

    const numericDocId = /^\d+$/.test(undo.documentId) ? Number(undo.documentId) : null;
    if (!undo.paperless || numericDocId == null) return;
    try {
        const config = createAppContext().config;
        await revertPaperlessMarkup(numericDocId, undo.paperless, config);
    } catch (err) {
        // Best-effort: the accounting state (decision + link) is already reverted.
        console.error(`[beleg-review] Paperless-Rücknahme fehlgeschlagen: ${errMessage(err)}`);
    }
}

/** Restore the document's pre-confirm tag/category state (raw PATCH — supports clearing a select). */
async function revertPaperlessMarkup(
    documentId: number,
    prior: NonNullable<BelegConfirmUndo['paperless']>,
    config: SyncConfig,
): Promise<void> {
    const kiTagId = config.tag_ids?.ai_reviewed ?? 0;
    const catFieldId = config.custom_field_ids?.accounting_category ?? 0;
    const raw = await getDocument(documentId);

    const payload: { tags?: number[]; custom_fields?: Array<{ field: number; value: unknown }> } = {};
    const tags = raw.tags ?? [];
    if (!prior.hadKiTag && kiTagId > 0 && tags.includes(kiTagId)) payload.tags = tags.filter((t) => t !== kiTagId);

    if (prior.wroteCategory && catFieldId > 0) {
        // Write the captured RAW value back verbatim (null clears) — no label/option-id round-trip,
        // so a drifted select_field_options map cannot corrupt the revert.
        payload.custom_fields = mergeCustomFields(raw.custom_fields ?? [], [
            { field: catFieldId, value: prior.previousCategoryRaw },
        ]);
    }

    if (payload.tags || payload.custom_fields) await updateDocument(documentId, payload);
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
