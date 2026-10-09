/**
 * Barrel for the I/O-free manifest section schemas. Each section reuses the corresponding loader's
 * existing Zod schema (formgleich) — see the individual modules.
 */

export { AppSectionSchema, AppSettingsSchema, type AppSection } from './app-settings.ts';
export { ElsterSectionSchema, ElsterConfigRawSchema, type ElsterSection } from './elster.ts';
export { EstSectionSchema, EstConfigRawSchema, type EstSection } from './est.ts';
export {
    FinanzierungSectionSchema,
    type FinanzierungAngebot,
    type FinanzierungBedarf,
    type FinanzierungConfig,
    type FinanzierungHaushalt,
    type FinanzierungUnterlage,
    type FinanzierungUnterlageStatus,
} from './finanzierung.ts';
export { MailAccountSchema, MailTemplateSchema, type MailAccountConfig, type MailTemplate } from './mail.ts';
export { PaperlessSectionSchema, SyncConfigLenientSchema, type PaperlessSection } from './paperless.ts';
export { FinTSSectionSchema, FinTSConfigSchema, type FinTSSection } from './fints.ts';
export {
    RecurringSectionSchema,
    RecurringEntrySchema,
    type RecurringSection,
    type RecurringEntry,
} from './recurring.ts';
export {
    ProjectSchema,
    ProjectSectionSchema,
    findProjectLinkErrors,
    projectLinkError,
    type Project,
    type ProjectContactPerson,
    type ProjectSection,
} from './project.ts';
export { ManifestEntitySchema, type ManifestEntity } from './entity.ts';
export { ManifestSchema, MANIFEST_VERSION, type Manifest } from './manifest.ts';
