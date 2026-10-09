/**
 * The user's own classification rules — the part of the app that replaces the AI.
 *
 * A booking with no receipt gets its category from the rule chain in `elster/euer-classify.ts`,
 * which ships only signals that mean the same thing for everybody. Everything that encodes a
 * JUDGEMENT about a concrete counterparty — who your customers are, which merchant you treat as
 * private, which supplier a personal name stands for — lives in the entity's own
 * `elster.klassifizierung` block. That block was writable by hand and by an agent, and by nothing
 * else: a person working without AI could reclassify one booking at a time, forever, and never
 * teach the program anything.
 *
 * These actions are the teaching. `rememberRule` is what the "Als Regel merken" switch calls when
 * someone reclassifies a booking: the same judgement, recorded once, applies to every future
 * booking that matches — which is precisely what the LLM was being asked to do each time.
 *
 * ⚠ **Filed years depend on these rules.** Removing one re-classifies the bookings it used to
 * catch, and thus the EÜR of a year that may already have been submitted. `removeRule` therefore
 * exists but is deliberately not offered beside the "remember" path — see `docs/` and the schema
 * comment: append, do not prune.
 */

import { mutateElsterConfig, resolveEntityElster } from '../config/accessors.ts';
import type { ElsterKlassifizierung, ElsterKlassifizierungRegel } from '../config/schema/elster.ts';
import { suggestPattern } from '../elster/regel-aus-beispielen.ts';

/** The five plain needle lists, keyed as they appear in the manifest. */
export type NeedleList =
    | 'eigene_konten'
    | 'privat_gegenseiten'
    | 'gesellschafter_gegenseiten'
    | 'ksk_kennungen'
    | 'erloes_gegenseiten';

/** German labels + one-line explanations, shared by every surface that edits these lists. */
export const NEEDLE_LIST_META: Record<NeedleList, { title: string; description: string }> = {
    eigene_konten: {
        title: 'Eigene Konten',
        description:
            'Namen eigener Konten und früherer Firmierungen — Buchungen dorthin sind Umbuchungen, keine Zahlungen.',
    },
    privat_gegenseiten: {
        title: 'Privat',
        description: 'Händler und Verwendungszwecke, die für dich privat sind — sie werden zur Privatentnahme.',
    },
    gesellschafter_gegenseiten: {
        title: 'Gesellschafter',
        description: 'Namen der Gesellschafter — ohne Rechnungsnummer eine Kapitalbewegung, keine Ausgabe.',
    },
    ksk_kennungen: {
        title: 'KSK-Kennungen',
        description: 'Zusätzliche Kennzeichen einer KSK-Mitgliedschaft, z. B. die Mitgliedsnummer.',
    },
    erloes_gegenseiten: {
        title: 'Kunden (Erlöse)',
        description: 'Kundennamen, die einen Zahlungseingang als Erlös kennzeichnen.',
    },
};

/** Everything the rules editor shows for one entity, already normalised. */
export interface ClassificationRules {
    lists: Record<NeedleList, string[]>;
    aufwandRegeln: ElsterKlassifizierungRegel[];
}

const EMPTY: ClassificationRules = {
    lists: {
        eigene_konten: [],
        privat_gegenseiten: [],
        gesellschafter_gegenseiten: [],
        ksk_kennungen: [],
        erloes_gegenseiten: [],
    },
    aufwandRegeln: [],
};

/** Read an entity's rules. An entity without an ELSTER section has none — not an error. */
export function loadClassificationRules(entityId: string): ClassificationRules {
    const elster = resolveEntityElster(entityId);
    const k = elster?.klassifizierung;
    if (!k) return { lists: { ...EMPTY.lists }, aufwandRegeln: [] };
    return {
        lists: {
            eigene_konten: [...(k.eigene_konten ?? [])],
            privat_gegenseiten: [...(k.privat_gegenseiten ?? [])],
            gesellschafter_gegenseiten: [...(k.gesellschafter_gegenseiten ?? [])],
            ksk_kennungen: [...(k.ksk_kennungen ?? [])],
            erloes_gegenseiten: [...(k.erloes_gegenseiten ?? [])],
        },
        aufwandRegeln: (k.aufwand_regeln ?? []).map((r) => ({ ...r })),
    };
}

// Lives in the pure core now (regel-aus-beispielen.ts builds on it); re-exported for the callers here.
export { suggestPattern };

/** Whether an identical rule already exists (case-insensitive on the pattern). */
function hasRule(existing: readonly ElsterKlassifizierungRegel[], muster: string, kategorie: string): boolean {
    const needle = muster.trim().toLowerCase();
    return existing.some((r) => r.muster.trim().toLowerCase() === needle && r.kategorie === kategorie);
}

export interface RememberRuleResult {
    /** The rule as stored. */
    rule: ElsterKlassifizierungRegel;
    /** False when an identical rule already existed — nothing was written. */
    added: boolean;
}

/**
 * Remember "text X means category Y" for this entity.
 *
 * Idempotent: an identical rule is not appended twice, so pressing "Als Regel merken" on a second
 * booking of the same supplier reports honestly instead of growing the list. A rule with the same
 * pattern but a DIFFERENT category IS appended — the chain takes the first match, so the older one
 * still wins, and silently discarding the new one would look like the switch did nothing.
 */
export function rememberRule(
    entityId: string,
    muster: string,
    kategorie: string,
    opts: { ausnahmen?: readonly string[] } = {},
): RememberRuleResult {
    const pattern = muster.trim();
    if (!pattern) throw new Error('Ein Regel-Muster darf nicht leer sein.');
    if (!kategorie.trim()) throw new Error('Eine Regel braucht eine Zielkategorie.');
    const ausnahmen = [...new Set((opts.ausnahmen ?? []).map((a) => a.trim()).filter(Boolean))];
    const rule: ElsterKlassifizierungRegel = ausnahmen.length
        ? { muster: pattern, kategorie, ausnahmen }
        : { muster: pattern, kategorie };

    const current = loadClassificationRules(entityId).aufwandRegeln;
    if (hasRule(current, pattern, kategorie)) {
        // The same rule again with new exceptions: add them to the stored one rather than a twin that
        // would never fire (the first of two equal patterns always wins).
        const existing = current.find(
            (r) => r.muster.trim().toLowerCase() === pattern.toLowerCase() && r.kategorie === kategorie,
        );
        const merged = [...new Set([...(existing?.ausnahmen ?? []), ...ausnahmen])];
        if (merged.length === (existing?.ausnahmen ?? []).length) return { rule, added: false };
        mutateElsterConfig(entityId, (raw) => {
            const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
            const rules = Array.isArray(k.aufwand_regeln)
                ? [...(k.aufwand_regeln as ElsterKlassifizierungRegel[])]
                : [];
            const i = rules.findIndex(
                (r) => r.muster.trim().toLowerCase() === pattern.toLowerCase() && r.kategorie === kategorie,
            );
            if (i >= 0) rules[i] = { ...rules[i], ausnahmen: merged };
            raw.klassifizierung = { ...k, aufwand_regeln: rules };
        });
        return { rule: { ...rule, ausnahmen: merged }, added: false };
    }

    mutateElsterConfig(entityId, (raw) => {
        const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
        const rules = Array.isArray(k.aufwand_regeln) ? [...(k.aufwand_regeln as unknown[])] : [];
        rules.push(rule);
        raw.klassifizierung = { ...k, aufwand_regeln: rules };
    });
    return { rule, added: true };
}

/** Replace one needle list wholesale (the editor's save path). Entries are trimmed; blanks dropped. */
export function saveNeedleList(entityId: string, list: NeedleList, entries: readonly string[]): string[] {
    const cleaned = entries.map((e) => e.trim()).filter((e) => e.length > 0);
    mutateElsterConfig(entityId, (raw) => {
        const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
        raw.klassifizierung = { ...k, [list]: cleaned };
    });
    return cleaned;
}

/** Replace the supplier→category rules wholesale (the editor's save path). */
export function saveAufwandRegeln(
    entityId: string,
    rules: readonly ElsterKlassifizierungRegel[],
): ElsterKlassifizierungRegel[] {
    // `ausnahmen` rides along untouched: the editor edits pattern and category, and dropping the
    // exceptions on save would silently re-classify the bookings someone deselected.
    const cleaned = rules
        .map((r) => ({
            muster: r.muster.trim(),
            kategorie: r.kategorie.trim(),
            ...(r.ausnahmen?.length ? { ausnahmen: [...r.ausnahmen] } : {}),
        }))
        .filter((r) => r.muster.length > 0 && r.kategorie.length > 0);
    mutateElsterConfig(entityId, (raw) => {
        const k = (raw.klassifizierung ?? {}) as Record<string, unknown>;
        raw.klassifizierung = { ...k, aufwand_regeln: cleaned };
    });
    return cleaned;
}

/** The rules block as the classifier wants it (camelCase), for a preview against real bookings. */
export function toClassifyRules(rules: ClassificationRules): {
    eigeneKonten: string[];
    privatGegenseiten: string[];
    gesellschafterGegenseiten: string[];
    kskKennungen: string[];
    erloesGegenseiten: string[];
    aufwandRegeln: ElsterKlassifizierungRegel[];
} {
    return {
        eigeneKonten: rules.lists.eigene_konten,
        privatGegenseiten: rules.lists.privat_gegenseiten,
        gesellschafterGegenseiten: rules.lists.gesellschafter_gegenseiten,
        kskKennungen: rules.lists.ksk_kennungen,
        erloesGegenseiten: rules.lists.erloes_gegenseiten,
        aufwandRegeln: rules.aufwandRegeln,
    };
}

export type { ElsterKlassifizierung, ElsterKlassifizierungRegel };
