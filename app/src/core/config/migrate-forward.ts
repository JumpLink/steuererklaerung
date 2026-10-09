/**
 * Carrying a manifest across schema versions — forward, and refusing to go backward.
 *
 * `config migrate` assembles a v1 manifest out of the seven pre-v1 config files. That is a ONE-OFF
 * for this project's own history and says nothing about what happens the day the schema reaches v2:
 * `isManifest` accepts `version === MANIFEST_VERSION` and nothing else, so every installed copy
 * would refuse to read its own data with "noch nicht auf v1 migriert" — which for a v2 file is not
 * even true.
 *
 * Two directions, and only one of them is a migration:
 *
 *   **older than this program** — upgradeable. Apply the steps in order, keep a `.bak` of what was
 *   there, and carry on. The user should not have to do anything, least of all in a terminal.
 *
 *   **newer than this program** — NOT upgradeable, and the dangerous one. A v1 binary that writes
 *   its v1 shape over a v2 file destroys every field it does not know about, silently, and the file
 *   in question holds someone's tax data. So it refuses to read AND refuses to write, and says why.
 *
 * The upgrade list is empty today because v1 is current. It exists now rather than later on
 * purpose: the version after this one is written by someone who has this file to follow, instead of
 * inventing the path under time pressure with users' data already in the field.
 */

import { MANIFEST_VERSION } from './schema/manifest.ts';
import { ConfigError } from '../lib/errors.ts';

/** One step from `from` to `from + 1`, mutating the raw object in place. */
export interface ManifestUpgrade {
    from: number;
    /** German, for the log line — what changed, not how. */
    describe: string;
    apply: (raw: Record<string, unknown>) => void;
}

/**
 * The upgrade chain, ascending and contiguous.
 *
 * Contiguous matters: a gap means a manifest that can be read at one end and not the other, and the
 * gap is invisible until a user with exactly that version shows up. {@link assertUpgradesContiguous}
 * turns that into a test failure instead.
 */
export const MANIFEST_UPGRADES: readonly ManifestUpgrade[] = [];

/**
 * Called right before a migration REWRITES a manifest on disk — the v1 assembly in `config migrate`
 * and a forward upgrade persisted by `mutateManifest`. The `.bak-<ts>` copy beside the file only
 * covers the manifest itself; the installed hook (see `installMigrationBackup` in
 * `core/actions/backup.ts`) takes a full backup first. A hook rather than an import because backup
 * depends on this module, and because tests and pure callers must stay free of side effects.
 * A hook that throws aborts the migration: no backup, no rewrite.
 */
type BeforeMigrationWrite = (path: string, from: number | null) => void;
let beforeMigrationWrite: BeforeMigrationWrite | null = null;

/** Install (or with `null` remove) the before-migration hook. Returns the previous one. */
export function setBeforeMigrationWrite(fn: BeforeMigrationWrite | null): BeforeMigrationWrite | null {
    const previous = beforeMigrationWrite;
    beforeMigrationWrite = fn;
    return previous;
}

/** Run the before-migration hook, if any. */
export function notifyBeforeMigrationWrite(path: string, from: number | null): void {
    beforeMigrationWrite?.(path, from);
}

/** A manifest written by a NEWER version of this program. Not a migration — a refusal. */
export class ManifestTooNewError extends ConfigError {
    override readonly name = 'ManifestTooNewError';
    readonly fileVersion: number;

    constructor(fileVersion: number, path?: string) {
        super(
            `Diese Konfiguration ist Version ${fileVersion}; dieses Programm kennt Version ${MANIFEST_VERSION}. ` +
                'Sie wurde von einer neueren Fassung geschrieben und wird hier NICHT verändert — ' +
                'ein Schreibzugriff würde alles verwerfen, was diese Fassung noch nicht kennt. ' +
                'Bitte die neuere Fassung verwenden oder die Datei aus einer Sicherung zurückholen.',
            path,
        );
        this.fileVersion = fileVersion;
    }
}

/** Whether an unknown thrown value is the "file is newer than this program" condition. */
export function isManifestTooNew(err: unknown): err is ManifestTooNewError {
    return err instanceof ManifestTooNewError;
}

/** The version a raw manifest declares, or `null` when it declares none (the pre-v1 registry). */
export function manifestVersionOf(raw: unknown): number | null {
    const value = (raw as { version?: unknown } | null)?.version;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export interface ForwardMigration {
    /** The upgraded object (the same reference, mutated) — or the input when nothing applied. */
    raw: Record<string, unknown>;
    /** Version it started at. */
    from: number;
    /** Version it is at now — always {@link MANIFEST_VERSION} on success. */
    to: number;
    /** One line per applied step, for the caller to log or show. */
    applied: string[];
}

/**
 * Upgrade a raw manifest to {@link MANIFEST_VERSION}.
 *
 * @throws {ManifestTooNewError} when the file is newer than this program.
 * @throws {ConfigError} when it declares no version at all — that is the pre-v1 registry, which
 *   `config migrate` assembles, and guessing at it here would silently produce a different manifest
 *   than the documented path does.
 */
export function migrateManifestForward(raw: Record<string, unknown>, path?: string): ForwardMigration {
    const from = manifestVersionOf(raw);
    if (from === null) {
        throw new ConfigError(
            'Diese Datei trägt kein „version"-Feld — das ist das Format vor v1. ' +
                '„steuer config migrate" baut daraus ein v1-Manifest.',
            path,
        );
    }
    if (from > MANIFEST_VERSION) throw new ManifestTooNewError(from, path);

    const applied: string[] = [];
    let version = from;
    while (version < MANIFEST_VERSION) {
        const step = MANIFEST_UPGRADES.find((u) => u.from === version);
        if (!step) {
            // Only reachable if the chain has a hole; the contiguity check exists so this is a
            // failing test rather than a user's config that cannot be opened.
            throw new ConfigError(
                `Kein Migrationsschritt von Version ${version} auf ${version + 1}. ` +
                    'Das ist eine Lücke in der Upgrade-Kette dieses Programms, kein Fehler an deiner Datei.',
                path,
            );
        }
        step.apply(raw);
        version += 1;
        raw.version = version;
        applied.push(`v${step.from} → v${version}: ${step.describe}`);
    }
    return { raw, from, to: version, applied };
}

/** The chain must be ascending, contiguous and end at the current version. Called by the tests. */
export function assertUpgradesContiguous(upgrades: readonly ManifestUpgrade[] = MANIFEST_UPGRADES): void {
    if (upgrades.length === 0) return;
    const sorted = [...upgrades].sort((a, b) => a.from - b.from);
    for (let i = 0; i < sorted.length; i++) {
        const expected = sorted[0].from + i;
        if (sorted[i].from !== expected) {
            throw new Error(`Upgrade-Kette hat eine Lücke: erwartet from=${expected}, gefunden ${sorted[i].from}.`);
        }
    }
    const last = sorted[sorted.length - 1];
    if (last.from + 1 !== MANIFEST_VERSION) {
        throw new Error(
            `Der letzte Upgrade-Schritt führt auf v${last.from + 1}, aktuell ist v${MANIFEST_VERSION} — ` +
                'ein Schritt fehlt, oder MANIFEST_VERSION wurde ohne ihn erhöht.',
        );
    }
}
