/**
 * ERiC (ELSTER) data — the thin seam the native Konten view calls instead of the core ERiC status
 * action + config writer directly. It binds the status probe / path persist to the ACTIVE entity's
 * ELSTER config path, so the view stays about widgets and never threads the path itself.
 *
 * `eric_home` is stored per-entity today (the entity's `elster_config`); entities without an ELSTER
 * config fall back to the cwd/env default config. See the follow-up on eric_home scope: ERiC is one
 * install per machine, so a workspace-/env-level home may fit better later.
 */

import { getEricStatus, type EricStatus } from '../../../core/actions/elster/eric-status.ts';
import {
    saveEricHome as coreSaveEricHome,
    saveKeystorePath as coreSaveKeystorePath,
    saveElsterSubmitter as coreSaveElsterSubmitter,
} from '../../../core/config/index.ts';
import type { ElsterConfig } from '../../../core/config/index.ts';
import type { AppEntity } from '../entities.ts';

export type { EricStatus };

// The ELSTER certificate PIN lives in the OS keyring (never in config) — re-exported here so the
// Konten card (cert path) and the Absenden section (test send) share one ELSTER-credentials seam.
export { keyringAvailable, lookupElsterPin, storeElsterPin, clearElsterPin } from './elster-secret.ts';

/** ERiC status enriched with the explicitly configured `eric_home` (for the editable path row). */
export interface EricStatusView extends EricStatus {
    /** The `eric_home` currently stored in the entity's ELSTER config, if any (empty = env/default). */
    configuredHome?: string;
}

/** Require an active entity for a config WRITE — the writers address the entity by its id. */
function requireEntityId(entity: AppEntity | null): string {
    if (!entity) throw new Error('Keine aktive Entität ausgewählt.');
    return entity.id;
}

/**
 * Probe ERiC for the active entity: read its configured `eric_home`, then run the core status action
 * against it. An entity without an ELSTER config is tolerated (probe env/default only).
 */
export async function loadEricStatus(entity: AppEntity | null): Promise<EricStatusView> {
    const configuredHome = entity?.elster?.eric_home;
    const status = await getEricStatus(configuredHome);
    return { ...status, configuredHome };
}

/** Persist the ERiC home path into the active entity's ELSTER config (blank clears it). */
export function saveEricHome(entity: AppEntity | null, ericHome: string): ElsterConfig {
    return coreSaveEricHome(requireEntityId(entity), ericHome);
}

/**
 * Read the ELSTER certificate path (`keystore_path`) configured for the active entity, if any. An
 * entity without an ELSTER config is tolerated (returns undefined). The path is NOT secret (a file
 * location); the matching PIN lives only in the OS keyring.
 */
export function loadKeystorePath(entity: AppEntity | null): string | undefined {
    return entity?.elster?.keystore_path;
}

/** Persist the ELSTER certificate path into the active entity's ELSTER config (blank clears it). */
export function saveKeystore(entity: AppEntity | null, keystorePath: string): ElsterConfig {
    return coreSaveKeystorePath(requireEntityId(entity), keystorePath);
}

/** The ELSTER submitter identity (Hersteller-ID + DatenLieferant) configured for the active entity. */
export interface SubmitterIds {
    herstellerId?: string;
    datenlieferant?: string;
}

/** Read the submitter identity for the active entity (tolerates a missing ELSTER config). */
export function loadSubmitter(entity: AppEntity | null): SubmitterIds {
    const cfg = entity?.elster;
    return { herstellerId: cfg?.hersteller_id, datenlieferant: cfg?.datenlieferant };
}

/** Persist the submitter identity into the active entity's ELSTER config (blank clears a field). */
export function saveSubmitter(entity: AppEntity | null, ids: SubmitterIds): ElsterConfig {
    return coreSaveElsterSubmitter(requireEntityId(entity), ids);
}
