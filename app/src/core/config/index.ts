/**
 * Public config surface — the consolidated `steuererklaerung.json` v1 manifest is the single source of
 * truth. Schemas + inferred types live under ./schema, the manifest loader/writer in ./manifest,
 * entity lookups in ./entities, and the typed readers + entity-id writers in ./accessors.
 */

// ── Manifest loader / writer ──────────────────────────────────────────────────────────────────────
export {
    loadManifest,
    mutateManifest,
    writeManifestAtomic,
    isManifest,
    getManifestPath,
    manifestRevision,
} from './manifest.ts';

// ── Manifest lifecycle (create / add / rename / remove) ──────────────────────────────────────────
export {
    initManifest,
    createManifestEntity,
    renameManifestEntity,
    removeManifestEntity,
    assignManifestAccount,
    manifestExists,
    slugFromName,
    type NewEntityInput,
    type EntityPatch,
    type RemovalGuard,
} from './lifecycle.ts';

// ── Entity lookups + account helpers ────────────────────────────────────────────────────────────────
export {
    requireEntity,
    findEntity,
    defaultEntityFor,
    matchAccount,
    resolveEntityAccounts,
    defaultAccountScope,
} from './entities.ts';

// ── Typed readers + entity-id writers ───────────────────────────────────────────────────────────────
export {
    resolveEntity,
    resolveEntities,
    resolveWorkspaceEntities,
    readApp,
    readPaperless,
    readFints,
    loadPaperlessConfig,
    loadFinTSConfig,
    upsertFinTSAccount,
    resolveDefaultElster,
    resolveEntityElster,
    resolveEntityEst,
    writeSyncConfig,
    loadAppSettings,
    saveAppSettings,
    writeManifestEntity,
    saveEntityCountry,
    mutateElsterConfig,
    saveDoppelzahlung,
    saveDoppelzahlungRueckzahlung,
    saveDoppelzahlungRueckzahlungExtern,
    saveZahlungGeprueft,
    ensureElsterSection,
    saveElsterTaxNumber,
    saveElsterUste,
    saveElsterBetrieb,
    saveElsterFlags,
    saveEricHome,
    saveKeystorePath,
    saveElsterSubmitter,
    mutateEstConfig,
    updateEstPerson,
    upsertEstJahr,
    loadEntityDms,
    saveEntityDms,
    loadMailEingang,
    saveMailEingang,
    loadEntityInvoicing,
    hasQontoAccount,
    resolveInvoicingType,
    saveEntityInvoicing,
    loadRecurringInvoices,
    getRecurringInvoice,
    saveRecurringInvoices,
    loadProjects,
    saveProjects,
    loadHinweiseGeprueft,
    saveHinweisGeprueft,
    loadLaufendeKostenEntscheidungen,
    saveLaufendeKostenEntscheidung,
    redactSecrets,
    type ResolvedEntity,
    type ResolvedWorkspaceEntity,
    type LoadSyncConfigOptions,
    type EntityDmsView,
    type EntityInvoicingView,
} from './accessors.ts';
export { isAssistantEnabled } from './assistant-preference.ts';

// ── Migration (config migrate) ──────────────────────────────────────────────────────────────────────
export {
    migrateConfig,
    assembleManifest,
    type MigrateOptions,
    type MigrateResult,
    type MigrationMapping,
    type EntityMigrationSummary,
    type AssembledManifest,
} from './migrate.ts';

// ── Section schemas + inferred types ────────────────────────────────────────────────────────────────
export {
    ManifestSchema,
    MANIFEST_VERSION,
    ManifestEntitySchema,
    type Manifest,
    type ManifestEntity,
} from './schema/index.ts';
export {
    SyncConfigStrictSchema,
    SyncConfigLenientSchema,
    PaperlessSectionSchema,
    DEFAULT_SYNC_CONFIG,
    type SyncConfig,
    type PreferredLanguage,
} from './schema/paperless.ts';
export {
    ElsterConfigRawSchema,
    ElsterSectionSchema,
    normalizeElsterConfig,
    getPeriodDateRange,
    type ElsterConfig,
    type ElsterPeriod,
    type ElsterGesellschafter,
    type ElsterGewerbe,
    type ElsterUste,
    type ElsterBetrieb,
    type ElsterAnlagegut,
    type ElsterPrivatanteil,
    type ElsterSonderbetriebsausgabe,
    type ElsterBetriebsaufgabe,
    type ElsterNachtraeglicherPosten,
    type ElsterAdjustments,
    type ElsterKlassifizierung,
    type ElsterKlassifizierungProjektRegel,
    type ElsterKlassifizierungRegel,
} from './schema/elster.ts';
export {
    EstConfigRawSchema,
    EstSectionSchema,
    estJahr,
    estKindJahr,
    type EstConfig,
    type EstJahr,
    type EstKind,
    type EstKindJahr,
} from './schema/est.ts';
export {
    FinTSConfigSchema,
    FinTSSectionSchema,
    getPin,
    getDataDir,
    getDataFilePath,
    getAccountConfig,
    type FinTSConfig,
    type FinTSAccountConfig,
} from './schema/fints.ts';
export {
    RecurringInvoiceSchema,
    RecurringEntrySchema,
    RecurringSectionSchema,
    dueDateOf,
    type RecurringInvoice,
    type RecurringEntry,
    type RecurringItem,
    type InvoicePeriod,
    type LastInvoice,
} from './schema/recurring.ts';
export {
    ProjectSchema,
    ProjectSectionSchema,
    findProjectLinkErrors,
    projectLinkError,
    type Project,
    type ProjectContactPerson,
} from './schema/project.ts';
export type { MailAccountConfig, MailTemplate } from './schema/mail.ts';
export { MailEingangSchema, type MailEingangConfig } from './schema/mail-eingang.ts';
export {
    ManifestEntitySchema as EntitySchema,
    type EntityDmsConfig,
    type EntityInvoicingConfig,
    type HinweisGeprueft,
    type LaufendeKostenEntscheidung,
    type IssuerConfig,
    TAX_MODULES,
    type TaxModuleId,
} from './schema/entity.ts';
export { countryOf, taxModuleOf, defaultTaxModuleFor, DEFAULT_COUNTRY, type CountryFields } from './country.ts';
export {
    MCP_GROUPS,
    AppSettingsSchema,
    parseAppSettings,
    defaultAppSettings,
    type McpGroup,
    type AppSettings,
    type AssistantSettings,
    type McpSettings,
    type SyncSettings,
} from './schema/app-settings.ts';
