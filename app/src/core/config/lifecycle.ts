/**
 * Manifest LIFECYCLE — the constructor and destructor the config layer never had.
 *
 * Every other writer in this directory ({@link mutateManifest} and everything in ./accessors.ts)
 * can only ever CHANGE a manifest that already exists: `mutateManifest` throws outright when the
 * file is absent, and among the entity writers there is no way to add an entity or take one away.
 * That made the whole app update-only — it could be driven, but only after a human had hand-written
 * `steuererklaerung.json` in a text editor. A first-run assistant, an "Entität anlegen" row or an
 * installed package all need this module underneath them; without it they would be surfaces over a
 * layer that cannot write.
 *
 * The invariants every function here keeps, mirroring {@link mutateManifest}:
 *   - RAW mutation — `//`-comment keys and unknown/future keys survive,
 *   - validate BEFORE writing — an invalid change throws and leaves the file untouched,
 *   - atomic write (tmp + rename) — a crash mid-write cannot truncate the manifest,
 *   - fail-loud on an unknown entity id, naming the ids that do exist.
 *
 * Deliberately ledger-free: the GoBD locked-period check needs the SQLite ledger, which this layer
 * must not depend on. {@link removeManifestEntity} therefore takes an optional `assertRemovable`
 * hook, and `core/actions/entities.ts` supplies the real guard.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { entityIdAliases } from '@steuererklaerung/store';
import { ConfigError } from '../lib/errors.ts';
import { getManifestPath, loadManifest, mutateManifest, writeManifestAtomic } from './manifest.ts';
import type { ManifestEntity } from './schema/entity.ts';
import { type Manifest, MANIFEST_VERSION, ManifestSchema } from './schema/manifest.ts';

/** The fields a caller supplies for a brand-new entity. Everything else defaults per the schema. */
export interface NewEntityInput {
    /** Stable id — see {@link assertValidNewId} for the format enforced on NEW ids. */
    id: string;
    /** Display name shown in the switcher + header. */
    name: string;
    /** gbr · einzelunternehmen · privat · … (free-form; defaults to `einzelunternehmen`). */
    kind?: string;
    /** Account-key globs routed to this entity (`camt:*`, `qonto:01234567*`, …). */
    accounts?: string[];
}

/** The fields {@link renameManifestEntity} may change. Omitted fields stay as they are. */
export interface EntityPatch {
    id?: string;
    name?: string;
    kind?: string;
    accounts?: string[];
}

/**
 * The id format required of a NEW entity: lowercase ASCII letters, digits and hyphens, starting
 * with a letter.
 *
 * The schema itself stays at `z.string().min(1)` on purpose — tightening it would reject existing
 * manifests on load, and this file's whole job is to be safe for Altbestand. The check therefore
 * runs only when an id is being INVENTED, where we still get to choose. The id ends up in account-key
 * globs, `--entity` arguments and localStorage keys, so an id with a space or a slash in it is a
 * paper cut in every one of those places.
 */
const NEW_ID_RE = /^[a-z][a-z0-9-]*$/;

function assertValidNewId(id: string, path: string): void {
    if (!NEW_ID_RE.test(id)) {
        throw new ConfigError(
            `Ungültige Entitäts-Id „${id}". Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, ` +
                'beginnend mit einem Buchstaben (z. B. „gbr", „privat", „mein-betrieb").',
            path,
        );
    }
}

/**
 * Derive a legal entity id from a display name: lowercase, umlauts spelled out, everything else a
 * hyphen.
 *
 * {@link assertValidNewId} requires `^[a-z][a-z0-9-]*$`, and no surface should make a user learn
 * that rule — the setup assistant and `config init` both ask for a NAME. Umlauts are SPELLED OUT
 * rather than stripped, because stripping collides: "Große" and "Grosse" are different firms that
 * would become one id.
 *
 * Falls back to a fixed id when the name yields nothing usable (a name in a non-Latin script). The
 * id is an internal handle; the display name carries the identity.
 */
export function slugFromName(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/^[^a-z]+/, '');
    return slug || 'betrieb';
}

/** Every id already taken in `entities`, widened by each id's aliases. */
function takenIds(entities: Array<Record<string, unknown>>): Set<string> {
    const taken = new Set<string>();
    for (const e of entities) {
        const id = String(e.id);
        taken.add(id);
        for (const alias of entityIdAliases(id)) taken.add(alias);
    }
    return taken;
}

/**
 * Refuse an id that collides with an existing entity — including via the alias namespace, where
 * `gbr` and `artcode` denote the same entity (see store `entityIdAliases`). Two entities that
 * resolve to one another would make `--entity` ambiguous and route transactions to whichever the
 * lookup happened to find first.
 */
function assertIdFree(entities: Array<Record<string, unknown>>, id: string, path: string): void {
    const taken = takenIds(entities);
    // entityIdAliases(id) includes `id` itself, so this covers the plain-duplicate case too.
    if (entityIdAliases(id).some((a) => taken.has(a))) {
        throw new ConfigError(
            `Es gibt bereits eine Entität mit der Id „${id}" (oder einem gleichbedeutenden Alias). ` +
                `Vorhanden: ${entities.map((e) => String(e.id)).join(', ')}.`,
            path,
        );
    }
}

/** Normalise a {@link NewEntityInput} to the raw shape written into `entities[]`. */
function rawEntityFrom(input: NewEntityInput): Record<string, unknown> {
    return {
        id: input.id,
        name: input.name,
        kind: input.kind ?? 'einzelunternehmen',
        accounts: input.accounts ?? [],
    };
}

/** Locate one entity's raw object by id (alias-aware); fail loud naming the known ids. */
function findRawEntity(
    entities: Array<Record<string, unknown>>,
    id: string,
    path: string,
): { entity: Record<string, unknown>; index: number } {
    const aliases = new Set(entityIdAliases(id));
    const index = entities.findIndex((e) => e.id === id || aliases.has(String(e.id)));
    if (index < 0) {
        const known = entities.map((e) => String(e.id)).join(', ') || '(keine)';
        throw new ConfigError(`Entität „${id}" nicht im Manifest gefunden. Bekannte Entitäten: ${known}.`, path);
    }
    return { entity: entities[index], index };
}

/**
 * Create a brand-new v1 manifest at `path` holding exactly one entity.
 *
 * Refuses to overwrite an existing file — the manifest is the user's only copy of their tax master
 * data (Steuernummern, partner IdNrn, account bindings), so "create" may never be a silent
 * truncation. Callers that mean to add to an existing manifest use {@link createManifestEntity}.
 */
export function initManifest(path: string, entity: NewEntityInput): Manifest {
    if (existsSync(path)) {
        throw new ConfigError(
            `Unter ${path} liegt bereits eine Konfiguration — sie wird nicht überschrieben. ` +
                'Eine weitere Entität fügst du mit „steuer config add-entity" hinzu.',
            path,
        );
    }
    assertValidNewId(entity.id, path);
    const raw: Record<string, unknown> = {
        version: MANIFEST_VERSION,
        entities: [rawEntityFrom(entity)],
    };
    const result = ManifestSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Neues Manifest wäre ungültig:\n${issues}`, path);
    }
    // The target is usually ~/.config/steuererklaerung on a fresh installation, which nothing has
    // created yet. Only after validation: a rejected manifest must not leave a directory behind.
    mkdirSync(dirname(path), { recursive: true });
    writeManifestAtomic(path, raw);
    return result.data;
}

/** Append a new entity to an existing manifest. Fails on a duplicate id (alias-aware). */
export function createManifestEntity(path: string, entity: NewEntityInput): Manifest {
    assertValidNewId(entity.id, path);
    return mutateManifest(path, (raw) => {
        const entities = (raw.entities ?? []) as Array<Record<string, unknown>>;
        assertIdFree(entities, entity.id, path);
        entities.push(rawEntityFrom(entity));
        raw.entities = entities;
    });
}

/**
 * Change an entity's identity fields in place, preserving its `elster` / `est` / `recurring`
 * sections and any unknown keys.
 *
 * A changed `id` is the interesting case: it must not collide with another entity, and everything
 * that REFERENCES the id by value — `elster.entity_id`, ledger rows, filing records — keeps the old
 * value. Renaming the id is therefore only safe on an entity that has not been used yet, which is
 * exactly the first-run case this exists for; the caller is told so rather than us silently
 * rewriting foreign data we do not own.
 */
export function renameManifestEntity(path: string, id: string, patch: EntityPatch): Manifest {
    if (patch.id !== undefined) assertValidNewId(patch.id, path);
    return mutateManifest(path, (raw) => {
        const entities = (raw.entities ?? []) as Array<Record<string, unknown>>;
        const { entity } = findRawEntity(entities, id, path);
        if (patch.id !== undefined && patch.id !== entity.id) {
            const others = entities.filter((e) => e !== entity);
            assertIdFree(others, patch.id, path);
            const elster = entity.elster as Record<string, unknown> | undefined;
            if (elster?.entity_id !== undefined && elster.entity_id === entity.id) elster.entity_id = patch.id;
            entity.id = patch.id;
        }
        if (patch.name !== undefined) entity.name = patch.name;
        if (patch.kind !== undefined) entity.kind = patch.kind;
        if (patch.accounts !== undefined) entity.accounts = patch.accounts;
    });
}

/**
 * A caller-supplied veto on removing an entity, resolved by id. Throws to refuse.
 *
 * This is how the GoBD Festschreibung reaches a module that must not import the ledger: the action
 * layer passes a hook that looks up the entity's locked periods. A missing hook removes without
 * that check, which is correct for a manifest that has no ledger behind it (tests, first run).
 */
export type RemovalGuard = (entity: ManifestEntity) => void;

/**
 * Remove an entity from the manifest.
 *
 * Refuses in two cases. The LAST entity may not be removed — `ManifestSchema` requires at least one,
 * so the write would fail validation anyway, and a dedicated message beats a schema dump. And
 * `guard` may veto, which is where the GoBD lock lands: books that are festgeschrieben must keep the
 * entity they were filed under.
 *
 * What this does NOT do is delete the entity's DATA — transactions, receipts, filings and ledger
 * rows all stay. Removing an entity is an un-listing, not an erasure; wiring it to a cascading
 * delete would make one click destroy records that tax law requires be kept for ten years.
 */
export function removeManifestEntity(path: string, id: string, guard?: RemovalGuard): Manifest {
    const manifest = loadManifest(path);
    if (manifest.entities.length <= 1) {
        throw new ConfigError(
            `„${id}" ist die einzige Entität — sie kann nicht entfernt werden. ` +
                'Lege zuerst eine weitere Entität an, oder ändere diese mit „steuer config rename-entity".',
            path,
        );
    }
    const aliases = new Set(entityIdAliases(id));
    const target = manifest.entities.find((e) => e.id === id || aliases.has(e.id));
    if (!target) {
        const known = manifest.entities.map((e) => e.id).join(', ') || '(keine)';
        throw new ConfigError(`Entität „${id}" nicht im Manifest gefunden. Bekannte Entitäten: ${known}.`, path);
    }
    guard?.(target);

    return mutateManifest(path, (raw) => {
        const entities = (raw.entities ?? []) as Array<Record<string, unknown>>;
        const { index } = findRawEntity(entities, id, path);
        entities.splice(index, 1);
    });
}

/** True iff a manifest exists at the resolved path — the "is this a first run?" question. */
export function manifestExists(path: string = getManifestPath()): boolean {
    return existsSync(path);
}
