/**
 * One-time assembly of the consolidated `steuererklaerung.json` **version 1** manifest from the 7 legacy
 * config files: the registry file (entities + assistant/mcp), the global `sync-config.json`
 * and `fints-config.json`, each entity's `elster_config`/`est_config` satellite file, and the grouped
 * `recurring-invoices.json`.
 *
 * DATA-SAFETY GUARANTEE: this NEVER modifies or deletes any SOURCE config file. It only READS them and
 * writes exactly two things — the new manifest (atomically, under the SAME filename it read) and a
 * `<name>.bak-<ts>` backup of the previous registry. `bmf-umrechnungskurse.json` (data) and `.env` (secrets) stay separate.
 *
 * The backup timestamp is INJECTED (`now`) rather than read from the clock, so migrations are
 * deterministic and testable. Ambiguous orphan-file mappings ABORT before anything is written.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entityIdAliases } from '@steuererklaerung/store';
import { ConfigError } from '../lib/errors.ts';
import { MANIFEST_FILENAME, isManifest, writeManifestAtomic } from './manifest.ts';
import { MANIFEST_VERSION, ManifestSchema } from './schema/manifest.ts';

/**
 * Default registry filename. The caller passes the name that {@link getManifestPath} actually
 * resolved instead — under the rename fallback that is still `buchhaltung.json`, and a migration
 * must read and rewrite THAT file, not create a second one beside it.
 */
const REGISTRY_FILE = MANIFEST_FILENAME;
const SYNC_FILE = 'sync-config.json';
const FINTS_FILE = 'fints-config.json';
const RECURRING_FILE = 'recurring-invoices.json';

/** What moved into one entity during the migration (source filenames + recurring count). */
export interface EntityMigrationSummary {
    id: string;
    /** Source elster satellite filename inlined into `entity.elster`, or null. */
    elster: string | null;
    /** Source est satellite filename inlined into `entity.est`, or null. */
    est: string | null;
    /** Number of recurring invoices grouped into `entity.recurring`. */
    recurring: number;
}

/** A human-readable summary of what the migration moved where (for the CLI print). */
export interface MigrationMapping {
    /** Source file folded into top-level `paperless`, or null. */
    paperless: string | null;
    /** Source file folded into top-level `fints`, or null. */
    fints: string | null;
    /** Whether an `app` section (assistant/mcp) was produced. */
    app: boolean;
    entities: EntityMigrationSummary[];
    /** Total recurring invoices distributed across the entities. */
    recurringTotal: number;
}

export interface AssembledManifest {
    /** The assembled raw manifest object (with preserved comments/unknown keys), ready to write. */
    manifest: Record<string, unknown>;
    mapping: MigrationMapping;
    warnings: string[];
}

export interface MigrateOptions {
    /** Directory holding the registry + the satellite config files. */
    dir: string;
    /** Deterministic timestamp for the `<registryFile>.bak-<now>` backup filename. */
    now: string;
    /** Assemble + report but write NOTHING. */
    dryRun?: boolean;
    /** Registry filename inside `dir` (default {@link MANIFEST_FILENAME}; legacy installs pass the old name). */
    registryFile?: string;
}

export interface MigrateResult {
    manifestPath: string;
    /** True when the registry was ALREADY a v1 manifest (idempotency gate → no backup, no write). */
    alreadyV1: boolean;
    dryRun: boolean;
    /** True iff a new manifest was written (false for dry-run and already-v1). */
    wrote: boolean;
    /** Path of the `.bak-<now>` backup written before overwriting, or null. */
    backupPath: string | null;
    /** The assembled (or existing, when already-v1) manifest object. */
    manifest: Record<string, unknown>;
    /** What moved where, or null when already-v1. */
    mapping: MigrationMapping | null;
    warnings: string[];
}

function readJsonFile(path: string): Record<string, unknown> {
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch (err) {
        const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
        throw new ConfigError(
            isNotFound
                ? `Konfigurationsdatei nicht gefunden: ${path}`
                : `Konfigurationsdatei konnte nicht gelesen werden (${path}): ${err instanceof Error ? err.message : String(err)}`,
            path,
        );
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
        throw new ConfigError(`Ungültiges JSON in ${path}: ${err instanceof Error ? err.message : err}`, path);
    }
}

function readOptionalJsonFile(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return readJsonFile(path);
}

/** Structural deep clone via JSON (config payloads are pure JSON — `//`-comment keys survive). */
function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Find a raw registry entity by id OR ledger/workspace alias (gbr↔artcode, privat↔private). */
function findRawEntity(entities: Array<Record<string, unknown>>, id: string): Record<string, unknown> | undefined {
    const aliases = new Set(entityIdAliases(id));
    return entities.find((e) => String(e.id) === id || aliases.has(String(e.id)));
}

/** List satellite config files matching `pattern`, excluding `.example.` templates + already-referenced files. */
function scanOrphans(dir: string, pattern: RegExp, referenced: Set<string>): string[] {
    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return [];
    }
    return files.filter((f) => pattern.test(f) && !f.includes('.example.') && !referenced.has(f));
}

/**
 * Map orphan satellite files (not referenced by any entity's path field) to entities WITHOUT that
 * section, by naming convention: `elster-config-<id-or-alias>.json` → that entity, a bare
 * `elster-config.json` → the sole default/soleprop (est: privat) entity. On ANY ambiguity — one file
 * matching several entities, or one entity matching several files — this THROWS (abort, write nothing).
 * Files that match no entity produce a warning and are left untouched on disk.
 */
function matchOrphans(
    files: string[],
    entities: Array<Record<string, unknown>>,
    kind: 'elster' | 'est',
    warnings: string[],
): Map<string, string> {
    const bare = `${kind}-config.json`;
    const suffixRe = kind === 'elster' ? /^elster-config-(.+)\.json$/ : /^est-config-(.+)\.json$/;
    const defaultKinds = kind === 'elster' ? new Set(['einzelunternehmen', 'soleprop']) : new Set(['privat']);
    const pathKey = `${kind}_config`;
    const eligible = entities.filter((e) => typeof e[pathKey] !== 'string');

    const fileToEntities = new Map<string, string[]>();
    const entityToFiles = new Map<string, string[]>();
    for (const f of files) {
        const m = suffixRe.exec(f);
        const isBare = f === bare;
        const matched: string[] = [];
        for (const e of eligible) {
            const id = String(e.id);
            const hit = m ? entityIdAliases(id).includes(m[1]) : isBare && defaultKinds.has(String(e.kind));
            if (hit) {
                matched.push(id);
                entityToFiles.set(id, [...(entityToFiles.get(id) ?? []), f]);
            }
        }
        fileToEntities.set(f, matched);
    }
    for (const [f, ents] of fileToEntities) {
        if (ents.length > 1)
            throw new ConfigError(
                `Mehrdeutige Zuordnung: die Datei „${f}" passt auf mehrere Entitäten (${ents.join(', ')}). Migration abgebrochen — nichts geschrieben.`,
            );
    }
    for (const [id, fs] of entityToFiles) {
        if (fs.length > 1)
            throw new ConfigError(
                `Mehrdeutige Zuordnung: Entität „${id}" passt auf mehrere Config-Dateien (${fs.join(', ')}). Migration abgebrochen — nichts geschrieben.`,
            );
    }
    const assign = new Map<string, string>();
    for (const [f, ents] of fileToEntities) {
        if (ents.length === 1) assign.set(ents[0], f);
        else if (ents.length === 0)
            warnings.push(
                `Config-Datei „${f}" konnte keiner Entität zugeordnet werden — sie bleibt unverändert liegen (nicht migriert).`,
            );
    }
    return assign;
}

/**
 * Assemble the consolidated manifest object from the legacy files in `dir` WITHOUT writing anything.
 * Throws {@link ConfigError} on a missing referenced satellite, an unknown recurring entityId, an
 * ambiguous orphan mapping, or an invalid assembled result. Throws if the registry is already v1.
 */
export function assembleManifest(dir: string, registryFile: string = REGISTRY_FILE): AssembledManifest {
    const registryPath = join(dir, registryFile);
    const registry = readJsonFile(registryPath);
    if (isManifest(registry)) {
        throw new ConfigError(
            `${registryFile} unter ${registryPath} ist bereits ein v${MANIFEST_VERSION}-Manifest.`,
            registryPath,
        );
    }
    const rawEntities = Array.isArray(registry.entities) ? (registry.entities as Array<Record<string, unknown>>) : [];
    if (rawEntities.length === 0) {
        throw new ConfigError(`${registryFile} enthält keine „entities" — nichts zu migrieren.`, registryPath);
    }
    const warnings: string[] = [];

    // ── global sections ──
    const paperless = readOptionalJsonFile(join(dir, SYNC_FILE));
    const fints = readOptionalJsonFile(join(dir, FINTS_FILE));
    const recurringFile = readOptionalJsonFile(join(dir, RECURRING_FILE));

    // ── recurring: group by entityId (the standalone entityId then disappears) ──
    const recurringByEntity = new Map<string, Array<Record<string, unknown>>>();
    let recurringTotal = 0;
    if (recurringFile) {
        const invoices = Array.isArray(recurringFile.invoices)
            ? (recurringFile.invoices as Array<Record<string, unknown>>)
            : [];
        for (const inv of invoices) {
            const entityId = typeof inv.entityId === 'string' && inv.entityId ? inv.entityId : 'jumplink';
            const entity = findRawEntity(rawEntities, entityId);
            if (!entity) {
                throw new ConfigError(
                    `recurring-invoices.json: Eintrag „${String(inv.id ?? '?')}" verweist auf unbekannte Entität „${entityId}". Migration abgebrochen — nichts geschrieben.`,
                );
            }
            const entry = deepClone(inv);
            delete entry.entityId;
            const list = recurringByEntity.get(String(entity.id)) ?? [];
            list.push(entry);
            recurringByEntity.set(String(entity.id), list);
            recurringTotal++;
        }
    }

    // ── elster/est: primary path fields, then orphan convention for the rest ──
    const referenced = new Set<string>();
    for (const e of rawEntities) {
        if (typeof e.elster_config === 'string') referenced.add(e.elster_config);
        if (typeof e.est_config === 'string') referenced.add(e.est_config);
    }
    const assignElster = matchOrphans(
        scanOrphans(dir, /^elster-config.*\.json$/, referenced),
        rawEntities,
        'elster',
        warnings,
    );
    const assignEst = matchOrphans(scanOrphans(dir, /^est-config.*\.json$/, referenced), rawEntities, 'est', warnings);

    // ── assemble the per-entity objects (inline sections replace the path fields) ──
    const entitySummaries: EntityMigrationSummary[] = [];
    const assembledEntities = rawEntities.map((rawEntity) => {
        const e = deepClone(rawEntity);
        const id = String(e.id);
        const summary: EntityMigrationSummary = { id, elster: null, est: null, recurring: 0 };

        const elsterFile = (typeof e.elster_config === 'string' ? e.elster_config : undefined) ?? assignElster.get(id);
        delete e.elster_config;
        if (elsterFile) {
            e.elster = readJsonFile(join(dir, elsterFile));
            summary.elster = elsterFile;
        }

        const estFile = (typeof e.est_config === 'string' ? e.est_config : undefined) ?? assignEst.get(id);
        delete e.est_config;
        if (estFile) {
            e.est = readJsonFile(join(dir, estFile));
            summary.est = estFile;
        }

        const rec = recurringByEntity.get(id);
        if (rec?.length) {
            e.recurring = rec;
            summary.recurring = rec.length;
        }
        entitySummaries.push(summary);
        return e;
    });

    // ── top-level manifest (clean key order; preserve `//`-comments + unknown top-level keys) ──
    const handled = new Set(['version', 'app', 'assistant', 'mcp', 'paperless', 'fints', 'entities']);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(registry)) if (k.startsWith('//')) out[k] = v;
    out.version = MANIFEST_VERSION;
    const app: Record<string, unknown> = {};
    if (registry.assistant !== undefined) app.assistant = registry.assistant;
    if (registry.mcp !== undefined) app.mcp = registry.mcp;
    const hasApp = Object.keys(app).length > 0;
    if (hasApp) out.app = app;
    if (paperless) out.paperless = paperless;
    if (fints) out.fints = fints;
    out.entities = assembledEntities;
    for (const [k, v] of Object.entries(registry)) if (!handled.has(k) && !k.startsWith('//')) out[k] = v;

    // ── validate the assembled manifest BEFORE anyone writes it ──
    const result = ManifestSchema.safeParse(out);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Zusammengeführtes ${registryFile} ist ungültig:\n${issues}`, registryPath);
    }

    const mapping: MigrationMapping = {
        paperless: paperless ? SYNC_FILE : null,
        fints: fints ? FINTS_FILE : null,
        app: hasApp,
        entities: entitySummaries,
        recurringTotal,
    };
    return { manifest: out, mapping, warnings };
}

/**
 * Run the migration: idempotency-gate an already-v1 manifest (no backup, no write), otherwise assemble,
 * back up the previous registry to `<registryFile>.bak-<now>`, and atomically write the new
 * manifest. `--dry-run` assembles + reports but writes nothing.
 */
export function migrateConfig(opts: MigrateOptions): MigrateResult {
    const { dir, now, dryRun = false, registryFile = REGISTRY_FILE } = opts;
    const manifestPath = join(dir, registryFile);
    const registry = readJsonFile(manifestPath);

    if (isManifest(registry)) {
        return {
            manifestPath,
            alreadyV1: true,
            dryRun,
            wrote: false,
            backupPath: null,
            manifest: registry,
            mapping: null,
            warnings: [
                `${registryFile} ist bereits ein v${MANIFEST_VERSION}-Manifest — nichts zu tun (kein erneutes Backup).`,
            ],
        };
    }

    const { manifest, mapping, warnings } = assembleManifest(dir, registryFile);
    let backupPath: string | null = null;
    let wrote = false;
    if (!dryRun) {
        backupPath = `${manifestPath}.bak-${now}`;
        copyFileSync(manifestPath, backupPath);
        writeManifestAtomic(manifestPath, manifest);
        wrote = true;
    }
    return { manifestPath, alreadyV1: false, dryRun, wrote, backupPath, manifest, mapping, warnings };
}
