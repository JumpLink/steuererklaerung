/**
 * Regression net for the raw-preserving, entity-id-based config WRITERS in accessors.ts.
 *
 * The load-bearing guarantee: a save mutates the RAW manifest (not the Zod-normalised config), so
 * `//`-comment keys and any unknown/future keys survive a round-trip, an invalid mutation throws
 * ConfigError WITHOUT corrupting the file, and nested blocks are deep-merged. Each writer addresses the
 * entity by its **id**; the config lives inline under that entity (`entity.elster` / `entity.est`).
 *
 * Uses a fresh temp manifest under os.tmpdir() — never the real gitignored steuererklaerung.json.
 */
import { describe, it, expect, afterEach } from '@gjsify/unit';
import { readFileSync, rmSync } from 'node:fs';
import { ConfigError } from '../../../src/core/lib/errors.ts';
import {
    estJahr,
    loadManifest,
    mutateEstConfig,
    mutateElsterConfig,
    resolveEntity,
    saveElsterBetrieb,
    saveElsterFlags,
    saveElsterSubmitter,
    saveElsterUste,
    saveKeystorePath,
    updateEstPerson,
    upsertEstJahr,
    type EstJahr,
} from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const EST_SECTION = {
    _note: 'PRIVATE — hand-edited Lohnsteuerbescheinigung facts',
    entity_id: 'privat',
    veranlagung: 'einzel',
    person: { name: 'Max Mustermann', steuer_id: '12345678901', kinder: 1 },
    jahre: [{ jahr: 2024, bruttoarbeitslohn: 40000, vorsorge: { rv_arbeitnehmer: 3000, kv_basis: 2500 } }],
};

const ELSTER_SECTION = {
    _note: 'PRIVATE — GbR filing config',
    tax_number: '12/345/67890',
    period: { year: 2025, quarter: 1 },
    entity_id: 'artcode',
    test_mode: true,
    taxation_basis: 'ist',
    betrieb: { name: 'Muster GbR', strasse: 'Hauptstr. 1', plz: '12345', ort: 'Berlin', art: 'Software' },
    gesellschafter: [
        { id: 'p1', name: 'A B', steuer_id: '11111111111', quote: 0.5 },
        { id: 'p2', name: 'C D', steuer_id: '22222222222', quote: 0.5 },
    ],
};

/** Run `fn`, assert it threw a ConfigError, and return it for further inspection. */
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

    /** Fresh manifest with a `//` comment, a `privat` (est) entity and a `gbr` (elster) entity. */
    function fixture(): string {
        const { dir, path } = writeManifestFixture({
            '//': 'top-level comment',
            entities: [
                { id: 'privat', kind: 'privat', est: EST_SECTION },
                { id: 'gbr', kind: 'gbr', elster: ELSTER_SECTION },
            ],
        });
        dirs.push(dir);
        return path;
    }

    await describe('est-config writers (entity-id based)', async () => {
        await it('updateEstPerson changes only its field; the resolved value reflects it', async () => {
            const path = fixture();
            const updated = updateEstPerson('privat', { kinder: 3 }, path);
            expect(updated.person.kinder).toBe(3);
            expect(updated.person.name).toBe('Max Mustermann'); // sibling untouched
            expect(updated.jahre.length).toBe(1); // other blocks untouched
            expect(resolveEntity(loadManifest(path), 'privat').est?.person.kinder).toBe(3);
        });

        await it('preserves the manifest `//` comment + the est section `_note` across a write', async () => {
            const path = fixture();
            updateEstPerson('privat', { kinder: 2 }, path);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            expect(raw['//']).toBe('top-level comment');
            const priv = (raw.entities as Array<Record<string, unknown>>).find((e) => e.id === 'privat') as Record<
                string,
                unknown
            >;
            expect((priv.est as Record<string, unknown>)._note).toBe(
                'PRIVATE — hand-edited Lohnsteuerbescheinigung facts',
            );
        });

        await it('an invalid mutation throws ConfigError and does NOT corrupt the file', async () => {
            const path = fixture();
            expectConfigError(() => upsertEstJahr('privat', 2024, { bruttoarbeitslohn: -5 }, path));
            expect(estJahr(resolveEntity(loadManifest(path), 'privat').est!, 2024)?.bruttoarbeitslohn).toBe(40000);
        });

        await it('upsertEstJahr inserts a new year when absent', async () => {
            const path = fixture();
            const updated = upsertEstJahr('privat', 2025, { bruttoarbeitslohn: 55000 }, path);
            expect(updated.jahre.length).toBe(2);
            expect(estJahr(updated, 2025)?.bruttoarbeitslohn).toBe(55000);
            expect(estJahr(updated, 2024)?.bruttoarbeitslohn).toBe(40000); // existing kept
        });

        await it('upsertEstJahr deep-merges vorsorge, preserving untouched siblings', async () => {
            const path = fixture();
            const patch = { vorsorge: { kv_basis: 9999 } } as unknown as Partial<EstJahr>;
            const updated = upsertEstJahr('privat', 2024, patch, path);
            const vorsorge = estJahr(updated, 2024)?.vorsorge;
            expect(vorsorge?.kv_basis).toBe(9999); // patched
            expect(vorsorge?.rv_arbeitnehmer).toBe(3000); // sibling preserved
        });

        await it('mutateEstConfig throws ConfigError on an unknown entity', async () => {
            const path = fixture();
            expectConfigError(() => mutateEstConfig('nope', () => {}, path));
        });
    });

    await describe('elster-config writers (entity-id based)', async () => {
        await it('saveElsterFlags changes only the provided flag; the resolved value reflects it', async () => {
            const path = fixture();
            const updated = saveElsterFlags('gbr', { test_mode: false }, path);
            expect(updated.test_mode).toBe(false);
            expect(updated.taxation_basis).toBe('ist'); // untouched sibling flag
            expect(resolveEntity(loadManifest(path), 'gbr').elster?.test_mode).toBe(false);
        });

        await it('saveElsterUste + saveElsterBetrieb persist their blocks', async () => {
            const path = fixture();
            expect(saveElsterUste('gbr', { prepaid_vat: 123.45 }, path).uste?.prepaid_vat).toBe(123.45);
            const betrieb = saveElsterBetrieb(
                'gbr',
                { name: 'Neu GmbH', strasse: 'Neuweg 2', plz: '54321', ort: 'Hamburg', art: 'Beratung' },
                path,
            ).betrieb;
            expect(betrieb?.name).toBe('Neu GmbH');
            expect(betrieb?.ort).toBe('Hamburg');
        });

        await it('saveKeystorePath sets + clears the certificate path (never touches a PIN)', async () => {
            const path = fixture();
            const set = saveKeystorePath('gbr', '/home/user/elster.pfx', path);
            expect(set.keystore_path).toBe('/home/user/elster.pfx');
            expect(saveKeystorePath('gbr', '  ', path).keystore_path).toBe(undefined);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            const gbr = (raw.entities as Array<Record<string, unknown>>).find((e) => e.id === 'gbr') as Record<
                string,
                unknown
            >;
            expect('keystore_path' in (gbr.elster as Record<string, unknown>)).toBe(false);
        });

        await it('saveElsterSubmitter sets hersteller_id + datenlieferant, and clears each independently', async () => {
            const path = fixture();
            const set = saveElsterSubmitter('gbr', { herstellerId: '12345', datenlieferant: 'Max Mustermann' }, path);
            expect(set.hersteller_id).toBe('12345');
            expect(set.datenlieferant).toBe('Max Mustermann');
            const after = saveElsterSubmitter('gbr', { datenlieferant: '  ' }, path);
            expect(after.hersteller_id).toBe('12345'); // untouched
            expect(after.datenlieferant).toBe(undefined); // cleared
        });

        await it('preserves the manifest `//` comment + elster section `_note` across a write', async () => {
            const path = fixture();
            saveElsterFlags('gbr', { ust_dauerfristverlaengerung: true }, path);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            expect(raw['//']).toBe('top-level comment');
            const gbr = (raw.entities as Array<Record<string, unknown>>).find((e) => e.id === 'gbr') as Record<
                string,
                unknown
            >;
            expect((gbr.elster as Record<string, unknown>)._note).toBe('PRIVATE — GbR filing config');
        });

        await it('an invalid mutation (quotes not summing to 1) throws ConfigError and does NOT corrupt the file', async () => {
            const path = fixture();
            expectConfigError(() =>
                mutateElsterConfig(
                    'gbr',
                    (raw) => {
                        (raw.gesellschafter as Array<Record<string, unknown>>)[0].quote = 0.3; // sum 0.8 ≠ 1
                    },
                    path,
                ),
            );
            expect(resolveEntity(loadManifest(path), 'gbr').elster?.gesellschafter[0].quote).toBe(0.5);
        });
    });
};
