/**
 * Entity lookups over a consolidated {@link Manifest}. Pure (no I/O) — given a parsed manifest they
 * pick out one entity, fail-loud when it is unknown, or choose a sensible default entity.
 */

import { entityIdAliases } from '@steuererklaerung/store';
import { ConfigError } from '../lib/errors.ts';
import type { ElsterConfig } from './schema/elster.ts';
import type { Manifest, ManifestEntity } from './schema/manifest.ts';

/**
 * Find the entity `id` names, accepting either a workspace id (`gbr`) or its ledger alias (`artcode`)
 * — the two namespaces overlap (see store `entityIdAliases`). Fail-loud with the list of known ids.
 */
export function requireEntity(manifest: Manifest, id: string): ManifestEntity {
    const aliases = new Set(entityIdAliases(id));
    const entity = manifest.entities.find((e) => e.id === id || aliases.has(e.id));
    if (!entity) {
        const known = manifest.entities.map((e) => e.id).join(', ') || '(keine)';
        throw new ConfigError(`Entität „${id}" nicht im Manifest gefunden. Bekannte Entitäten: ${known}.`);
    }
    return entity;
}

/** True iff the entity has an explicit id/alias match (used to distinguish "known" from "default"). */
export function findEntity(manifest: Manifest, id: string): ManifestEntity | undefined {
    const aliases = new Set(entityIdAliases(id));
    return manifest.entities.find((e) => e.id === id || aliases.has(e.id));
}

/**
 * The default entity when the caller named none: the first entity of the given `kind` if one is
 * requested and present, otherwise the first non-`privat` (business) entity, otherwise the first
 * entity. Throws only on an empty registry (which the schema already forbids, so this is defensive).
 */
export function defaultEntityFor(manifest: Manifest, kind?: string): ManifestEntity {
    if (manifest.entities.length === 0) throw new ConfigError('Manifest enthält keine Entität.');
    if (kind) {
        const byKind = manifest.entities.find((e) => e.kind === kind);
        if (byKind) return byKind;
    }
    return manifest.entities.find((e) => e.kind !== 'privat') ?? manifest.entities[0];
}

/** A trailing `*` matches by prefix; any other pattern matches the account key exactly. */
export function matchAccount(key: string, patterns: string[]): boolean {
    return patterns.some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p));
}

/** Expand an entity's account globs against the real store account keys (exact keys only). */
export function resolveEntityAccounts(entity: { accounts: string[] }, storeKeys: string[]): string[] {
    return storeKeys.filter((k) => matchAccount(k, entity.accounts));
}

/**
 * The default account scope for a tax report when the caller gave no explicit account keys — derived
 * from the ELSTER config's `entity_id` via the manifest, so a report is always tied to exactly ONE
 * entity. It deliberately does NOT sum every `camt:` account: with a multi-entity manifest that would
 * silently compute a different entity (e.g. an `--entity jumplink` report accidentally adding the whole
 * GbR). Returns the named entity's accounts, or `[]` (→ an empty report) when the entity is unknown.
 *
 * The ELSTER config carries the LEDGER entity id (e.g. `artcode`), while the manifest keys the entity by
 * its workspace alias (`gbr`); the alias set is widened so the real GbR config resolves to its accounts.
 */
export function defaultAccountScope(
    manifest: Manifest,
    storeKeys: string[],
    elster: ElsterConfig | undefined,
): string[] {
    if (!elster?.entity_id) return [];
    const aliases = new Set(entityIdAliases(elster.entity_id));
    const entity = manifest.entities.find((e) => aliases.has(e.id) || e.id === elster.entity_id);
    return entity ? resolveEntityAccounts(entity, storeKeys) : [];
}
