/**
 * Loader + raw-preserving writer for the consolidated `steuererklaerung.json` **version 1** manifest.
 *
 * This is the FOUNDATION of the config consolidation: the schema/loader/writer exist and are covered
 * by tests, but nothing switches to the manifest yet — the legacy loaders (sync-config, elster-config,
 * est-config, fints-config, recurring-invoices, workspace) stay in place and keep working. A later
 * step flips the readers over. See ./schema/manifest.ts for the shape and ./migrate.ts for the
 * one-time assembly from the 7 legacy files.
 *
 * The writer mirrors elster-config.ts's `mutateElsterConfig` pattern: mutate the RAW parsed object
 * (so `//`-comment keys + unknown/future keys survive), re-validate BEFORE writing, and write
 * atomically (tmp file + rename) so a crash mid-write can never leave a truncated manifest.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ConfigError, ManifestMissingError } from '../lib/errors.ts';
import {
    ManifestTooNewError,
    manifestVersionOf,
    migrateManifestForward,
    notifyBeforeMigrationWrite,
} from './migrate-forward.ts';
import { type Manifest, MANIFEST_VERSION, ManifestSchema } from './schema/manifest.ts';

export const MANIFEST_FILENAME = 'steuererklaerung.json';

/**
 * The pre-rename filename. The project was called `buchhaltung` until the rename to
 * `steuererklaerung`; an installation that predates it has its ONLY copy of the entity registry,
 * Steuernummern, account bindings and recurring invoices under this name. It is read as a fallback
 * FOREVER — see {@link getManifestPath}.
 */
export const LEGACY_MANIFEST_FILENAME = 'buchhaltung.json';

/** Hint appended to every "not migrated yet" error so the user knows the exact next step. */
const MIGRATE_HINT =
    'Führe „steuer config migrate" aus, um die Alt-Configs zu einem steuererklaerung.json v1 zusammenzuführen.';

/**
 * Emit `notice` to stderr exactly once per process, keyed by `key`.
 *
 * stderr, not stdout: the MCP server speaks its protocol on stdout and most read commands print
 * JSON there — a notice on stdout would corrupt both. Once per process because the path is
 * resolved on nearly every config read.
 */
const noticed = new Set<string>();
function noticeOnce(key: string, notice: string): void {
    if (noticed.has(key)) return;
    noticed.add(key);
    console.error(notice);
}

/** Test seam: forget which notices were already printed (a process-lifetime cache otherwise). */
export function resetConfigNotices(): void {
    noticed.clear();
}

/**
 * The manifest path, resolved in this order:
 *
 *   1. `STEUER_WORKSPACE`            — explicit override (demo workspace, tests, MCP registration)
 *   2. `BUCHHALTUNG_WORKSPACE`       — the pre-rename name of (1), honoured with a notice
 *   3. `<cwd>/steuererklaerung.json` — the current default, when it exists
 *   4. `<cwd>/buchhaltung.json`      — the pre-rename default, when it exists, with a notice
 *   5. `<cwd>/steuererklaerung.json` — the default path to report as missing
 *
 * Steps 2 and 4 are the RENAME FALLBACK: an installation that predates the rename keeps working
 * untouched, and says so. We deliberately do not move or rewrite the file — it is the user's only
 * copy of their tax master data, its location is `cwd`-relative (so the "right" directory depends
 * on which of CLI / MCP / web / app was started and from where), and a read costs nothing. The
 * notice names both paths and the one command that adopts the new name.
 *
 * `cwd` is a test seam only — production callers pass nothing.
 */
export function getManifestPath(cwd: string = process.cwd()): string {
    const override = process.env.STEUER_WORKSPACE;
    if (override) return override;

    const legacyOverride = process.env.BUCHHALTUNG_WORKSPACE;
    if (legacyOverride) {
        noticeOnce(
            'env',
            `Hinweis: BUCHHALTUNG_WORKSPACE ist gesetzt (${legacyOverride}). Die Variable heißt jetzt STEUER_WORKSPACE; ` +
                'die alte wird weiterhin gelesen.',
        );
        return legacyOverride;
    }

    const current = join(cwd, MANIFEST_FILENAME);
    if (existsSync(current)) return current;

    const legacy = join(cwd, LEGACY_MANIFEST_FILENAME);
    if (existsSync(legacy)) {
        noticeOnce(
            'file',
            `Hinweis: Es wird die Konfiguration unter dem alten Namen gelesen: ${legacy}\n` +
                `         Das Projekt heißt jetzt „steuererklaerung"; die Datei heißt künftig ${MANIFEST_FILENAME}.\n` +
                `         Umbenennen mit:  mv ${legacy} ${current}\n` +
                '         Bis dahin ändert sich nichts — die alte Datei wird unverändert weiterverwendet.',
        );
        return legacy;
    }

    return current;
}

/** True iff `raw` is a consolidated v1 manifest (as opposed to a legacy/registry manifest file). */
export function isManifest(raw: unknown): raw is { version: number } {
    return typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === MANIFEST_VERSION;
}

/**
 * Parse a JSON file to a raw object, throwing a clear {@link ConfigError} on read/parse failure.
 * The message names the file that was actually read — which, under the rename fallback, may still
 * be `buchhaltung.json`.
 */
function readRawJson(path: string): Record<string, unknown> {
    const name = basename(path);
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch (err) {
        throw new ConfigError(
            `${name} konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
            path,
        );
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
        throw new ConfigError(`${name} ist kein gültiges JSON: ${err instanceof Error ? err.message : err}`, path);
    }
}

/**
 * Load + validate the consolidated manifest. FAIL-LOUD:
 *  - absent file          → ConfigError with the migrate hint,
 *  - present but no `version` / not v1 (a legacy registry file) → ConfigError with the hint,
 *  - present v1 but invalid → ConfigError listing the schema issues.
 */
export function loadManifest(path = getManifestPath()): Manifest {
    if (!existsSync(path)) {
        // Name BOTH filenames: an installation from before the rename that is started from the
        // wrong directory must not read this as "there is no config", start empty and quietly
        // build a second, parallel data set.
        // A distinct TYPE, because "there is no manifest yet" is the FIRST-RUN condition, not a
        // failure: on a fresh installation it is the normal state, and the remedy is the setup
        // assistant. Only a terminal can act on `steuer config migrate`, so the hint stays in the
        // message for the CLI while a GUI asks `isManifestMissing` and opens the assistant instead.
        throw new ManifestMissingError(
            `Kein Manifest unter ${path} gefunden (gesucht wurde ${MANIFEST_FILENAME}, ersatzweise ` +
                `der alte Name ${LEGACY_MANIFEST_FILENAME}). ${MIGRATE_HINT}`,
            path,
        );
    }
    const raw = readRawJson(path);
    if (!isManifest(raw)) {
        const seen = manifestVersionOf(raw);
        // NEWER than this program: not something to migrate, something to refuse. Reading it as v1
        // and writing back would drop every field this version does not know about — from a file
        // holding someone's tax data.
        if (seen !== null && seen > MANIFEST_VERSION) throw new ManifestTooNewError(seen, path);
        // OLDER but versioned: upgrade it in memory. The caller writes only when it writes anyway,
        // so a read stays a read — a program that rewrites your config just for opening it is one
        // you cannot safely run twice.
        if (seen !== null && seen < MANIFEST_VERSION) {
            const migrated = migrateManifestForward(raw as Record<string, unknown>, path);
            for (const line of migrated.applied) console.error(`[config] ${basename(path)}: ${line}`);
        } else {
            const detail =
                seen === null ? 'ohne „version"-Feld (Alt-Registry-Format)' : `mit „version": ${JSON.stringify(seen)}`;
            throw new ConfigError(
                `${basename(path)} ${detail} ist noch nicht auf das Manifest-Format v${MANIFEST_VERSION} migriert. ${MIGRATE_HINT}`,
                path,
            );
        }
    }
    const result = ManifestSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Ungültiges Manifest unter ${path}:\n${issues}`, path);
    }
    return result.data;
}

/**
 * An opaque token for the manifest's current on-disk state — `mtimeMs:size`, or `null` when the file
 * does not exist.
 *
 * This exists because of a real lost-update path, not a theoretical one. The Einstellungen view
 * fills its widgets from the manifest ONCE, then rebuilds and writes back whole blocks from widget
 * state on every field edit (see `views/einstellungen/betrieb-ust.ts`, which assembles all five
 * required `betrieb` keys). `mutateManifest` re-reading the file does not help there: the stale
 * values are in the widgets, so a `betrieb.ort` changed meanwhile by the CLI or the resident MCP
 * server is silently overwritten the next time someone edits `betrieb.name` in the GUI.
 *
 * A holder of a token can therefore ask "did the file move under me?" before writing. mtime+size is
 * deliberately cheap and deliberately not a hash: it is a staleness hint for a UI, not an integrity
 * guarantee, and a `stat` costs nothing on a path that is read constantly.
 */
export function manifestRevision(path: string = getManifestPath()): string | null {
    try {
        const st = statSync(path);
        return `${st.mtimeMs}:${st.size}`;
    } catch {
        return null;
    }
}

/** Write `raw` to `path` atomically: serialise to a sibling tmp file, then rename over the target. */
export function writeManifestAtomic(path: string, raw: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(tmp, path);
}

/**
 * Read-modify-write the manifest while PRESERVING every key the mutation doesn't touch — the mutation
 * receives the RAW parsed object (not the Zod-normalised {@link Manifest}), so `//`-comment keys and
 * unknown/future keys survive a save. The result is re-validated against {@link ManifestSchema} BEFORE
 * it is written (an invalid mutation throws {@link ConfigError} and leaves the file untouched), and the
 * write is atomic (tmp + rename). Returns the freshly validated {@link Manifest}.
 */
export function mutateManifest(path: string, mutate: (raw: Record<string, unknown>) => void): Manifest {
    if (!existsSync(path)) {
        throw new ManifestMissingError(`Kein Manifest unter ${path} zum Speichern vorhanden. ${MIGRATE_HINT}`, path);
    }
    const raw = readRawJson(path);
    const upgradedFrom = manifestVersionOf(raw);
    if (!isManifest(raw)) {
        const seen = manifestVersionOf(raw);
        // The refusal that matters. Everything else here reports a file this program cannot use;
        // THIS one prevents it from destroying a file it merely does not understand — writing a v1
        // shape over a v2 manifest drops every newer field, and the file holds tax data.
        if (seen !== null && seen > MANIFEST_VERSION) throw new ManifestTooNewError(seen, path);
        // Older: upgrade before mutating, so the write lands on the current shape. This IS the
        // moment to persist it — the file is being rewritten anyway.
        if (seen !== null && seen < MANIFEST_VERSION) {
            const migrated = migrateManifestForward(raw as Record<string, unknown>, path);
            for (const line of migrated.applied) console.error(`[config] ${basename(path)}: ${line}`);
        } else {
            throw new ConfigError(
                `${basename(path)} unter ${path} ist noch kein v${MANIFEST_VERSION}-Manifest. ${MIGRATE_HINT}`,
                path,
            );
        }
    }
    mutate(raw);
    const result = ManifestSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Ungültige Manifest-Mutation für ${path}:\n${issues}`, path);
    }
    if (upgradedFrom !== MANIFEST_VERSION) notifyBeforeMigrationWrite(path, upgradedFrom);
    writeManifestAtomic(path, raw);
    return result.data;
}
