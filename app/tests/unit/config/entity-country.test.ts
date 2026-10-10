/**
 * The per-entity `country` + `taxModule` fields (ADR 0001). The load-bearing guarantee: a manifest
 * written before the fields existed resolves to Germany with the German tax module ON, and nothing
 * writes the fields unless the switch changes — switching back to the default removes them again,
 * so the file returns to its original bytes.
 *
 * Uses a fresh temp manifest under os.tmpdir() — never the real gitignored steuererklaerung.json.
 */
import { describe, it, expect, afterEach } from '@gjsify/unit';
import { readFileSync, rmSync } from 'node:fs';
import { ConfigError } from '../../../src/core/lib/errors.ts';
import {
    countryOf,
    loadManifest,
    mutateManifest,
    resolveEntity,
    resolveWorkspaceEntities,
    saveEntityCountry,
    taxModuleOf,
} from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

export default async () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function fixture(extra: Record<string, unknown> = {}): string {
        const f = writeManifestFixture({
            entities: [
                {
                    id: 'gbr',
                    name: 'Muster & Partner GbR',
                    kind: 'gbr',
                    elster: { tax_number: '11/222/33333', period: { year: 2025, quarter: 1 }, entity_id: 'gbr' },
                },
                { id: 'privat', kind: 'privat', ...extra },
            ],
        });
        dirs.push(f.dir);
        return f.path;
    }

    await describe('countryOf / taxModuleOf', async () => {
        await it('an entity without the fields is DE with the German module on', async () => {
            expect(countryOf({})).toBe('DE');
            expect(taxModuleOf({})).toBe('de');
        });

        await it('another country defaults to bookkeeping only', async () => {
            expect(taxModuleOf({ country: 'CH' })).toBe('none');
        });

        await it('an explicit switch wins over the country default', async () => {
            expect(taxModuleOf({ country: 'DE', taxModule: 'none' })).toBe('none');
            expect(taxModuleOf({ taxModule: 'none' })).toBe('none');
        });
    });

    await describe('old manifests', async () => {
        await it('resolve to DE / de and keep the fields absent after parsing', async () => {
            const path = fixture();
            const manifest = loadManifest(path);
            const gbr = manifest.entities.find((e) => e.id === 'gbr');
            expect(gbr?.country).toBe(undefined);
            expect(gbr?.taxModule).toBe(undefined);
            const resolved = resolveEntity(manifest, 'gbr');
            expect(resolved.country).toBe('DE');
            expect(resolved.taxModule).toBe('de');
            expect(resolveWorkspaceEntities([], manifest)[1].taxModule).toBe('de');
        });

        await it('an unrelated write does not add the fields', async () => {
            const path = fixture();
            mutateManifest(path, (raw) => {
                raw['//'] = 'note';
            });
            const text = readFileSync(path, 'utf-8');
            expect(text.includes('"country"')).toBe(false);
            expect(text.includes('"taxModule"')).toBe(false);
        });
    });

    await describe('saveEntityCountry', async () => {
        await it('round-trips an explicit switch through the manifest', async () => {
            const path = fixture();
            saveEntityCountry('gbr', { country: 'DE', taxModule: 'none' }, path);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as { entities: Array<Record<string, unknown>> };
            expect(raw.entities[0].taxModule).toBe('none');
            expect('country' in raw.entities[0]).toBe(false);
            const resolved = resolveEntity(loadManifest(path), 'gbr');
            expect(resolved.taxModule).toBe('none');
            expect(resolved.elster?.tax_number).toBe('11/222/33333');
        });

        await it('round-trips a foreign country', async () => {
            const path = fixture();
            saveEntityCountry('privat', { country: 'CH', taxModule: 'none' }, path);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as { entities: Array<Record<string, unknown>> };
            expect(raw.entities[1].country).toBe('CH');
            expect('taxModule' in raw.entities[1]).toBe(false);
            expect(resolveEntity(loadManifest(path), 'privat').taxModule).toBe('none');
        });

        await it('switching back on restores the original bytes', async () => {
            const path = fixture();
            // Normalise to the writer's own formatting first (the fixture omits the final newline).
            mutateManifest(path, () => {});
            const before = readFileSync(path, 'utf-8');
            saveEntityCountry('gbr', { country: 'DE', taxModule: 'none' }, path);
            expect(readFileSync(path, 'utf-8') === before).toBe(false);
            saveEntityCountry('gbr', { country: 'DE', taxModule: 'de' }, path);
            expect(readFileSync(path, 'utf-8')).toBe(before);
        });

        await it('rejects an invalid country code without touching the file', async () => {
            const path = fixture();
            const before = readFileSync(path, 'utf-8');
            let caught: unknown;
            try {
                saveEntityCountry('gbr', { country: 'germany', taxModule: 'none' }, path);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof ConfigError).toBe(true);
            expect(readFileSync(path, 'utf-8')).toBe(before);
        });
    });
};
