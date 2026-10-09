/**
 * Entity lifecycle actions — create a workspace, add / rename / remove an entity.
 *
 * These are the shared actions behind `steuer config init|add-entity|rename-entity|remove-entity`,
 * the first-run assistant and the entity switcher's management rows. They wrap the pure config
 * lifecycle (`core/config/lifecycle.ts`) and add the one thing that layer must not reach for
 * itself: the SQLite ledger, whose GoBD Festschreibung vetoes removing an entity whose books are
 * final.
 *
 * The split matters. `core/config/` stays I/O-light and testable without a database; the guard is
 * injected here, so a manifest with no ledger behind it (tests, a fresh install) removes cleanly
 * while a real installation cannot un-list an entity it has already filed for.
 */

import {
    ledgerDbExists,
    ledgerDbPath,
    ledgerEntityForWorkspaceEntity,
    migrate,
    openLedger,
} from '@steuererklaerung/store';
import {
    assignManifestAccount,
    createManifestEntity,
    type EntityPatch,
    getManifestPath,
    initManifest,
    type Manifest,
    type ManifestEntity,
    loadManifest,
    manifestExists,
    matchAccount,
    type NewEntityInput,
    removeManifestEntity,
    renameManifestEntity,
} from '../config/index.ts';

/**
 * Every year an entity has locked (GoBD festgeschrieben), newest first. Empty when there is no
 * ledger yet, when the entity has no ledger counterpart, or when nothing is locked.
 *
 * Best-effort by design: a missing database is "nothing is locked", not an error — the first-run
 * path runs before any ledger exists and must not fail on its absence.
 */
export function lockedYearsFor(entityId: string): number[] {
    if (!ledgerDbExists()) return [];
    const ledgerEntity = ledgerEntityForWorkspaceEntity(entityId);
    if (!ledgerEntity) return [];
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        const rows = db
            .prepare(`SELECT year FROM periods WHERE entity_id = ? AND status = 'locked' ORDER BY year DESC`)
            .all(ledgerEntity) as Array<{ year: number }>;
        return rows.map((r) => Number(r.year)).filter(Number.isFinite);
    } finally {
        db.close();
    }
}

/**
 * Refuse to un-list an entity whose books are final. The same rule `ledgerRemoveAccount` enforces
 * for a single account, one level up: an entity that carries a locked period must stay resolvable,
 * or the filed year loses the name it was filed under.
 */
function assertEntityRemovable(entity: ManifestEntity): void {
    const years = lockedYearsFor(entity.id);
    if (years.length > 0) {
        throw new Error(
            `Entität „${entity.id}" hat festgeschriebene Jahre (${years.join(', ')}) — Entfernen ist gesperrt (GoBD). ` +
                'Festgeschriebene Bücher müssen der Entität zugeordnet bleiben, unter der sie abgegeben wurden.',
        );
    }
}

/**
 * Create the very first manifest with one entity — the action behind `config init` and the last
 * step of the first-run assistant. Refuses to overwrite an existing configuration.
 */
export function initWorkspace(entity: NewEntityInput, path: string = getManifestPath()): Manifest {
    return initManifest(path, entity);
}

/** Add another entity to an existing manifest. */
export function addEntity(entity: NewEntityInput, path: string = getManifestPath()): Manifest {
    return createManifestEntity(path, entity);
}

/** Change an entity's id / name / kind / account globs. */
export function updateEntity(id: string, patch: EntityPatch, path: string = getManifestPath()): Manifest {
    return renameManifestEntity(path, id, patch);
}

/**
 * Remove an entity from the registry, guarded by the GoBD lock. The entity's DATA is kept — this
 * un-lists it, it does not erase transactions, receipts or filings.
 */
export function removeEntity(id: string, path: string = getManifestPath()): Manifest {
    return removeManifestEntity(path, id, assertEntityRemovable);
}

/** Whether this installation has been set up yet — the question the app asks on launch. */
export function isFirstRun(path: string = getManifestPath()): boolean {
    return !manifestExists(path);
}

export type { EntityPatch, NewEntityInput };

/** Result of {@link assignAccount}: the manifest, plus who still sees the account through a glob. */
export interface AssignAccountResult {
    manifest: Manifest;
    /** Other entities whose glob (`camt:*`) still matches the key — it now counts for them too. */
    sharedWith: Array<{ id: string; name: string }>;
}

/**
 * Refuse to take `keys` away from an entity with festgeschriebene years: its filed books were
 * computed from those accounts, and moving one would silently change a return that was submitted.
 */
export function assertAccountsMovable(keys: string[], targetId: string, manifest: Manifest): void {
    for (const e of manifest.entities) {
        if (e.id === targetId || !keys.some((k) => e.accounts.includes(k))) continue;
        const years = lockedYearsFor(e.id);
        if (years.length > 0) {
            throw new Error(
                `Das Konto gehört zu „${e.name}" mit festgeschriebenen Jahren (${years.join(', ')}) — ` +
                    'Umziehen ist gesperrt (GoBD).',
            );
        }
    }
}

/**
 * Route one account to `entityId` — the last step of adding a bank account. An exact key held by
 * another entity moves (unless its books are locked); a glob held by another entity keeps matching
 * and is reported back, because silently narrowing someone's rule is not ours to do.
 */
export function assignAccount(key: string, entityId: string, path: string = getManifestPath()): AssignAccountResult {
    const before = loadManifest(path);
    const target = before.entities.find((e) => e.id === entityId);
    if (!target) throw new Error(`Entität „${entityId}" nicht gefunden.`);
    assertAccountsMovable([key], target.id, before);
    const manifest = assignManifestAccount(path, key, target.id);
    const sharedWith = manifest.entities
        .filter((e) => e.id !== target.id && matchAccount(key, e.accounts))
        .map((e) => ({ id: e.id, name: e.name }));
    return { manifest, sharedWith };
}
