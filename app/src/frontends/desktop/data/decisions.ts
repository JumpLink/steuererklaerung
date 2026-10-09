/**
 * Booking-decision data (roadmap S2) for the native app — the write seam behind the "Buchungs-Detail"
 * leaf drilled from a Herleitung contributor row: record a per-transaction bookkeeping decision
 * (reclassify · Begründung · accept an AI rationale) through the shared core action, read a booking's
 * decision + its append-only decision log, and fetch the linked document's metadata (title ·
 * correspondent · KI-Hinweis/ai_note) via the entity's DMS.
 *
 * Thin wrappers: the view calls THESE, never core/@steuererklaerung/* directly. A decision WRITE both
 * persists (via {@link recordClassificationDecision}, source stays 'manual') AND drops the entity's
 * shared EÜR aggregate cache so every derived tax figure recomputes with the manual override — the two
 * are inseparable for "the number moved" to hold, so they live together in {@link saveDecision}.
 */

import { getDocument, getStringField } from '@steuererklaerung/paperless';
import type { ClassificationRecord, DecisionLogEntry } from '@steuererklaerung/store';
import {
    removeClassificationDecision,
    getClassificationDecision,
    getDecisionLog,
    recordClassificationDecision,
    type ClassificationDecisionInput,
} from '../../../core/actions/classifications.ts';
import { createAppContext } from '../../../core/context.ts';
import { appSession } from './session.ts';
import { dmsProviderFor } from './dms.ts';
import type { AppEntity } from '../entities.ts';

export type { ClassificationRecord, DecisionLogEntry } from '@steuererklaerung/store';
export type { ClassificationDecisionInput } from '../../../core/actions/classifications.ts';

/** The linked document's owner-facing metadata for the leaf's "Beleg" group. */
export interface DocMeta {
    documentId: number;
    title: string | null;
    correspondent: string | null;
    /** KI-Hinweis (ai_note) — a Paperless custom field; null for the built-in DMS or when unset. */
    aiNote: string | null;
}

/**
 * Record a booking decision (reclassify · Begründung · accept-AI-note) through the shared core action
 * AND drop the entity's cached EÜR aggregate so every derived figure recomputes with the manual
 * override. Synchronous (the ledger DB is a local SQLite write). Returns the saved record.
 */
export function saveDecision(entity: AppEntity, input: ClassificationDecisionInput): ClassificationRecord {
    const record = recordClassificationDecision(input);
    appSession().invalidate(entity.id);
    return record;
}

/** The persisted decision for one booking (to prefill the leaf's Begründung), or null. */
export function loadDecision(_entity: AppEntity, txId: string): ClassificationRecord | null {
    return getClassificationDecision(txId);
}

/** The append-only decision log for one booking (oldest → newest), read-only. */
export function loadDecisionLog(_entity: AppEntity, txId: string): DecisionLogEntry[] {
    return getDecisionLog(txId);
}

/**
 * The distinct EÜR category labels (income + expense) for the year — the "Umbuchen" ComboRow options.
 * Reuses the shared aggregate cache (no extra Paperless fetch), so the list is exactly the categories
 * the year's numbers are built from.
 */
export async function loadEuerCategories(entity: AppEntity, year: number): Promise<string[]> {
    const agg = await appSession().aggregate(entity, year);
    const labels = [...agg.income, ...agg.expenses].map((c) => c.category);
    return [...new Set(labels)].sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * The linked document's title + correspondent (via the entity's DMS, so a Paperless correspondent id
 * is resolved to its name) plus its KI-Hinweis (ai_note). ai_note is a Paperless custom field, so it
 * is only read for a Paperless-backed entity. Best-effort + never throws: a missing document or a
 * failed fetch degrades to null fields rather than breaking the leaf.
 */
export async function loadDocMeta(entity: AppEntity, documentId: number): Promise<DocMeta> {
    const dms = dmsProviderFor(entity);
    let title: string | null = null;
    let correspondent: string | null = null;
    let aiNote: string | null = null;
    try {
        const doc = await dms.get(String(documentId));
        title = doc?.title ?? null;
        correspondent = doc?.correspondent ?? null;
    } catch {
        /* best-effort — leave title/correspondent null */
    }
    if (dms.kind === 'paperless') {
        try {
            const fieldId = createAppContext().config.custom_field_ids?.ai_note ?? 0;
            if (fieldId > 0) {
                const raw = await getDocument(documentId);
                aiNote = getStringField(raw, fieldId) || null;
            }
        } catch {
            /* best-effort — leave aiNote null */
        }
    }
    return { documentId, title, correspondent, aiNote };
}

/**
 * Take back a manual reclassification — the booking falls back to what the receipt or the rule
 * says.
 *
 * `removeClassificationDecision` existed in the core and had NO caller outside the beleg-review
 * Undo path: once a booking was reclassified by hand, the app offered no way back.
 */
export function removeDecision(_entity: AppEntity, txId: string): boolean {
    return removeClassificationDecision(txId);
}
