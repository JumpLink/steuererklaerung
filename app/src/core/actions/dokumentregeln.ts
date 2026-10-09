/**
 * Dokumentregeln for the built-in DMS (Idee 11): remember once what a sender's paper is, and every
 * later receipt from them arrives filled in — without a model.
 *
 * Rules live in the entity's own `elster.klassifizierung.beleg_regeln`, next to the booking rules
 * (`classification-rules.ts`): the same kind of knowledge about a concrete counterparty, in the
 * same per-entity block, written through the same manifest machinery (`mutateElsterConfig`), so a
 * rule is backed up, migrated and reviewed with the rest of the manifest instead of living in a
 * second store. The ledger holds the RESULT (the values on the receipt and which rule set them);
 * the manifest holds the rule.
 *
 * Unlike a booking rule, a Dokumentregel acts once, on arrival (`applyDokumentRegeln`, called by
 * `storeReceipt`). Removing it therefore never re-classifies a filed year — the values already sit
 * on the receipts. That is why `removeDokumentRegel` is offered openly, where `removeRule` for
 * bookings is deliberately not.
 */

import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';
import { ensureElsterSection, mutateElsterConfig, resolveEntityElster } from '../config/accessors.ts';
import type { ElsterKlassifizierungBelegRegel } from '../config/schema/elster.ts';
import {
    danachGilt,
    dokumentRegelId,
    findeDokumentRegel,
    MIN_DOKUMENT_MUSTER,
    regelAusDokument,
    regelHatWirkung,
    wendeDokumentRegelAn,
    type DokumentRegel,
} from '../dokumentregeln/regeln.ts';

export type { DokumentRegel };

/** An entity's rules in file order — the first match wins. An entity without ELSTER section has none. */
export function loadDokumentRegeln(entityId: string): DokumentRegel[] {
    const rules = resolveEntityElster(entityId)?.klassifizierung?.beleg_regeln ?? [];
    return rules.map((r) => ({ ...r, ...(r.ausnahmen ? { ausnahmen: [...r.ausnahmen] } : {}) }));
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function cleaned(regel: DokumentRegel): ElsterKlassifizierungBelegRegel {
    const out: ElsterKlassifizierungBelegRegel = { muster: regel.muster.trim() };
    for (const key of ['korrespondent', 'dokumenttyp', 'kategorie'] as const) {
        const v = regel[key]?.trim();
        if (v) out[key] = v;
    }
    if (regel.richtung) out.richtung = regel.richtung;
    const ausnahmen = [...new Set((regel.ausnahmen ?? []).map((a) => a.trim()).filter(Boolean))];
    if (ausnahmen.length) out.ausnahmen = ausnahmen;
    return out;
}

export interface RememberDokumentRegelResult {
    rule: DokumentRegel;
    /** True when the pattern is new. */
    added: boolean;
    /** True when an existing rule with this pattern got different values. */
    changed: boolean;
}

/**
 * Remember „Beleg mit X → …". One rule per pattern: a second call with the same pattern UPDATES
 * that rule (the first match wins, so a twin could never fire and the switch would look dead), and
 * reports `changed`. Identical values are a no-op (`added` and `changed` both false).
 */
export function rememberDokumentRegel(entityId: string, regel: DokumentRegel): RememberDokumentRegelResult {
    const rule = cleaned(regel);
    if (rule.muster.length < MIN_DOKUMENT_MUSTER) {
        throw new Error(`Ein Regel-Muster braucht mindestens ${MIN_DOKUMENT_MUSTER} Zeichen.`);
    }
    if (!regelHatWirkung(rule)) {
        throw new Error(
            'Eine Regel braucht mindestens einen Wert: Korrespondent, Dokumenttyp, Kategorie oder Richtung.',
        );
    }
    const existing = loadDokumentRegeln(entityId).find((r) => same(r.muster, rule.muster));
    if (existing) {
        const ausnahmen = [...new Set([...(existing.ausnahmen ?? []), ...(rule.ausnahmen ?? [])])];
        const next = cleaned({ ...rule, ausnahmen });
        if (JSON.stringify(cleaned(existing)) === JSON.stringify(next))
            return { rule: next, added: false, changed: false };
        writeRules(entityId, (list) => list.map((r) => (same(r.muster, rule.muster) ? next : r)));
        return { rule: next, added: false, changed: true };
    }
    writeRules(entityId, (list) => [...list, rule]);
    return { rule, added: true, changed: false };
}

/** Remove the rule with this pattern; false when there was none. Receipts keep what it set. */
export function removeDokumentRegel(entityId: string, muster: string): boolean {
    if (!loadDokumentRegeln(entityId).some((r) => same(r.muster, muster))) return false;
    writeRules(entityId, (list) => list.filter((r) => !same(r.muster, muster)));
    return true;
}

/** Replace the rules wholesale (the settings editor's save path). Rules with no pattern or no value are dropped. */
export function saveDokumentRegeln(entityId: string, rules: readonly DokumentRegel[]): DokumentRegel[] {
    const next = rules.map(cleaned).filter((r) => r.muster.length >= MIN_DOKUMENT_MUSTER && regelHatWirkung(r));
    writeRules(entityId, () => next);
    return next;
}

function writeRules(
    entityId: string,
    change: (list: ElsterKlassifizierungBelegRegel[]) => ElsterKlassifizierungBelegRegel[],
): void {
    ensureElsterSection(entityId);
    mutateElsterConfig(entityId, (raw) => {
        const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
        const list = Array.isArray(k.beleg_regeln) ? ([...k.beleg_regeln] as ElsterKlassifizierungBelegRegel[]) : [];
        raw.klassifizierung = { ...k, beleg_regeln: change(list) };
    });
}

/** Leave one receipt out of a rule (after its values were taken back), so a re-upload does not set them again. */
function addAusnahme(entityId: string, ruleId: string, docId: string): void {
    const rule = loadDokumentRegeln(entityId).find((r) => dokumentRegelId(r.muster) === ruleId);
    if (!rule) return;
    writeRules(entityId, (list) =>
        list.map((r) =>
            dokumentRegelId(r.muster) === ruleId ? cleaned({ ...r, ausnahmen: [...(r.ausnahmen ?? []), docId] }) : r,
        ),
    );
}

/**
 * Apply the entity's rules to a receipt that just arrived: the first matching rule fills the fields
 * still empty and records itself as the origin. Returns the (re-read) document; a receipt no rule
 * covers comes back unchanged. Best effort like the e-invoice step — the receipt is already safe.
 *
 * Runs BEFORE any AI step, so the AI only ever sees what is left open.
 */
export async function applyDokumentRegeln(
    provider: DmsProvider,
    doc: DmsDocument,
    rules: readonly DokumentRegel[],
    text: string | null = null,
): Promise<DmsDocument> {
    if (!provider.setMetadata || rules.length === 0) return doc;
    const regel = findeDokumentRegel(
        { id: doc.id, correspondent: doc.correspondent, title: doc.title, text: text ?? doc.ocrText },
        rules,
    );
    if (!regel) return doc;
    const { patch, origin } = wendeDokumentRegelAn(
        {
            correspondent: doc.correspondent,
            documentType: doc.documentType,
            category: doc.category ?? null,
            direction: doc.direction,
        },
        regel,
    );
    if (!origin) return doc;
    await provider.setMetadata(doc.id, { ...patch, ruleOrigin: origin });
    return (await provider.get(doc.id)) ?? doc;
}

export interface DokumentRegelZurueck {
    /** „Danach gilt: …" */
    satz: string;
    /** The fields that were cleared. */
    felder: string[];
}

/**
 * Take the values a rule set off one receipt: the fields still listed in its origin go back to
 * empty, the origin is dropped, and the receipt is left out of the rule from now on. A field a
 * person edited by hand is no longer in the origin and stays.
 */
export async function nimmDokumentRegelZurueck(
    provider: DmsProvider,
    entityId: string,
    docId: string,
): Promise<DokumentRegelZurueck> {
    if (!provider.setMetadata) throw new Error('Diese Belegquelle kann Metadaten nicht ändern.');
    const doc = await provider.get(docId);
    if (!doc) throw new Error(`Beleg ${docId} nicht gefunden.`);
    const origin = doc.ruleOrigin;
    if (!origin) throw new Error('An diesem Beleg hat keine Regel etwas gesetzt.');
    const clear: Partial<DmsDocument> = { ruleOrigin: null };
    for (const feld of origin.fields) (clear as Record<string, unknown>)[feld] = null;
    await provider.setMetadata(docId, clear);
    addAusnahme(entityId, origin.id, docId);
    return { satz: danachGilt(origin), felder: [...origin.fields] };
}

/** The rule a receipt's current values describe — what the „Als Regel merken" switch stores. */
export function rememberDokumentRegelFromDocument(
    entityId: string,
    doc: Pick<DmsDocument, 'correspondent' | 'documentType' | 'category' | 'direction'>,
    muster?: string,
): RememberDokumentRegelResult {
    return rememberDokumentRegel(entityId, regelAusDokument(doc, muster));
}
