/**
 * Test helper: write a consolidated `steuererklaerung.json` v1 manifest into a fresh temp dir and (by
 * default) point `STEUER_WORKSPACE` at it. Replaces the per-file config fixtures the deleted
 * loaders used — a test now drives the whole config surface off ONE migrated manifest.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One manifest entity for a fixture (name/kind default sensibly). */
export interface FixtureEntity {
    id: string;
    name?: string;
    kind?: string;
    accounts?: string[];
    dms?: unknown;
    invoicing?: unknown;
    demo?: boolean;
    elster?: unknown;
    est?: unknown;
    recurring?: unknown[];
    [k: string]: unknown;
}

export interface FixtureManifest {
    entities: FixtureEntity[];
    paperless?: unknown;
    fints?: unknown;
    app?: unknown;
    [k: string]: unknown;
}

/** Fill an entity's name/kind/accounts defaults so a test can pass just `{ id, elster }`. */
function withDefaults(e: FixtureEntity): FixtureEntity {
    return {
        name: e.name ?? e.id,
        kind: e.kind ?? 'einzelunternehmen',
        accounts: e.accounts ?? [],
        ...e,
    };
}

/**
 * Write a v1 manifest ({@link FixtureManifest} + `version: 1`) into a fresh temp dir. Returns the
 * directory and the `steuererklaerung.json` path. The caller stubs `STEUER_WORKSPACE` (see
 * {@link stubManifestEnv}) when the code under test resolves the path from the environment.
 */
export function writeManifestFixture(manifest: FixtureManifest): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bh-manifest-'));
    const path = join(dir, 'steuererklaerung.json');
    const out = { version: 1, ...manifest, entities: manifest.entities.map(withDefaults) };
    writeFileSync(path, JSON.stringify(out, null, 2));
    return { dir, path };
}
