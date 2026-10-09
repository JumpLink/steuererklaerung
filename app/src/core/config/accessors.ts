/**
 * Typed readers + raw-preserving writers over the consolidated {@link Manifest}. This is the single
 * config surface the rest of the app uses: every former per-file loader/writer (sync-config,
 * elster-config, est-config, fints-config, recurring-invoices, workspace) is folded in here, addressing
 * an entity by its **id** (never a file path). All writes delegate to the atomic, validate-before-write
 * {@link mutateManifest}, so a bad mutation throws {@link ConfigError} and leaves the file untouched.
 */

import { entityIdAliases } from '@steuererklaerung/store';
import { ConfigError } from '../lib/errors.ts';
import { getManifestPath, loadManifest, mutateManifest } from './manifest.ts';
import { defaultEntityFor, findEntity, requireEntity, resolveEntityAccounts } from './entities.ts';
import type { Manifest, ManifestEntity } from './schema/manifest.ts';
import { type ElsterBetrieb, type ElsterConfig, normalizeElsterConfig } from './schema/elster.ts';
import { type EstConfig, type EstJahr } from './schema/est.ts';
import type { FinanzierungConfig } from './schema/finanzierung.ts';
import { DEFAULT_SYNC_CONFIG, type SyncConfig, SyncConfigStrictSchema } from './schema/paperless.ts';
import type { FinTSAccountConfig, FinTSConfig } from './schema/fints.ts';
import { type AppSettings, defaultAppSettings } from './schema/app-settings.ts';
import type {
    EntityDmsConfig,
    EntityInvoicingConfig,
    HinweisGeprueft,
    IssuerConfig,
    LaufendeKostenEntscheidung,
} from './schema/entity.ts';
import type { MailAccountConfig, MailTemplate } from './schema/mail.ts';
import type { MailEingangConfig } from './schema/mail-eingang.ts';
import type { Project } from './schema/project.ts';
import type { RecurringEntry, RecurringInvoice } from './schema/recurring.ts';

export type { SyncConfig } from './schema/paperless.ts';

/** One manifest entity with its inline sections resolved to the loaders' normalised shapes. */
export interface ResolvedEntity {
    id: string;
    name: string;
    kind: string;
    /** Account-key globs (unexpanded — expand with {@link resolveEntityAccounts}). */
    accounts: string[];
    /** Document-management back-end (default built-in). */
    dms: EntityDmsConfig;
    /** Outgoing-invoice back-end (default Qonto). */
    invoicing: EntityInvoicingConfig;
    /** True for the fictional demo entity. */
    demo?: boolean;
    /** Inline ELSTER config, normalised exactly as the former loadElsterConfig. */
    elster?: ElsterConfig;
    /** Inline private-ESt config (identical to the former loadEstConfig output). */
    est?: EstConfig;
    /** Inline Immobilien-/Sanierungsfinanzierung, when this entity has one. */
    finanzierung?: FinanzierungConfig;
    /** Recurring outgoing invoices for this entity (entityId dropped — implied by the entity). */
    recurring: RecurringEntry[];
}

/** Resolve one manifest entity to its typed sections. `entity` is a parsed {@link ManifestEntity}. */
function resolve(entity: ManifestEntity): ResolvedEntity {
    return {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        accounts: entity.accounts,
        dms: entity.dms ?? { type: 'builtin' },
        invoicing: { ...entity.invoicing, type: resolveInvoicingType(entity.invoicing?.type, entity.accounts) },
        demo: entity.demo,
        elster: entity.elster ? normalizeElsterConfig(entity.elster) : undefined,
        est: entity.est,
        finanzierung: entity.finanzierung,
        recurring: entity.recurring ?? [],
    };
}

/** Resolve the entity named `id` (fail-loud when unknown), with its inline elster/est/recurring. */
export function resolveEntity(manifest: Manifest, id: string): ResolvedEntity {
    return resolve(requireEntity(manifest, id));
}

/** Resolve every entity in the manifest. */
export function resolveEntities(manifest: Manifest): ResolvedEntity[] {
    return manifest.entities.map(resolve);
}

/** A resolved entity with its account globs expanded against the real store keys. */
export interface ResolvedWorkspaceEntity {
    id: string;
    name: string;
    kind: string;
    /** Concrete store account keys this entity owns (after glob expansion). */
    accountKeys: string[];
    dms: EntityDmsConfig;
    invoicing: EntityInvoicingConfig;
    demo?: boolean;
    /** Inline ELSTER config (normalised), if any. */
    elster?: ElsterConfig;
    /** Inline private-ESt config, if any. */
    est?: EstConfig;
    recurring: RecurringEntry[];
}

/**
 * Resolve every manifest entity, expanding its account globs against `storeKeys`. Replaces the former
 * `resolveWorkspace` — there is no single-config synthesised-default fallback anymore (a manifest is
 * always required; {@link loadManifest} fails loud with the migrate hint when it is absent).
 */
export function resolveWorkspaceEntities(
    storeKeys: string[],
    manifest: Manifest = loadManifest(),
): ResolvedWorkspaceEntity[] {
    return manifest.entities.map((e) => {
        const r = resolve(e);
        return {
            id: r.id,
            name: r.name,
            kind: r.kind,
            accountKeys: resolveEntityAccounts(e, storeKeys),
            dms: r.dms,
            invoicing: r.invoicing,
            demo: r.demo,
            elster: r.elster,
            est: r.est,
            recurring: r.recurring,
        };
    });
}

// ── Global sections ─────────────────────────────────────────────────────────────────────────────

/** App settings (assistant + MCP), or the built-in defaults when the manifest omits `app`. */
export function readApp(manifest: Manifest): AppSettings {
    return manifest.app ?? defaultAppSettings();
}

/** The global Paperless sync config, or undefined when the manifest has no `paperless` section. */
export function readPaperless(manifest: Manifest): SyncConfig | undefined {
    return manifest.paperless as SyncConfig | undefined;
}

/** The global FinTS config, or undefined when the manifest has no `fints` section. */
export function readFints(manifest: Manifest): FinTSConfig | undefined {
    return manifest.fints;
}

export interface LoadSyncConfigOptions {
    /** When false, allow document_type_ids to be 0 (for setup). Default: true. */
    strict?: boolean;
}

/**
 * Load the global Paperless sync config from the manifest's `paperless` section. FAIL-LOUD when the
 * section is absent. In strict mode (default) document_type_ids must be positive (the setup guard the
 * former loadPaperlessConfig applied); pass `{ strict: false }` for the setup flow.
 */
export function loadPaperlessConfig(options?: LoadSyncConfigOptions, path = getManifestPath()): SyncConfig {
    const paperless = readPaperless(loadManifest(path));
    if (!paperless) {
        throw new ConfigError(
            `steuererklaerung.json hat keinen „paperless"-Abschnitt. Richte Paperless in der Konfiguration ein.`,
            path,
        );
    }
    if (options?.strict === false) return paperless;
    const result = SyncConfigStrictSchema.safeParse(paperless);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Ungültiger Paperless-Abschnitt in steuererklaerung.json:\n${issues}`, path);
    }
    return result.data as SyncConfig;
}

/**
 * The global FinTS config from the manifest's `fints` section. FAIL-LOUD when absent (mirrors the
 * former loadFinTSConfig). Bank accounts here, the PIN in the environment (FINTS_PIN_<name>).
 */
export function loadFinTSConfig(path = getManifestPath()): FinTSConfig {
    const fints = readFints(loadManifest(path));
    if (!fints) {
        throw new ConfigError(
            `steuererklaerung.json hat keinen „fints"-Abschnitt. Konfiguriere die FinTS-Bankzugänge.`,
            path,
        );
    }
    return fints;
}

/** Insert or update one FinTS account in the manifest's `fints.accounts` (creating the section). */
export function upsertFinTSAccount(account: FinTSAccountConfig, path = getManifestPath()): void {
    mutateManifest(path, (raw) => {
        const fints = (raw.fints as { accounts?: FinTSAccountConfig[] } | undefined) ?? {};
        const accounts = Array.isArray(fints.accounts) ? fints.accounts : [];
        const i = accounts.findIndex((a) => a.name === account.name);
        if (i >= 0) accounts[i] = { ...accounts[i], ...account };
        else accounts.push(account);
        raw.fints = { ...fints, accounts };
    });
}

/** The default (business) entity's normalised ELSTER config, or undefined when none is configured. */
export function resolveDefaultElster(path = getManifestPath()): ElsterConfig | undefined {
    const manifest = loadManifest(path);
    try {
        const entity = defaultEntityFor(manifest);
        return entity.elster ? normalizeElsterConfig(entity.elster) : undefined;
    } catch {
        return undefined;
    }
}

/** One entity's normalised ELSTER config by id, or undefined when the entity / its config is absent. */
export function resolveEntityElster(entityId: string, path = getManifestPath()): ElsterConfig | undefined {
    try {
        const entity = findEntity(loadManifest(path), entityId);
        return entity?.elster ? normalizeElsterConfig(entity.elster) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * One entity's inline private-ESt config by id, re-read FRESH from the manifest (not a snapshot) —
 * used after an intake write (approve-to-apply) to refresh the UI's stale `entity.est` so the ESt
 * views reflect the change without a restart. Undefined when the entity / its `est` section is absent.
 */
export function resolveEntityEst(entityId: string, path = getManifestPath()): EstConfig | undefined {
    try {
        return findEntity(loadManifest(path), entityId)?.est;
    } catch {
        return undefined;
    }
}

/**
 * One entity's inline financing config by id, re-read FRESH from the manifest. Undefined when the
 * entity has no `finanzierung` section — which is the normal case for every business entity; only
 * the private household carries one.
 */
export function resolveEntityFinanzierung(entityId: string, path = getManifestPath()): FinanzierungConfig | undefined {
    try {
        return findEntity(loadManifest(path), entityId)?.finanzierung;
    } catch {
        return undefined;
    }
}

/**
 * Merge `updates` into the manifest's `paperless` section (preserving every unmentioned key), then
 * write atomically. Replaces the former writeSyncConfig; used by `paperless setup-fields`.
 */
export function writeSyncConfig(updates: Partial<SyncConfig>, path = getManifestPath()): void {
    mutateManifest(path, (raw) => {
        const existing = (raw.paperless as SyncConfig | undefined) ?? DEFAULT_SYNC_CONFIG;
        const merged: SyncConfig = {
            document_type_ids: { ...existing.document_type_ids, ...updates.document_type_ids },
            custom_field_ids: { ...existing.custom_field_ids, ...updates.custom_field_ids },
            tag_ids: { ...existing.tag_ids, ...updates.tag_ids },
            own_correspondent_ids: updates.own_correspondent_ids ?? existing.own_correspondent_ids,
            exclude_tag_ids: updates.exclude_tag_ids ?? existing.exclude_tag_ids,
            preferred_language: updates.preferred_language ?? existing.preferred_language,
            invoice_providers: updates.invoice_providers ?? existing.invoice_providers,
            select_field_options: {
                sale_type: { ...existing.select_field_options?.sale_type, ...updates.select_field_options?.sale_type },
                tax_rate: { ...existing.select_field_options?.tax_rate, ...updates.select_field_options?.tax_rate },
                supplier_country: {
                    ...existing.select_field_options?.supplier_country,
                    ...updates.select_field_options?.supplier_country,
                },
                accounting_category: {
                    ...existing.select_field_options?.accounting_category,
                    ...updates.select_field_options?.accounting_category,
                },
                payment_status: {
                    ...existing.select_field_options?.payment_status,
                    ...updates.select_field_options?.payment_status,
                },
                ai_confidence: {
                    ...existing.select_field_options?.ai_confidence,
                    ...updates.select_field_options?.ai_confidence,
                },
                data_scope: {
                    ...existing.select_field_options?.data_scope,
                    ...updates.select_field_options?.data_scope,
                },
            },
        };
        raw.paperless = merged;
    });
}

// ── App settings (assistant + MCP) ────────────────────────────────────────────────────────────────

/** Read the app settings (assistant + MCP) from the manifest, or defaults if the section is absent. */
export function loadAppSettings(path = getManifestPath()): AppSettings {
    return readApp(loadManifest(path));
}

/** Persist the app settings into the manifest's `app` section (preserving all other keys). */
export function saveAppSettings(settings: AppSettings, path = getManifestPath()): void {
    mutateManifest(path, (raw) => {
        raw.app = {
            assistant: settings.assistant,
            mcp: settings.mcp,
            lernmodus: settings.lernmodus,
            sync: settings.sync,
        };
    });
}

// ── Per-entity raw mutation helper ────────────────────────────────────────────────────────────────

/**
 * Raw-preserving, atomic per-entity write: resolve the entity by id (alias-aware, fail-loud), find its
 * raw object and hand it to `mutate`. Delegates to {@link mutateManifest} (validate-before-write).
 */
export function writeManifestEntity(
    path: string,
    id: string,
    mutate: (rawEntity: Record<string, unknown>) => void,
): Manifest {
    const aliases = new Set(entityIdAliases(id));
    return mutateManifest(path, (raw) => {
        const entities = raw.entities as Array<Record<string, unknown>> | undefined;
        const rawEntity = entities?.find((e) => e.id === id || aliases.has(String(e.id)));
        if (!rawEntity) {
            const known = entities?.map((e) => String(e.id)).join(', ') || '(keine)';
            throw new Error(`Entität „${id}" nicht im Manifest gefunden. Bekannte Entitäten: ${known}.`);
        }
        mutate(rawEntity);
    });
}

/** Mutate one entity's raw `elster` section (must exist), then return the normalised {@link ElsterConfig}. */
function mutateEntityElster(
    entityId: string,
    path: string | undefined,
    mutate: (rawElster: Record<string, unknown>) => void,
): ElsterConfig {
    const p = path ?? getManifestPath();
    const target = requireEntity(loadManifest(p), entityId);
    writeManifestEntity(p, target.id, (rawEntity) => {
        const sec = rawEntity.elster as Record<string, unknown> | undefined;
        if (!sec) throw new ConfigError(`Entität „${target.id}" hat keinen ELSTER-Abschnitt (elster).`, p);
        mutate(sec);
    });
    const elster = resolveEntity(loadManifest(p), target.id).elster;
    if (!elster) throw new ConfigError(`Entität „${target.id}" hat keinen ELSTER-Abschnitt (elster).`, p);
    return elster;
}

/** Mutate one entity's raw `est` section (must exist), then return the validated {@link EstConfig}. */
function mutateEntityEst(
    entityId: string,
    path: string | undefined,
    mutate: (rawEst: Record<string, unknown>) => void,
): EstConfig {
    const p = path ?? getManifestPath();
    const target = requireEntity(loadManifest(p), entityId);
    writeManifestEntity(p, target.id, (rawEntity) => {
        const sec = rawEntity.est as Record<string, unknown> | undefined;
        if (!sec) throw new ConfigError(`Entität „${target.id}" hat keinen ESt-Abschnitt (est).`, p);
        mutate(sec);
    });
    const est = resolveEntity(loadManifest(p), target.id).est;
    if (!est) throw new ConfigError(`Entität „${target.id}" hat keinen ESt-Abschnitt (est).`, p);
    return est;
}

// ── Per-entity ELSTER writers (entity-id based) ───────────────────────────────────────────────────

/**
 * Create an entity's `elster` section when it has none, so the tax fields become writable at all.
 *
 * Every ELSTER writer here (`saveElsterBetrieb`, `saveElsterUste`, `mutateElsterConfig`, …) requires
 * the section to exist and throws otherwise — which is correct for an entity that was migrated from
 * an old config, and a dead end for one the user just created. `initManifest` writes only identity
 * fields, so a brand-new business entity had NO route to a Steuernummer from any surface: the setup
 * assistant, the Einstellungen view and the CLI all hit the same wall.
 *
 * Idempotent: an existing section is returned untouched. The seed is the schema minimum — a period,
 * which `ElsterPeriodSchema` requires to carry a quarter or a month — defaulted to Q1 of the given
 * year. Everything else takes its schema default.
 */
export function ensureElsterSection(entityId: string, opts: { year?: number } = {}, path?: string): ElsterConfig {
    const p = path ?? getManifestPath();
    const target = requireEntity(loadManifest(p), entityId);
    const year = opts.year ?? new Date().getFullYear();
    writeManifestEntity(p, target.id, (rawEntity) => {
        if (rawEntity.elster) return;
        rawEntity.elster = { entity_id: target.id, period: { year, quarter: 1 } };
    });
    const elster = resolveEntity(loadManifest(p), target.id).elster;
    if (!elster) throw new ConfigError(`ELSTER-Abschnitt für „${target.id}" konnte nicht angelegt werden.`, p);
    return elster;
}

/**
 * Persist the Steuernummer — the single most load-bearing field of a business entity, and one with
 * no writer and no surface until now (a grep for `tax_number` across the whole desktop tree found
 * nothing). Creates the section if the entity has none.
 */
export function saveElsterTaxNumber(entityId: string, taxNumber: string, path?: string): ElsterConfig {
    ensureElsterSection(entityId, {}, path);
    return mutateEntityElster(entityId, path, (raw) => {
        raw.tax_number = taxNumber.trim();
    });
}

/** Read-modify-write one entity's raw `elster` section (for nested/partial edits). */
export function mutateElsterConfig(
    entityId: string,
    mutate: (raw: Record<string, unknown>) => void,
    path?: string,
): ElsterConfig {
    return mutateEntityElster(entityId, path, mutate);
}

type RawRecord = Record<string, unknown>;

/** The `adjustments.<key>` array of a raw `elster` section, created empty when missing. */
function rawAdjustmentList(raw: RawRecord, key: string): RawRecord[] {
    const adj = (raw.adjustments ??= {}) as RawRecord;
    return (adj[key] ??= []) as RawRecord[];
}

/**
 * Record a double payment (a customer paid an invoice twice / too much). Upserts by transaction id,
 * keeping an already linked refund. Creates the elster section when the entity has none.
 */
export function saveDoppelzahlung(
    entityId: string,
    entry: { transaktion_id: string; bezeichnung?: string; rechnung_id?: string },
    path?: string,
): ElsterConfig {
    ensureElsterSection(entityId, {}, path);
    return mutateEntityElster(entityId, path, (raw) => {
        const list = rawAdjustmentList(raw, 'doppelzahlungen');
        const cur = list.find((d) => d.transaktion_id === entry.transaktion_id);
        const next: RawRecord = { ...cur, transaktion_id: entry.transaktion_id };
        next.bezeichnung = entry.bezeichnung ?? (cur?.bezeichnung as string | undefined) ?? '';
        if (entry.rechnung_id) next.rechnung_id = entry.rechnung_id;
        if (cur) list[list.indexOf(cur)] = next;
        else list.push(next);
    });
}

/** Link the refund debit to a recorded double payment. Throws when the double payment is unknown. */
export function saveDoppelzahlungRueckzahlung(
    entityId: string,
    transaktionId: string,
    rueckzahlungTransaktionId: string,
    path?: string,
): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        const cur = rawAdjustmentList(raw, 'doppelzahlungen').find((d) => d.transaktion_id === transaktionId);
        if (!cur)
            throw new ConfigError(`Doppelzahlung „${transaktionId}" ist nicht erfasst.`, path ?? getManifestPath());
        cur.rueckzahlung_transaktion_id = rueckzahlungTransaktionId;
    });
}

/** Record that the customer was refunded outside the entity's accounts on `datum` (ISO date). */
export function saveDoppelzahlungRueckzahlungExtern(
    entityId: string,
    transaktionId: string,
    datum: string,
    path?: string,
): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        const cur = rawAdjustmentList(raw, 'doppelzahlungen').find((d) => d.transaktion_id === transaktionId);
        if (!cur)
            throw new ConfigError(`Doppelzahlung „${transaktionId}" ist nicht erfasst.`, path ?? getManifestPath());
        cur.rueckzahlung_am = datum;
    });
}

/** Record that the owner looked at a credit and decided it is no double payment. Upserts by tx id. */
export function saveZahlungGeprueft(
    entityId: string,
    entry: { transaktion_id: string; entscheidung: 'in_ordnung' | 'andere_rechnung'; rechnung_id?: string },
    path?: string,
): ElsterConfig {
    ensureElsterSection(entityId, {}, path);
    return mutateEntityElster(entityId, path, (raw) => {
        const list = rawAdjustmentList(raw, 'zahlungen_geprueft');
        const next: RawRecord = { transaktion_id: entry.transaktion_id, entscheidung: entry.entscheidung };
        if (entry.rechnung_id) next.rechnung_id = entry.rechnung_id;
        const i = list.findIndex((d) => d.transaktion_id === entry.transaktion_id);
        if (i >= 0) list[i] = next;
        else list.push(next);
    });
}

/** Persist the USt-Jahreserklärung parameters (Σ prepaid VAT) into the entity's `elster` section. */
export function saveElsterUste(entityId: string, uste: { prepaid_vat: number }, path?: string): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        raw.uste = { ...(raw.uste as Record<string, unknown> | undefined), ...uste };
    });
}

/** Persist the business-identification block (Anlage-EÜR / declaration header) into `elster`. */
export function saveElsterBetrieb(entityId: string, betrieb: ElsterBetrieb, path?: string): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        raw.betrieb = { ...(raw.betrieb as Record<string, unknown> | undefined), ...betrieb };
    });
}

/** Persist a subset of the top-level filing flags into the entity's `elster` section. */
export function saveElsterFlags(
    entityId: string,
    flags: Partial<{
        test_mode: boolean;
        taxation_basis: 'ist' | 'soll';
        ust_dauerfristverlaengerung: boolean;
        deadline_extension_months: number;
    }>,
    path?: string,
): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        if (flags.test_mode !== undefined) raw.test_mode = flags.test_mode;
        if (flags.taxation_basis !== undefined) raw.taxation_basis = flags.taxation_basis;
        if (flags.ust_dauerfristverlaengerung !== undefined)
            raw.ust_dauerfristverlaengerung = flags.ust_dauerfristverlaengerung;
        if (flags.deadline_extension_months !== undefined)
            raw.deadline_extension_months = flags.deadline_extension_months;
    });
}

/** Persist the ERiC runtime location (`eric_home`); a blank value REMOVES the key. */
export function saveEricHome(entityId: string, ericHome: string, path?: string): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        const trimmed = ericHome.trim();
        if (trimmed) raw.eric_home = trimmed;
        else delete raw.eric_home;
    });
}

/** Persist the ELSTER certificate path (`keystore_path`); a blank value REMOVES the key. Never a PIN. */
export function saveKeystorePath(entityId: string, keystorePath: string, path?: string): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        const trimmed = keystorePath.trim();
        if (trimmed) raw.keystore_path = trimmed;
        else delete raw.keystore_path;
    });
}

/** Persist the ELSTER submitter identity (`hersteller_id` + `datenlieferant`); blank clears each. */
export function saveElsterSubmitter(
    entityId: string,
    ids: { herstellerId?: string; datenlieferant?: string },
    path?: string,
): ElsterConfig {
    return mutateEntityElster(entityId, path, (raw) => {
        if (ids.herstellerId !== undefined) {
            const t = ids.herstellerId.trim();
            if (t) raw.hersteller_id = t;
            else delete raw.hersteller_id;
        }
        if (ids.datenlieferant !== undefined) {
            const t = ids.datenlieferant.trim();
            if (t) raw.datenlieferant = t;
            else delete raw.datenlieferant;
        }
    });
}

// ── Per-entity private-ESt writers (entity-id based) ──────────────────────────────────────────────

/** Read-modify-write one entity's raw `est` section (for nested partial edits). */
export function mutateEstConfig(
    entityId: string,
    mutate: (raw: Record<string, unknown>) => void,
    path?: string,
): EstConfig {
    return mutateEntityEst(entityId, path, mutate);
}

/** Persist a shallow patch to the ESt `person` block into the entity's `est` section. */
export function updateEstPerson(entityId: string, patch: Partial<EstConfig['person']>, path?: string): EstConfig {
    return mutateEntityEst(entityId, path, (raw) => {
        const person = (raw.person as Record<string, unknown> | undefined) ?? {};
        raw.person = { ...person, ...patch };
    });
}

/**
 * Insert or update one year's Lohnsteuerbescheinigung row in the entity's `est` section. Existing
 * years merge (nested `vorsorge`/`werbungskosten` deep-merged); a new year is appended. `jahr` wins.
 */
export function upsertEstJahr(entityId: string, jahr: number, patch: Partial<EstJahr>, path?: string): EstConfig {
    return mutateEntityEst(entityId, path, (raw) => {
        const jahre = Array.isArray(raw.jahre) ? (raw.jahre as Array<Record<string, unknown>>) : [];
        raw.jahre = jahre;
        const idx = jahre.findIndex((j) => j.jahr === jahr);
        if (idx === -1) {
            jahre.push({ jahr, ...patch });
            return;
        }
        const existing = jahre[idx];
        const merged: Record<string, unknown> = { ...existing, ...patch, jahr };
        if (patch.vorsorge !== undefined) {
            merged.vorsorge = { ...(existing.vorsorge as Record<string, unknown> | undefined), ...patch.vorsorge };
        }
        if (patch.werbungskosten !== undefined) {
            merged.werbungskosten = {
                ...(existing.werbungskosten as Record<string, unknown> | undefined),
                ...patch.werbungskosten,
            };
        }
        jahre[idx] = merged;
    });
}

// ── Per-entity DMS + invoicing (client-safe views + writers) ──────────────────────────────────────

/** Client-safe DMS view for one entity — the token is replaced by a `hasToken` flag. */
export interface EntityDmsView {
    type: 'builtin' | 'paperless';
    paperlessUrl: string | null;
    hasToken: boolean;
}

/** Read one entity's DMS config without ever exposing the Paperless token. */
export function loadEntityDms(entityId: string, path = getManifestPath()): EntityDmsView {
    const dms = findEntity(loadManifest(path), entityId)?.dms;
    return {
        type: dms?.type ?? 'builtin',
        paperlessUrl: dms?.paperless?.url ?? null,
        hasToken: !!dms?.paperless?.token,
    };
}

/**
 * Persist one entity's DMS config. The token is write-only: when the form leaves it blank the
 * previously stored token is kept; switching to built-in clears it.
 */
export function saveEntityDms(
    entityId: string,
    update: { type: 'builtin' | 'paperless'; paperlessUrl?: string; paperlessToken?: string },
    path = getManifestPath(),
): void {
    writeManifestEntity(path, entityId, (entity) => {
        const old = entity.dms as { paperless?: { token?: string }; mailEingang?: unknown } | undefined;
        // The mail folder belongs to the built-in DMS but is kept while Paperless is selected, so
        // switching back does not lose it.
        const mailEingang = old?.mailEingang ? { mailEingang: old.mailEingang } : {};
        if (update.type === 'paperless') {
            const prev = old?.paperless ?? {};
            const paperless: Record<string, string> = {};
            if (update.paperlessUrl) paperless.url = update.paperlessUrl;
            const token = update.paperlessToken || prev.token;
            if (token) paperless.token = token;
            entity.dms = {
                type: 'paperless',
                ...(Object.keys(paperless).length ? { paperless } : {}),
                ...mailEingang,
            };
        } else {
            entity.dms = { type: 'builtin', ...mailEingang };
        }
    });
}

/** The mail folder an entity fetches receipts from (Idee 15), or null when none is configured. */
export function loadMailEingang(entityId: string, path = getManifestPath()): MailEingangConfig | null {
    return findEntity(loadManifest(path), entityId)?.dms?.mailEingang ?? null;
}

/** Persist (or, with null, remove) the entity's mail folder. The password is never part of it. */
export function saveMailEingang(
    entityId: string,
    mailEingang: MailEingangConfig | null,
    path = getManifestPath(),
): void {
    writeManifestEntity(path, entityId, (entity) => {
        const dms = { ...((entity.dms as Record<string, unknown> | undefined) ?? { type: 'builtin' }) };
        if (mailEingang) dms.mailEingang = mailEingang;
        else delete dms.mailEingang;
        entity.dms = dms;
    });
}

/**
 * Whether an account list holds a Qonto account. The Qonto credentials are global (.env, one
 * organisation), so the `qonto:` account is the only per-entity proof that an entity belongs to it.
 */
export function hasQontoAccount(accounts: readonly string[]): boolean {
    return accounts.some((a) => a.startsWith('qonto:'));
}

/** The configured invoicing type, else derived from the accounts: Qonto only with a Qonto account. */
export function resolveInvoicingType(
    configured: 'qonto' | 'self' | undefined,
    accounts: readonly string[],
): 'qonto' | 'self' {
    return configured ?? (hasQontoAccount(accounts) ? 'qonto' : 'self');
}

/** Client-safe invoicing view for one entity (no secrets — the IBAN is the user's own). */
export interface EntityInvoicingView {
    type: 'qonto' | 'self';
    /**
     * Whether the entity owns a `qonto:` account. Always true when no entity is named (CLI/MCP
     * without `--entity` use the global Qonto config). `type: 'qonto'` WITHOUT this is a
     * misconfiguration: nothing may be listed or created through Qonto.
     */
    qontoAccount: boolean;
    iban: string | null;
    paymentTermsDays: number | null;
    /** Default cover-letter template for schedules without their own. */
    defaultHeader: string | null;
    /** Default sign-off (`{gruss}`). */
    defaultClosing: string | null;
    /** Sie variants of the two above. */
    defaultHeaderSie: string | null;
    defaultClosingSie: string | null;
    selfNumberPrefix: string | null;
    /** Aussteller identity for the self provider (null when unconfigured). */
    selfIssuer: IssuerConfig | null;
    /** SMTP account for invoice mail (null when unconfigured; the password is in the keyring). */
    mail: MailAccountConfig | null;
    /** Named invoice-mail templates (empty = built-in text only). */
    mailTemplates: MailTemplate[];
    /** Id of the entity's default template, or null. */
    defaultMailTemplate: string | null;
}

/** Read one entity's invoicing config. Without an explicit type it follows the entity's accounts. */
export function loadEntityInvoicing(entityId: string, path = getManifestPath()): EntityInvoicingView {
    const entity = findEntity(loadManifest(path), entityId);
    const inv = entity?.invoicing;
    return {
        // No entity (CLI default config): the global Qonto setup, as before.
        type: entity ? resolveInvoicingType(inv?.type, entity.accounts) : 'qonto',
        qontoAccount: entity ? hasQontoAccount(entity.accounts) : true,
        iban: inv?.iban ?? null,
        paymentTermsDays: inv?.paymentTermsDays ?? null,
        defaultHeader: inv?.defaultHeader ?? null,
        defaultClosing: inv?.defaultClosing ?? null,
        defaultHeaderSie: inv?.defaultHeaderSie ?? null,
        defaultClosingSie: inv?.defaultClosingSie ?? null,
        selfNumberPrefix: inv?.self?.numberPrefix ?? null,
        selfIssuer: inv?.self?.issuer ?? null,
        mail: inv?.mail ?? null,
        mailTemplates: inv?.mailTemplates ?? [],
        defaultMailTemplate: inv?.defaultMailTemplate ?? null,
    };
}

/**
 * Persist one entity's invoicing config, MERGE-PRESERVING the existing block: only fields explicitly
 * present in `update` are changed, everything else (esp. the §14 issuer identity + number prefix the
 * settings UI does not send) is kept. A field is "provided" iff its key is not `undefined`; pass an
 * empty string to clear it.
 */
export function saveEntityInvoicing(
    entityId: string,
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
        /** The mail account; `null` removes it. The password is never part of it. */
        mail?: MailAccountConfig | null;
        /** The named mail templates (replaced as a whole); empty removes them. */
        mailTemplates?: MailTemplate[];
        /** Id of the default template; empty removes it. */
        defaultMailTemplate?: string;
    },
    path = getManifestPath(),
): void {
    writeManifestEntity(path, entityId, (entity) => {
        const prev = (entity.invoicing as Record<string, unknown> | undefined) ?? {};
        const invoicing: Record<string, unknown> = { ...prev, type: update.type };
        if (update.iban !== undefined) {
            const iban = update.iban.replace(/\s+/g, '');
            if (iban) invoicing.iban = iban;
            else delete invoicing.iban;
        }
        if (update.paymentTermsDays !== undefined) {
            if (update.paymentTermsDays) invoicing.paymentTermsDays = update.paymentTermsDays;
            else delete invoicing.paymentTermsDays;
        }
        for (const key of ['defaultHeader', 'defaultClosing', 'defaultHeaderSie', 'defaultClosingSie'] as const) {
            const value = update[key];
            if (value === undefined) continue;
            if (value.trim()) invoicing[key] = value;
            else delete invoicing[key];
        }
        if (update.mail !== undefined) {
            if (update.mail) invoicing.mail = update.mail;
            else delete invoicing.mail;
        }
        if (update.mailTemplates !== undefined) {
            if (update.mailTemplates.length) invoicing.mailTemplates = update.mailTemplates;
            else delete invoicing.mailTemplates;
        }
        if (update.defaultMailTemplate !== undefined) {
            if (update.defaultMailTemplate) invoicing.defaultMailTemplate = update.defaultMailTemplate;
            else delete invoicing.defaultMailTemplate;
        }
        const self: Record<string, unknown> = { ...(prev.self as Record<string, unknown> | undefined) };
        if (update.selfNumberPrefix !== undefined) {
            if (update.selfNumberPrefix) self.numberPrefix = update.selfNumberPrefix;
            else delete self.numberPrefix;
        }
        if (update.selfIssuer !== undefined) {
            const issuer = pruneEmpty(update.selfIssuer as Record<string, unknown>);
            if (Object.keys(issuer).length) self.issuer = issuer;
            else delete self.issuer;
        }
        if (Object.keys(self).length) invoicing.self = self;
        else delete invoicing.self;
        entity.invoicing = invoicing;
    });
}

/** Drop undefined/null/"" entries (recursively for one nested `bank` object). */
function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v == null || v === '') continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
            const nested = pruneEmpty(v as Record<string, unknown>);
            if (Object.keys(nested).length) out[k] = nested;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ── Recurring outgoing invoices (flattened across entities, re-attaching entityId) ────────────────

/**
 * Load every entity's recurring invoices as a FLAT list, re-attaching each schedule's owning entity
 * id (the manifest stores them per entity without the redundant `entityId`). Empty when none exist.
 */
export function loadRecurringInvoices(path = getManifestPath()): RecurringInvoice[] {
    const manifest = loadManifest(path);
    const out: RecurringInvoice[] = [];
    for (const entity of manifest.entities) {
        for (const entry of entity.recurring ?? []) {
            out.push({ ...entry, entityId: entity.id });
        }
    }
    return out;
}

/** Find one recurring schedule by id (across all entities), or throw a clear error. */
export function getRecurringInvoice(id: string, path = getManifestPath()): RecurringInvoice {
    const found = loadRecurringInvoices(path).find((i) => i.id === id);
    if (!found) throw new ConfigError(`Wiederkehrende Rechnung „${id}" nicht gefunden.`, path);
    return found;
}

/**
 * Persist a full flat list back into the manifest, RE-GROUPED per entity (the `entityId` is dropped
 * again — it is implied by the entity the schedule lives under). Every listed entity's `recurring`
 * array is rewritten; entities that currently have a `recurring` key but no schedules in the list get
 * an empty array (so a removed schedule is really removed). Used to advance a schedule after issuance.
 */
export function saveRecurringInvoices(invoices: RecurringInvoice[], path = getManifestPath()): void {
    const byEntity = new Map<string, RecurringEntry[]>();
    for (const inv of invoices) {
        const { entityId, ...entry } = inv;
        const list = byEntity.get(entityId) ?? [];
        list.push(entry);
        byEntity.set(entityId, list);
    }
    mutateManifest(path, (raw) => {
        const entities = (raw.entities as Array<Record<string, unknown>> | undefined) ?? [];
        for (const entity of entities) {
            const id = String(entity.id);
            const group = byEntity.get(id);
            if (group?.length) entity.recurring = group;
            else if ('recurring' in entity) entity.recurring = [];
        }
    });
}

// ── Projects (per entity) ─────────────────────────────────────────────────────────────────────────

/** An entity's projects, in manifest order; empty when it has none. Fails loudly on an unknown entity. */
export function loadProjects(entityId: string, path = getManifestPath()): Project[] {
    return requireEntity(loadManifest(path), entityId).projects ?? [];
}

/**
 * Replace an entity's whole project list. Re-validated against the manifest schema before it is
 * written, so a list that leaves a recurring invoice pointing at a missing project is refused.
 */
export function saveProjects(entityId: string, projects: Project[], path = getManifestPath()): void {
    const target = requireEntity(loadManifest(path), entityId);
    writeManifestEntity(path, target.id, (rawEntity) => {
        if (projects.length) rawEntity.projects = projects;
        else delete rawEntity.projects;
    });
}

// ── Hinweise marked „in Ordnung" (per entity) ────────────────────────────────────────────────────

/** The entity's dismissed Hinweise; empty when none. Fails loudly on an unknown entity. */
export function loadHinweiseGeprueft(entityId: string, path = getManifestPath()): HinweisGeprueft[] {
    return requireEntity(loadManifest(path), entityId).hinweise_geprueft ?? [];
}

/** Record one dismissal; upserts by hint key + year, so a newer fingerprint replaces the old one. */
export function saveHinweisGeprueft(entityId: string, entry: HinweisGeprueft, path = getManifestPath()): void {
    const target = requireEntity(loadManifest(path), entityId);
    writeManifestEntity(path, target.id, (rawEntity) => {
        const list = ((rawEntity.hinweise_geprueft as RawRecord[] | undefined) ?? []).filter(
            (d) => !(d.hinweis === entry.hinweis && d.jahr === entry.jahr),
        );
        list.push({ ...entry });
        rawEntity.hinweise_geprueft = list;
    });
}

// ── Laufende Kosten decisions (per entity) ───────────────────────────────────────────────────────

/** The entity's decisions on laufende Kosten; empty when none. Fails loudly on an unknown entity. */
export function loadLaufendeKostenEntscheidungen(
    entityId: string,
    path = getManifestPath(),
): LaufendeKostenEntscheidung[] {
    return requireEntity(loadManifest(path), entityId).laufende_kosten ?? [];
}

/** Record one decision, upserting by series key; `null` removes it (back to a proposal). */
export function saveLaufendeKostenEntscheidung(
    entityId: string,
    key: string,
    entry: LaufendeKostenEntscheidung | null,
    path = getManifestPath(),
): void {
    const target = requireEntity(loadManifest(path), entityId);
    writeManifestEntity(path, target.id, (rawEntity) => {
        const list = ((rawEntity.laufende_kosten as RawRecord[] | undefined) ?? []).filter((d) => d.key !== key);
        if (entry) list.push({ ...entry });
        if (list.length) rawEntity.laufende_kosten = list;
        else delete rawEntity.laufende_kosten;
    });
}

/** Deep-copy a value while redacting any secret-looking key (token/secret/pin/password/key). */
export function redactSecrets<T>(value: T): T {
    const SECRET = /token|secret|pin|password|passwort|apikey|api_key/i;
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                out[k] = SECRET.test(k) && val != null && val !== '' ? '***redacted***' : walk(val);
            }
            return out;
        }
        return v;
    };
    return walk(value) as T;
}

export { findEntity, requireEntity };
