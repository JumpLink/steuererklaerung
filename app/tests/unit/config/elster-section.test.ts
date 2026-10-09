/**
 * Making a brand-new entity's tax fields writable at all.
 *
 * `initManifest` writes identity fields only, and every ELSTER writer in `accessors.ts`
 * (`saveElsterBetrieb`, `saveElsterUste`, `mutateElsterConfig`, …) throws when the entity has no
 * `elster` section. Correct for an entity migrated from an old config; a dead end for one the user
 * just created — which is every entity a first-run assistant produces.
 *
 * The result was that the single most load-bearing field of a business had no route from ANY
 * surface: a grep for `tax_number` across the whole desktop tree found nothing, and the CLI could
 * only reach it by hand-editing JSON.
 */
import { afterEach, describe, expect, it } from '@gjsify/unit';
import { readFileSync, rmSync } from 'node:fs';

import {
    ensureElsterSection,
    loadManifest,
    resolveEntity,
    saveElsterTaxNumber,
    saveElsterUste,
} from '../../../src/core/config/index.ts';
import { ConfigError } from '../../../src/core/lib/errors.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

export default async () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    /** A manifest whose entity has NO elster section — exactly what initManifest produces. */
    function freshEntity(): string {
        const { dir, path } = writeManifestFixture({
            '//': 'top-level comment',
            entities: [{ id: 'gbr', name: 'Muster GbR', kind: 'gbr' }],
        });
        dirs.push(dir);
        return path;
    }

    await describe('ensureElsterSection', async () => {
        await it('creates a schema-valid section where there was none', async () => {
            const path = freshEntity();
            expect(resolveEntity(loadManifest(path), 'gbr').elster).toBe(undefined);

            const elster = ensureElsterSection('gbr', { year: 2025 }, path);

            expect(elster.period.year).toBe(2025);
            // ElsterPeriodSchema refuses a period without a quarter or a month, so the seed carries
            // one — a section that fails its own schema would be worse than no section.
            expect(elster.period.quarter).toBe(1);
            expect(resolveEntity(loadManifest(path), 'gbr').elster).toBeTruthy();
        });

        await it('is idempotent and does not overwrite an existing section', async () => {
            const path = freshEntity();
            ensureElsterSection('gbr', { year: 2024 }, path);
            saveElsterTaxNumber('gbr', '12/345/67890', path);

            ensureElsterSection('gbr', { year: 2025 }, path);

            const after = resolveEntity(loadManifest(path), 'gbr').elster;
            expect(after?.tax_number).toBe('12/345/67890');
            expect(after?.period.year).toBe(2024); // the seeded year is NOT re-applied
        });

        await it('preserves the manifest comment', async () => {
            const path = freshEntity();
            ensureElsterSection('gbr', {}, path);
            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            expect(raw['//']).toBe('top-level comment');
        });

        await it('fails loudly on an unknown entity', async () => {
            const path = freshEntity();
            let caught: unknown;
            try {
                ensureElsterSection('gibtsnicht', {}, path);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof ConfigError).toBe(true);
        });

        await it('unblocks the other ELSTER writers, which used to throw here', async () => {
            const path = freshEntity();
            ensureElsterSection('gbr', {}, path);
            // Before this existed, saveElsterUste on a fresh entity threw
            // "Entität … hat keinen ELSTER-Abschnitt".
            const after = saveElsterUste('gbr', { prepaid_vat: 250 }, path);
            expect(after.uste?.prepaid_vat).toBe(250);
        });
    });

    await describe('saveElsterTaxNumber', async () => {
        await it('writes the Steuernummer on an entity that had no section', async () => {
            const path = freshEntity();
            const after = saveElsterTaxNumber('gbr', '12/345/67890', path);
            expect(after.tax_number).toBe('12/345/67890');
            expect(resolveEntity(loadManifest(path), 'gbr').elster?.tax_number).toBe('12/345/67890');
        });

        await it('trims surrounding whitespace', async () => {
            const path = freshEntity();
            expect(saveElsterTaxNumber('gbr', '  12/345/67890  ', path).tax_number).toBe('12/345/67890');
        });

        await it('leaves the rest of an existing section untouched', async () => {
            const path = freshEntity();
            ensureElsterSection('gbr', { year: 2023 }, path);
            saveElsterUste('gbr', { prepaid_vat: 99 }, path);

            saveElsterTaxNumber('gbr', '99/999/99999', path);

            const after = resolveEntity(loadManifest(path), 'gbr').elster;
            expect(after?.uste?.prepaid_vat).toBe(99);
            expect(after?.period.year).toBe(2023);
        });
    });
};
