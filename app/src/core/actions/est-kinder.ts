/**
 * The children on the Anlage Kind — the block of the private tax return that could only ever be
 * written by hand.
 *
 * Children are not a detail of the computation: each one carries a Kinderfreibetrag, a Kindergeld
 * claim that is set against it, possibly Kinderbetreuungskosten and Schulgeld. Leaving them out
 * changes the assessed tax by four figures, and every other input of the return has had a GUI for
 * a while. `upsertEstJahr` writes the per-year block; nothing wrote the child list.
 *
 * Identified by IdNr where there is one, else by name + date of birth. A random id would be the
 * simpler code and the wrong model: the manifest is read by people, and the tax office identifies a
 * child by exactly these fields.
 */

import { mutateEstConfig, resolveEntityEst } from '../config/accessors.ts';
import type { EstConfig } from '../config/schema/est.ts';

/** One child as the editor deals with it — the identity fields plus the current year's figures. */
export type EstKind = NonNullable<EstConfig['kinder']>[number];

/** A stable key for one child: the IdNr when known, else name + date of birth. */
export function kindKey(kind: Pick<EstKind, 'idnr' | 'vorname' | 'geburtsdatum'>): string {
    if (kind.idnr) return `idnr:${kind.idnr}`;
    return `name:${kind.vorname.trim().toLowerCase()}|${kind.geburtsdatum}`;
}

/** The children of an entity, in manifest order. An entity without an ESt config has none. */
export function listKinder(entityId: string): EstKind[] {
    return resolveEntityEst(entityId)?.kinder ?? [];
}

/**
 * Insert or replace one child, matched by {@link kindKey}.
 *
 * An edit keeps its place in the list, so the manifest diff of a corrected IdNr is that correction
 * and not a reordering of the family.
 */
export function upsertKind(entityId: string, kind: EstKind): EstConfig {
    const key = kindKey(kind);
    return mutateEstConfig(entityId, (raw) => {
        const kinder = Array.isArray(raw.kinder) ? (raw.kinder as Array<Record<string, unknown>>) : [];
        raw.kinder = kinder;
        const index = kinder.findIndex((k) => kindKey(k as unknown as EstKind) === key);
        if (index === -1) kinder.push(kind as unknown as Record<string, unknown>);
        else kinder[index] = { ...kinder[index], ...(kind as unknown as Record<string, unknown>) };
        syncKinderCount(raw);
    });
}

/** Remove one child. Unknown key is a no-op — deleting twice is not an error worth an exception. */
export function removeKind(entityId: string, key: string): EstConfig {
    return mutateEstConfig(entityId, (raw) => {
        const kinder = Array.isArray(raw.kinder) ? (raw.kinder as Array<Record<string, unknown>>) : [];
        raw.kinder = kinder.filter((k) => kindKey(k as unknown as EstKind) !== key);
        syncKinderCount(raw);
    });
}

/**
 * Keep `veranlagung.kinder` — the count the zumutbare Belastung is graded by — equal to the list.
 *
 * They are two representations of one fact, and ERiC checks that they agree (the E10 plausibility
 * the schema comment names). Letting a person maintain both is letting them disagree; the count
 * follows the list, which is the half that carries the detail.
 */
function syncKinderCount(raw: Record<string, unknown>): void {
    const kinder = Array.isArray(raw.kinder) ? raw.kinder : [];
    const veranlagung = raw.veranlagung as Record<string, unknown> | undefined;
    if (veranlagung) veranlagung.kinder = kinder.length;
}

/** Everything the year-specific part of a child needs, keyed by year. */
export function kindJahr(kind: EstKind, jahr: number): NonNullable<EstKind['jahre']>[number] | undefined {
    return kind.jahre?.find((j) => j.jahr === jahr);
}
