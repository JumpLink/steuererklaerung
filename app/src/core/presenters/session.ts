/**
 * Per-process presenter session — the single object that owns the {@link AppContext}, the resolved
 * {@link WorkspaceModel}, the per-entity ELSTER/ESt config loading, the per-entity DMS provider, and
 * the memoized async EÜR-aggregate / DMS-documents builds.
 *
 * It absorbs three duplicated seams:
 *   - the web server's `makeDmsProvider` + the desktop's `data/dms.ts` `dmsProviderFor` → {@link dms},
 *   - the desktop's `data/euer.ts` `aggregateCache` → {@link aggregate} (+ {@link invalidate}),
 *   - the desktop's `data/documents.ts` `documentsCache` → {@link documents} (+ {@link invalidate}).
 *
 * Pure TS (no gi://, GTK/Adwaita, DOM, Hono, yargs or zod) — it runs on GJS in every frontend. There is
 * ONE long-lived session per frontend process; the memos live for that process's lifetime and are
 * dropped selectively through {@link invalidate} after a write.
 */

import { createAppContext, type AppContext } from '../context.ts';
import type { ElsterConfig } from '../config/index.ts';
import type { EstConfig } from '../config/index.ts';
import { resolveWorkspaceEntities, type EntityDmsConfig } from '../config/index.ts';
import { resolveEntityElster } from '../config/accessors.ts';
import { transactionsSummary } from '../actions/transactions.ts';
import { euerReportByTransactions } from '../actions/elster/euer.ts';
import type { EuerTxAggregate } from '../elster/euer-transactions.ts';
import { type DmsProvider, type DmsDocument } from '@steuererklaerung/dms';
import { dmsProviderForEntity } from '../dms-provider.ts';
import { loadWorkspaceModel, entityOf, type EntityModel, type WorkspaceModel } from './workspace.ts';

/** An entity, by id (resolved against the workspace, falling back to the default) or as a model. */
export type EntityRef = string | EntityModel;

/**
 * One entity-year's DMS documents — the shape both the desktop `data/documents.ts` (docs + kind) and
 * the web year-cache (documents + dmsKind) surface today.
 */
export interface DocumentsModel {
    docs: DmsDocument[];
    dmsKind: 'builtin' | 'paperless';
}

export interface PresenterSession {
    readonly ctx: AppContext;
    readonly workspace: WorkspaceModel;
    /** The entity's ELSTER config (per-entity path), tolerating absence/errors (cached). */
    elster(entity: EntityRef): ElsterConfig | undefined;
    /** The entity's private-ESt config (per-entity path), tolerating absence/errors (cached). */
    est(entity: EntityRef): EstConfig | undefined;
    /** The entity's DMS provider (built-in by default, else Paperless), built once per entity. */
    dms(entity: EntityRef): DmsProvider;
    /** Rebuild one entity's DMS provider from the (re-read) manifest — after a DMS switch in settings. */
    reloadDms(entityId: string): void;
    /** The memoized EÜR aggregate for one entity-year (async; may fetch Paperless). Evicted on failure. */
    aggregate(entity: EntityRef, year: number): Promise<EuerTxAggregate>;
    /** The memoized DMS document list for one entity-year (async; outbound for Paperless). Evicted on failure. */
    documents(entity: EntityRef, year: number): Promise<DocumentsModel>;
    /** Drop the memoized aggregate + documents builds — for one entity-year, one entity, or globally. */
    invalidate(entityId?: string, year?: number): void;
}

/**
 * Build the presenter session: create the AppContext, resolve the workspace model, and set up the
 * empty memo maps. `years` mirrors the web server's `--years` override (forwarded to the probe).
 */
export function createPresenterSession(opts: { years?: number[] } = {}): PresenterSession {
    const ctx = createAppContext();
    const workspace = loadWorkspaceModel({ years: opts.years });

    // Per-entity caches. `undefined` is a valid cached config value (config absent/broken → view
    // hidden), so `.has()` distinguishes "not yet loaded" from "loaded as undefined".
    const elsterCache = new Map<string, ElsterConfig | undefined>();
    const estCache = new Map<string, EstConfig | undefined>();
    const dmsCache = new Map<string, DmsProvider>();
    const aggCache = new Map<string, Promise<EuerTxAggregate>>();
    const docCache = new Map<string, Promise<DocumentsModel>>();

    /** The DMS back-end each entity is configured for (built-in by default; a manifest entity opts in). */
    let dmsConfigById = resolveDmsConfigs();

    function refModel(ref: EntityRef): EntityModel {
        if (typeof ref !== 'string') return ref;
        const e = entityOf(workspace, ref);
        if (!e) throw new Error(`Unbekannte Entität: ${ref}`);
        return e;
    }

    function elster(ref: EntityRef): ElsterConfig | undefined {
        const e = refModel(ref);
        if (elsterCache.has(e.id)) return elsterCache.get(e.id);
        const cfg: ElsterConfig | undefined = e.elster;
        elsterCache.set(e.id, cfg);
        return cfg;
    }

    function est(ref: EntityRef): EstConfig | undefined {
        const e = refModel(ref);
        if (estCache.has(e.id)) return estCache.get(e.id);
        const cfg: EstConfig | undefined = e.est;
        estCache.set(e.id, cfg);
        return cfg;
    }

    function buildDms(entityId: string): DmsProvider {
        return dmsProviderForEntity(entityId, dmsConfigById.get(entityId), ctx.config);
    }

    function dms(ref: EntityRef): DmsProvider {
        const id = refModel(ref).id;
        let provider = dmsCache.get(id);
        if (!provider) {
            provider = buildDms(id);
            dmsCache.set(id, provider);
        }
        return provider;
    }

    function reloadDms(entityId: string): void {
        // Re-read the manifest so a DMS switch in the settings takes effect before the next build.
        dmsConfigById = resolveDmsConfigs();
        dmsCache.delete(entityId);
    }

    function aggregate(ref: EntityRef, year: number): Promise<EuerTxAggregate> {
        const e = refModel(ref);
        const key = `${e.id}:${year}`;
        let cached = aggCache.get(key);
        if (!cached) {
            // The classification rules are re-read from the manifest on every build: „Als Regel
            // merken", „Regel aus Auswahl" and the settings write them while this session lives, and
            // the snapshot in `elster(e)` would keep classifying with the old ones until a restart.
            const cfg = elster(e);
            const fresh = cfg ? resolveEntityElster(e.id)?.klassifizierung : undefined;
            cached = euerReportByTransactions(ctx.config, year, {
                detail: true,
                elster: cfg && fresh ? { ...cfg, klassifizierung: fresh } : cfg,
                accountKeys: e.accountKeys,
            }).catch((err) => {
                aggCache.delete(key); // never cache a rejection — a retry rebuilds
                throw err;
            });
            aggCache.set(key, cached);
        }
        return cached;
    }

    function documents(ref: EntityRef, year: number): Promise<DocumentsModel> {
        const e = refModel(ref);
        const key = `${e.id}:${year}`;
        let cached = docCache.get(key);
        if (!cached) {
            const provider = dms(e);
            cached = provider
                .list({ from: `${year}-01-01`, to: `${year}-12-31` })
                .then((docs) => ({ docs, dmsKind: provider.kind }))
                .catch((err) => {
                    docCache.delete(key); // never cache a rejection — a retry rebuilds
                    throw err;
                });
            docCache.set(key, cached);
        }
        return cached;
    }

    function invalidate(entityId?: string, year?: number): void {
        // The config snapshot goes too: a write such as „Wirtschaftsgut erfassen" updates the entity's
        // in-memory `elster`, and a cached copy would keep the next aggregate on the old Anlageverzeichnis.
        if (entityId == null) {
            aggCache.clear();
            docCache.clear();
            elsterCache.clear();
            estCache.clear();
            return;
        }
        elsterCache.delete(entityId);
        estCache.delete(entityId);
        const exact = year != null ? `${entityId}:${year}` : null;
        const prefix = `${entityId}:`;
        for (const map of [aggCache, docCache]) {
            for (const key of map.keys()) {
                if (exact ? key === exact : key.startsWith(prefix)) map.delete(key);
            }
        }
    }

    return { ctx, workspace, elster, est, dms, reloadDms, aggregate, documents, invalidate };
}

/**
 * The resolved per-entity DMS back-end config, via {@link resolveWorkspaceEntities} (the same resolver
 * both frontends use). Read once at construction and again on {@link PresenterSession.reloadDms}.
 */
function resolveDmsConfigs(): Map<string, EntityDmsConfig> {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const resolved = resolveWorkspaceEntities(storeKeys);
    return new Map(resolved.map((e) => [e.id, e.dms]));
}
