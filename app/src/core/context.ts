/**
 * Application context for dependency injection.
 * Loads the consolidated `steuererklaerung.json` manifest ONCE at startup and creates service clients.
 * Actions receive the context instead of reading process.env / re-loading configs directly.
 *
 * Post config-consolidation: there are no per-file config env overrides anymore. Everything comes
 * from the one manifest (`ctx.manifest`); `ctx.config` is its `paperless` section (kept under the
 * historical name so the ~40 existing SyncConfig call sites are unchanged), and the ELSTER / FinTS
 * configs come from the manifest too (per-entity `elster`, global `fints`).
 */

import type { Manifest } from './config/schema/manifest.ts';
import { loadManifest } from './config/manifest.ts';
import { readApp, readFints, readPaperless } from './config/accessors.ts';
import type { SyncConfig } from './config/schema/paperless.ts';
import { DEFAULT_SYNC_CONFIG } from './config/schema/paperless.ts';
import type { ElsterConfig } from './config/schema/elster.ts';
import { normalizeElsterConfig } from './config/schema/elster.ts';
import type { FinTSConfig } from './config/schema/fints.ts';
import { defaultEntityFor } from './config/entities.ts';
import type { AppSettings } from './config/schema/app-settings.ts';
import type { Logger } from './lib/logger.ts';
import { getLogger } from './lib/logger.ts';

/**
 * Central application context that holds configuration and provides access to services.
 * Pass this to action functions instead of having them read process.env directly.
 */
export interface AppContext {
    /** The whole consolidated manifest (entities + global paperless/fints + app settings). */
    readonly manifest: Manifest;
    /** Global Paperless sync config (the manifest's `paperless` section) — historical field name. */
    readonly config: SyncConfig;
    /** App settings (assistant + MCP) from the manifest. */
    readonly app: AppSettings;
    /** Default entity's ELSTER config, when one is present (for the single-config command paths). */
    readonly elsterConfig?: ElsterConfig;
    /** Global FinTS config, when present. */
    readonly fintsConfig?: FinTSConfig;
    /** Get a named logger instance. */
    logger(name: string): Logger;
}

export interface CreateAppContextOptions {
    /** Whether to resolve the default entity's ELSTER config into `ctx.elsterConfig`. Default: false. */
    loadElster?: boolean;
    /** Whether to expose the global FinTS config as `ctx.fintsConfig`. Default: false. */
    loadFinTS?: boolean;
}

/**
 * Create an AppContext from the consolidated manifest.
 * Call this once at command startup and pass to action functions.
 */
export function createAppContext(options?: CreateAppContextOptions): AppContext {
    const manifest = loadManifest();
    const config = readPaperless(manifest) ?? DEFAULT_SYNC_CONFIG;
    const app = readApp(manifest);
    const elsterConfig = options?.loadElster ? defaultEntityElster(manifest) : undefined;
    const fintsConfig = options?.loadFinTS ? readFints(manifest) : undefined;

    return {
        manifest,
        config,
        app,
        elsterConfig,
        fintsConfig,
        logger: getLogger,
    };
}

/** The default (business) entity's normalised ELSTER config, or undefined when none is configured. */
function defaultEntityElster(manifest: Manifest): ElsterConfig | undefined {
    try {
        const entity = defaultEntityFor(manifest);
        return entity.elster ? normalizeElsterConfig(entity.elster) : undefined;
    } catch {
        return undefined;
    }
}
