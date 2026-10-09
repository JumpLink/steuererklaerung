/**
 * Einstellungen data — the thin data-module seam the native Einstellungen view calls instead of the
 * core config writers directly. It binds each save/load to the ACTIVE entity's id, so the view stays
 * about widgets and never repeats the entity threading. Every read/write goes through the consolidated
 * steuererklaerung.json manifest (per-entity inline `elster`/`est`), synchronous.
 */

import {
    saveElsterTaxNumber,
    loadAppSettings,
    saveAppSettings,
    loadEntityDms,
    saveEntityDms,
    loadEntityInvoicing,
    saveEntityInvoicing,
    manifestRevision,
} from '../../../core/config/index.ts';
import type {
    AppSettings,
    EntityDmsView,
    EntityInvoicingView,
    IssuerConfig,
    MailAccountConfig,
    MailTemplate,
} from '../../../core/config/index.ts';
import {
    updateEstPerson,
    upsertEstJahr,
    mutateEstConfig,
    resolveEntityEst,
    estJahr,
    type EstConfig,
    type EstJahr,
} from '../../../core/config/index.ts';
import {
    saveElsterBetrieb,
    saveElsterUste,
    saveElsterFlags,
    mutateElsterConfig,
    type ElsterBetrieb,
    type ElsterConfig,
} from '../../../core/config/index.ts';
import type { AppEntity } from '../entities.ts';

export { MCP_GROUPS } from '../../../core/config/index.ts';
/**
 * The manifest's current on-disk state, for the Einstellungen staleness guard. The view fills its
 * widgets once and later writes whole blocks back from them, so it must be able to notice that the
 * CLI, the resident MCP server or a second window moved the file underneath it.
 */
export { manifestRevision };
export type {
    AppSettings,
    McpGroup,
    EntityDmsView,
    EntityInvoicingView,
    IssuerConfig,
} from '../../../core/config/index.ts';
export { estJahr };
export type { EstConfig, EstJahr, ElsterBetrieb, ElsterConfig };
export type { ElsterAnlagegut, ElsterPrivatanteil, ElsterSonderbetriebsausgabe } from '../../../core/config/index.ts';

// ── App settings (global — assistant + MCP), persisted to steuererklaerung.json ────────────────────────

/** Read the current settings (assistant + MCP) from the manifest, or defaults if absent. */
export function loadSettings(): AppSettings {
    return loadAppSettings();
}

/** Persist the settings into steuererklaerung.json (throws if no manifest exists). */
export function saveSettings(settings: AppSettings): void {
    saveAppSettings(settings);
}

// ── Per-entity ELSTER config (business entities) ──────────────────────────────────────────────────

/** Load the active entity's inline ELSTER config (from the workspace model). */
export function loadElster(entity: AppEntity): ElsterConfig {
    if (!entity.elster) throw new Error(`Entität „${entity.id}" hat keine ELSTER-Config.`);
    return entity.elster;
}

/** Persist the whole Betrieb (Stammdaten) block into the entity's ELSTER config. */
/** Persist the entity's Steuernummer — the field every filing is keyed by. */
export function saveTaxNumber(entity: AppEntity, taxNumber: string): ElsterConfig {
    return saveElsterTaxNumber(entity.id, taxNumber);
}

export function saveBetrieb(entity: AppEntity, betrieb: ElsterBetrieb): ElsterConfig {
    return saveElsterBetrieb(entity.id, betrieb);
}

/** Persist the USt-Jahreserklärung parameters (Σ prepaid VAT) into the entity's ELSTER config. */
export function saveUste(entity: AppEntity, uste: { prepaid_vat: number }): ElsterConfig {
    return saveElsterUste(entity.id, uste);
}

/** Persist a subset of the top-level filing flags into the entity's ELSTER config. */
export function saveFlags(
    entity: AppEntity,
    flags: Partial<{
        test_mode: boolean;
        taxation_basis: 'ist' | 'soll';
        ust_dauerfristverlaengerung: boolean;
        deadline_extension_months: number;
    }>,
): ElsterConfig {
    return saveElsterFlags(entity.id, flags);
}

/** Read-modify-write the entity's ELSTER config raw JSON (for nested/partial edits). */
export function mutateElster(entity: AppEntity, mutate: (raw: Record<string, unknown>) => void): ElsterConfig {
    return mutateElsterConfig(entity.id, mutate);
}

// ── Per-entity private-ESt config (privat entity) ─────────────────────────────────────────────────

/** Load the active entity's inline private-ESt config (from the workspace model). */
export function loadEst(entity: AppEntity): EstConfig {
    if (!entity.est) throw new Error(`Entität „${entity.id}" hat keine ESt-Config.`);
    return entity.est;
}

/** Re-read the entity's ESt config FRESH from the manifest — to refresh the UI's stale `entity.est`
 *  after an intake write (approve-to-apply), so the ESt views reflect it without a restart. */
export function reloadEst(entity: AppEntity): EstConfig | undefined {
    return resolveEntityEst(entity.id);
}

/** Persist a shallow patch to the ESt `person` block into the entity's ESt config. */
export function saveEstPerson(entity: AppEntity, patch: Partial<EstConfig['person']>): EstConfig {
    return updateEstPerson(entity.id, patch);
}

/** Insert/merge one year's Lohnsteuerbescheinigung row into the entity's ESt config. */
export function saveEstJahr(entity: AppEntity, jahr: number, patch: Partial<EstJahr>): EstConfig {
    return upsertEstJahr(entity.id, jahr, patch);
}

/**
 * Read-modify-write the entity's ESt config raw JSON — used for the NESTED partial edits
 * (`jahre[].vorsorge`, `jahre[].werbungskosten`) that {@link saveEstJahr}'s `Partial<EstJahr>` output
 * type can't express (the normalised nested blocks require all their defaulted fields).
 */
export function mutateEst(entity: AppEntity, mutate: (raw: Record<string, unknown>) => void): EstConfig {
    return mutateEstConfig(entity.id, mutate);
}

// ── Per-entity infra: document management + invoicing (every entity) ──────────────────────────────

/** Read one entity's DMS config (token replaced by a `hasToken` flag). */
export function loadDms(entity: AppEntity): EntityDmsView {
    return loadEntityDms(entity.id);
}

/** Persist one entity's DMS config (token write-only — blank keeps the stored one). */
export function saveDms(
    entity: AppEntity,
    update: { type: 'builtin' | 'paperless'; paperlessUrl?: string; paperlessToken?: string },
): void {
    saveEntityDms(entity.id, update);
}

/** Read one entity's outgoing-invoicing config. */
export function loadInvoicing(entity: AppEntity): EntityInvoicingView {
    return loadEntityInvoicing(entity.id);
}

/** Persist (or, with null, remove) the entity's mail account; the password lives in the keyring. */
export function saveMailAccount(entity: AppEntity, mail: MailAccountConfig | null): void {
    saveEntityInvoicing(entity.id, { type: loadEntityInvoicing(entity.id).type, mail });
}

/** Persist one entity's outgoing-invoicing config (merge-preserving the §14 issuer/prefix it omits). */
export function saveInvoicing(
    entity: AppEntity,
    update: {
        type: 'qonto' | 'self';
        iban?: string;
        paymentTermsDays?: number;
        defaultHeader?: string;
        defaultClosing?: string;
        defaultHeaderSie?: string;
        defaultClosingSie?: string;
        selfNumberPrefix?: string;
        selfIssuer?: IssuerConfig;
        mailTemplates?: MailTemplate[];
        defaultMailTemplate?: string;
    },
): void {
    saveEntityInvoicing(entity.id, update);
}
