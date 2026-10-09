/**
 * The manifest CONSTRUCTOR and DESTRUCTOR: create a config from nothing, add an entity, rename one,
 * remove one.
 *
 * Before this existed the whole config layer was update-only — `mutateManifest` throws on a missing
 * file and no writer could add or drop an entity — so the app could only ever be driven after a
 * human had hand-written `steuererklaerung.json`. These tests pin the guarantees that make the
 * first-run path safe to build on:
 *
 *   - `init` never overwrites an existing config (it is the user's only copy of their tax data),
 *   - a new id is checked for format AND for alias collisions (`gbr` ⇄ `artcode` name one entity),
 *   - every write preserves `//`-comments, unknown keys and the entity's inline sections,
 *   - an invalid change throws and leaves the file byte-identical,
 *   - the LAST entity cannot be removed, and a caller-supplied guard (the GoBD lock) can veto.
 *
 * Everything runs against a fresh temp dir — never the real gitignored manifest.
 */
import { afterEach, describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createManifestEntity,
    initManifest,
    loadManifest,
    type ManifestEntity,
    manifestExists,
    removeManifestEntity,
    renameManifestEntity,
} from '../../../src/core/config/index.ts';
import { ConfigError } from '../../../src/core/lib/errors.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

/**
 * A minimally VALID inline elster section. `period` is required by ElsterSectionSchema, and
 * mutateManifest re-validates the WHOLE manifest before writing — so a fixture with an incomplete
 * section makes every later write fail, which looks like a bug in the writer under test.
 */
const ELSTER_SECTION = {
    _note: 'keep me',
    entity_id: 'artcode',
    period: { year: 2025, quarter: 1 },
};

/** Run `fn`, assert it threw a ConfigError, and return it. */
function expectConfigError(fn: () => unknown): ConfigError {
    let caught: unknown;
    try {
        fn();
    } catch (err) {
        caught = err;
    }
    expect(caught instanceof ConfigError).toBe(true);
    return caught as ConfigError;
}

export default async () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    /** An empty temp dir plus the manifest path inside it that does NOT exist yet. */
    function emptyDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'bh-lifecycle-'));
        dirs.push(dir);
        return join(dir, 'steuererklaerung.json');
    }

    /** A manifest with a `//` comment, a `gbr` entity carrying an inline elster section, and `privat`. */
    function populated(): string {
        const { dir, path } = writeManifestFixture({
            '//': 'top-level comment',
            entities: [
                { id: 'gbr', name: 'Muster GbR', kind: 'gbr', elster: ELSTER_SECTION },
                { id: 'privat', name: 'Haushalt', kind: 'privat' },
            ],
        });
        dirs.push(dir);
        return path;
    }

    await describe('initManifest — the config constructor', async () => {
        await it('creates a schema-valid v1 manifest in an empty directory', async () => {
            const path = emptyDir();
            expect(manifestExists(path)).toBe(false);

            const manifest = initManifest(path, { id: 'gbr', name: 'Muster GbR', kind: 'gbr' });

            expect(manifest.version).toBe(1);
            expect(manifest.entities.length).toBe(1);
            expect(manifest.entities[0].id).toBe('gbr');
            expect(manifest.entities[0].name).toBe('Muster GbR');
            expect(manifest.entities[0].accounts.length).toBe(0);
            // The file on disk must reload cleanly — the whole point is that the app can now start.
            expect(loadManifest(path).entities[0].kind).toBe('gbr');
            expect(manifestExists(path)).toBe(true);
        });

        await it('defaults kind to einzelunternehmen and takes account globs', async () => {
            const path = emptyDir();
            const m = initManifest(path, {
                id: 'meinbetrieb',
                name: 'Mein Betrieb',
                accounts: ['camt:*', 'qonto:12*'],
            });
            expect(m.entities[0].kind).toBe('einzelunternehmen');
            expect(m.entities[0].accounts).toStrictEqual(['camt:*', 'qonto:12*']);
        });

        await it('REFUSES to overwrite an existing config, leaving it byte-identical', async () => {
            const path = populated();
            const before = readFileSync(path, 'utf-8');

            const err = expectConfigError(() => initManifest(path, { id: 'neu', name: 'Neu' }));
            expect(err.message.includes('bereits')).toBe(true);
            expect(readFileSync(path, 'utf-8')).toBe(before);
        });

        await it('rejects an id that is not slug-shaped, and writes nothing', async () => {
            for (const bad of ['Mit Leerzeichen', 'UPPER', '1zahl', 'mit/slash', '']) {
                const path = emptyDir();
                expectConfigError(() => initManifest(path, { id: bad, name: 'X' }));
                expect(existsSync(path)).toBe(false);
            }
        });
    });

    await describe('createManifestEntity', async () => {
        await it('appends an entity and keeps the existing ones untouched', async () => {
            const path = populated();
            const m = createManifestEntity(path, { id: 'jumplink', name: 'JumpLink', accounts: ['qonto:99*'] });

            expect(m.entities.map((e) => e.id)).toStrictEqual(['gbr', 'privat', 'jumplink']);
            const gbr = m.entities.find((e) => e.id === 'gbr') as ManifestEntity;
            expect(gbr.elster?.entity_id).toBe('artcode');
        });

        await it('preserves the `//` comment and the inline section `_note` across the write', async () => {
            const path = populated();
            createManifestEntity(path, { id: 'jumplink', name: 'JumpLink' });

            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            expect(raw['//']).toBe('top-level comment');
            const gbr = (raw.entities as Array<Record<string, unknown>>).find((e) => e.id === 'gbr') as Record<
                string,
                unknown
            >;
            expect((gbr.elster as Record<string, unknown>)._note).toBe('keep me');
        });

        await it('refuses a duplicate id', async () => {
            const path = populated();
            const err = expectConfigError(() => createManifestEntity(path, { id: 'privat', name: 'Zweiter Haushalt' }));
            expect(err.message.includes('bereits')).toBe(true);
            expect(loadManifest(path).entities.length).toBe(2);
        });

        await it('refuses an id that ALIASES an existing one (artcode ⇄ gbr name one entity)', async () => {
            const path = populated();
            // `gbr` is already listed; `artcode` is its ledger-side alias. Two entities that resolve
            // to each other would make `--entity` ambiguous and route transactions arbitrarily.
            const err = expectConfigError(() => createManifestEntity(path, { id: 'artcode', name: 'Art+Code' }));
            expect(err.message.includes('Alias')).toBe(true);
            expect(loadManifest(path).entities.length).toBe(2);
        });

        await it('fails loudly when there is no manifest to add to', async () => {
            const path = emptyDir();
            expectConfigError(() => createManifestEntity(path, { id: 'gbr', name: 'X' }));
        });
    });

    await describe('renameManifestEntity', async () => {
        await it('changes name and kind while keeping the inline sections', async () => {
            const path = populated();
            const m = renameManifestEntity(path, 'gbr', { name: 'Neuer Name', kind: 'einzelunternehmen' });

            const gbr = m.entities.find((e) => e.id === 'gbr') as ManifestEntity;
            expect(gbr.name).toBe('Neuer Name');
            expect(gbr.kind).toBe('einzelunternehmen');
            expect(gbr.elster?.entity_id).toBe('artcode');
        });

        await it('leaves omitted fields alone', async () => {
            const path = populated();
            const m = renameManifestEntity(path, 'privat', { name: 'Privathaushalt' });
            const privat = m.entities.find((e) => e.id === 'privat') as ManifestEntity;
            expect(privat.kind).toBe('privat');
        });

        await it('resolves the entity through its alias', async () => {
            const path = populated();
            // The manifest lists `gbr`; addressing it as `artcode` must find the same entity.
            const m = renameManifestEntity(path, 'artcode', { name: 'Über Alias umbenannt' });
            expect((m.entities.find((e) => e.id === 'gbr') as ManifestEntity).name).toBe('Über Alias umbenannt');
        });

        await it('renames the id and carries the elster entity_id along when it matched', async () => {
            const { dir, path } = writeManifestFixture({
                entities: [
                    { id: 'alt', name: 'Alt', elster: { ...ELSTER_SECTION, entity_id: 'alt' } },
                    { id: 'privat', kind: 'privat' },
                ],
            });
            dirs.push(dir);

            const m = renameManifestEntity(path, 'alt', { id: 'neu' });
            const e = m.entities.find((x) => x.id === 'neu') as ManifestEntity;
            expect(e).toBeTruthy();
            // The elster section referenced the entity by its own id — that reference follows.
            expect(e.elster?.entity_id).toBe('neu');
        });

        await it('refuses a new id that collides with another entity', async () => {
            const path = populated();
            const err = expectConfigError(() => renameManifestEntity(path, 'gbr', { id: 'privat' }));
            expect(err.message.includes('bereits')).toBe(true);
            expect(loadManifest(path).entities.map((e) => e.id)).toStrictEqual(['gbr', 'privat']);
        });

        await it('fails loudly on an unknown id and names the known ones', async () => {
            const path = populated();
            const err = expectConfigError(() => renameManifestEntity(path, 'gibtsnicht', { name: 'X' }));
            expect(err.message.includes('gbr')).toBe(true);
            expect(err.message.includes('privat')).toBe(true);
        });
    });

    await describe('removeManifestEntity — the destructor', async () => {
        await it('removes one entity and keeps the rest', async () => {
            const path = populated();
            const m = removeManifestEntity(path, 'privat');
            expect(m.entities.map((e) => e.id)).toStrictEqual(['gbr']);
            expect(loadManifest(path).entities.length).toBe(1);
        });

        await it('resolves the entity through its alias', async () => {
            const path = populated();
            const m = removeManifestEntity(path, 'artcode');
            expect(m.entities.map((e) => e.id)).toStrictEqual(['privat']);
        });

        await it('REFUSES to remove the last entity — the schema requires one', async () => {
            const { dir, path } = writeManifestFixture({ entities: [{ id: 'gbr', name: 'Nur diese' }] });
            dirs.push(dir);
            const before = readFileSync(path, 'utf-8');

            const err = expectConfigError(() => removeManifestEntity(path, 'gbr'));
            expect(err.message.includes('einzige')).toBe(true);
            expect(readFileSync(path, 'utf-8')).toBe(before);
        });

        await it('honours a guard veto (the GoBD lock) and writes nothing', async () => {
            const path = populated();
            const before = readFileSync(path, 'utf-8');
            const seen: string[] = [];

            let caught: unknown;
            try {
                removeManifestEntity(path, 'gbr', (entity) => {
                    seen.push(entity.id);
                    throw new Error('festgeschrieben');
                });
            } catch (err) {
                caught = err;
            }

            expect(caught instanceof Error).toBe(true);
            expect((caught as Error).message).toBe('festgeschrieben');
            expect(seen).toStrictEqual(['gbr']); // the guard is asked with the RESOLVED entity
            expect(readFileSync(path, 'utf-8')).toBe(before);
        });

        await it('passes the guard the entity, not just the id the caller typed', async () => {
            const path = populated();
            let received: ManifestEntity | undefined;
            removeManifestEntity(path, 'artcode', (e) => {
                received = e;
            });
            expect(received?.id).toBe('gbr');
            expect(received?.name).toBe('Muster GbR');
        });

        await it('fails loudly on an unknown id', async () => {
            const path = populated();
            expectConfigError(() => removeManifestEntity(path, 'gibtsnicht'));
        });
    });

    await describe('manifestExists', async () => {
        await it('is false before init and true after — the first-run question', async () => {
            const path = emptyDir();
            expect(manifestExists(path)).toBe(false);
            initManifest(path, { id: 'gbr', name: 'X' });
            expect(manifestExists(path)).toBe(true);
        });

        await it('does not confuse a directory-less path for a config', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-lifecycle-'));
            dirs.push(dir);
            writeFileSync(join(dir, 'anderes.json'), '{}');
            expect(manifestExists(join(dir, 'steuererklaerung.json'))).toBe(false);
        });
    });
};
